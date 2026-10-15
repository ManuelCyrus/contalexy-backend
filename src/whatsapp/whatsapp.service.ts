import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { ApiException } from '../common/errors/api.exception';
import { env } from '../config/env';
import { EntitlementsService } from '../billing/entitlements.service';
import { FEATURES } from '../billing/plans.catalog';
import { AiService } from '../ai/ai.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../infra/redis.service';
import { todayIn } from '../common/utils/dates';
import { resolveLanguage } from '../common/i18n/messages';
import { formatMoney } from '../common/utils/money';
import { PendingService } from './pending.service';

/// Uma mensagem como a Meta a manda no webhook (só o que usamos).
interface WaMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; caption?: string; filename?: string };
}

const LINK_CODE_MINUTES = 15;
const REPLIES = {
  pt: {
    notLinked: 'Este número ainda não está ligado a uma conta Contalexy. Na app: Definições > WhatsApp > Ligar, e manda aqui o código.',
    linked: 'Número ligado à tua conta Contalexy. Manda uma despesa (ex.: "12,50 café") ou a foto de uma fatura.',
    premium: 'Registar por WhatsApp é do plano Premium+. Vê os planos na app, em Mais > Premium.',
    pending: 'Anotei {summary}. Confirma na app para ficar guardado.',
    notUnderstood: 'Não percebi. Escreve o valor e o que foi, por exemplo: "12,50 café" ou "recebi 100 freelance", ou manda a foto da fatura.',
    scanFailed: 'Não consegui ler a fatura. Tenta outra foto, mais nítida.',
    quota: 'A leitura de faturas por IA está no limite deste período. Podes escrever o valor à mão: "12,50 café".',
    dailyLimit: 'Chegaste ao limite de mensagens de hoje. Amanhã volta a funcionar; até lá regista na app.',
  },
  en: {
    notLinked: 'This number is not linked to a Contalexy account yet. In the app: Settings > WhatsApp > Link, and send the code here.',
    linked: 'Number linked to your Contalexy account. Send an expense (e.g. "12.50 coffee") or a photo of a receipt.',
    premium: 'Recording by WhatsApp is part of Premium+. See the plans in the app, under More > Premium.',
    pending: 'Noted {summary}. Confirm it in the app to save it.',
    notUnderstood: 'I did not understand. Write the amount and what it was, e.g. "12.50 coffee" or "received 100 freelance", or send a photo of the receipt.',
    scanFailed: 'Could not read the receipt. Try another, sharper photo.',
    quota: 'AI receipt reading reached its limit for this period. You can type the amount: "12.50 coffee".',
    dailyLimit: 'You reached today’s message limit. It works again tomorrow; until then, use the app.',
  },
};

/// WhatsApp (Cloud API da Meta): a pessoa liga o número na app, manda
/// mensagens ou fotos de faturas, e o servidor prepara um movimento para
/// confirmar. Só Premium+. Sem as credenciais fica tudo desligado.
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly ai: AiService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
    private readonly pending: PendingService,
  ) {}

  get configured() {
    const e = env();
    return !!(e.WHATSAPP_VERIFY_TOKEN && e.WHATSAPP_APP_SECRET && e.WHATSAPP_ACCESS_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID);
  }

  // ------------------------------------------------------------ App

  async status(userId: string) {
    const link = await this.prisma.whatsappLink.findUnique({ where: { userId } });
    const allowed = await this.entitlements.hasFeature(userId, FEATURES.whatsapp);
    const codeValid = !!link?.linkCode && !!link.linkCodeExpiresAt && link.linkCodeExpiresAt > new Date();
    return {
      configured: this.configured,
      allowed,
      businessNumber: env().WHATSAPP_BUSINESS_NUMBER || null,
      linked: !!link?.isActive && !!link.phone,
      phone: link?.isActive ? link.phone : null,
      linkedAt: link?.linkedAt ?? null,
      code: codeValid ? link!.linkCode : null,
      codeExpiresAt: codeValid ? link!.linkCodeExpiresAt : null,
      waLink: codeValid && env().WHATSAPP_BUSINESS_NUMBER ? `https://wa.me/${env().WHATSAPP_BUSINESS_NUMBER.replace(/[^\d]/g, '')}?text=${encodeURIComponent(link!.linkCode!)}` : null,
      pending: await this.pending.count(userId),
    };
  }

  /// Gera o código que a pessoa manda por WhatsApp (consentimento = pedir o código).
  async startLink(userId: string) {
    await this.entitlements.assertFeature(userId, FEATURES.whatsapp);
    if (!this.configured) throw ApiException.unavailable('WHATSAPP_NOT_CONFIGURED');
    const code = `CX-${Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('')}`;
    const expires = new Date(Date.now() + LINK_CODE_MINUTES * 60_000);
    await this.prisma.whatsappLink.upsert({
      where: { userId },
      create: { userId, linkCode: code, linkCodeExpiresAt: expires, consentAt: new Date() },
      update: { linkCode: code, linkCodeExpiresAt: expires, consentAt: new Date() },
    });
    return this.status(userId);
  }

  async unlink(userId: string) {
    await this.prisma.whatsappLink.updateMany({ where: { userId }, data: { phone: null, isActive: false, linkCode: null, linkCodeExpiresAt: null, linkedAt: null } });
    return this.status(userId);
  }

  // ------------------------------------------------------------ Webhook

  /// A Meta confirma o endereço com um GET (hub.challenge).
  verify(mode?: string, token?: string, challenge?: string): string {
    if (mode !== 'subscribe' || !token || !env().WHATSAPP_VERIFY_TOKEN || token !== env().WHATSAPP_VERIFY_TOKEN) throw ApiException.forbidden();
    return challenge ?? '';
  }

  /// Assinatura de cada webhook (HMAC SHA-256 do corpo cru com o App Secret).
  verifySignature(rawBody: Buffer | undefined, header: string | undefined) {
    const secret = env().WHATSAPP_APP_SECRET;
    if (!secret) throw ApiException.unavailable('WHATSAPP_NOT_CONFIGURED');
    if (!rawBody || !header?.startsWith('sha256=')) throw ApiException.unauthorized();
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const given = header.slice(7);
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))) throw ApiException.unauthorized();
  }

  async handleWebhook(body: unknown) {
    const entries = ((body as { entry?: { changes?: { value?: { messages?: WaMessage[] } }[] }[] })?.entry ?? []) as { changes?: { value?: { messages?: WaMessage[] } }[] }[];
    let handled = 0;
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          // Cada mensagem trata-se uma só vez (a Meta repete os webhooks).
          if (!(await this.redis.lock(`wa:msg:${message.id}`, 24 * 3600))) continue;
          try {
            await this.handleMessage(message);
            handled += 1;
          } catch (err) {
            this.logger.warn(`Mensagem ${message.id}: ${(err as Error).message}`);
          }
        }
      }
    }
    return { ok: true, handled };
  }

  private t(lang: string, key: keyof (typeof REPLIES)['pt'], params: Record<string, string> = {}) {
    const dict = lang === 'pt' ? REPLIES.pt : REPLIES.en;
    return Object.entries(params).reduce((text, [k, v]) => text.replace(`{${k}}`, v), dict[key]);
  }

  private async handleMessage(message: WaMessage) {
    const phone = message.from.replace(/[^\d]/g, '');
    const text = message.text?.body?.trim() ?? message.image?.caption?.trim() ?? '';

    // Limite por número e por dia: protege contra spam e contra custos de mensagens.
    // Ao passar o limite responde-se uma vez e as seguintes são ignoradas até amanhã.
    const day = await this.redis.hit(`wa:day:${phone}`, 24 * 3600);
    const max = env().WHATSAPP_DAILY_LIMIT;
    if (day.count > max) {
      if (day.count === max + 1) await this.reply(phone, this.t('pt', 'dailyLimit') + '\n\n' + this.t('en', 'dailyLimit'));
      return;
    }

    const link = await this.prisma.whatsappLink.findFirst({ where: { phone, isActive: true }, include: { user: { select: { id: true, language: true, currency: true, timezone: true } } } });

    // Sem ligação: só um código de ligação válido faz alguma coisa.
    if (!link) {
      const code = text.toUpperCase().match(/CX-[A-Z0-9]{6}/)?.[0];
      const pending = code ? await this.prisma.whatsappLink.findFirst({ where: { linkCode: code, linkCodeExpiresAt: { gt: new Date() } }, include: { user: { select: { language: true } } } }) : null;
      if (!pending) {
        // A quem não tem conta ligada explica-se uma vez por dia, não a cada mensagem.
        if (await this.redis.lock(`wa:notlinked:${phone}`, 24 * 3600)) await this.reply(phone, this.t('pt', 'notLinked') + '\n\n' + this.t('en', 'notLinked'));
        return;
      }
      // Este número deixa de estar ligado a outra conta, se estava.
      await this.prisma.whatsappLink.updateMany({ where: { phone, NOT: { id: pending.id } }, data: { phone: null, isActive: false } });
      await this.prisma.whatsappLink.update({ where: { id: pending.id }, data: { phone, isActive: true, linkedAt: new Date(), linkCode: null, linkCodeExpiresAt: null } });
      await this.reply(phone, this.t(resolveLanguage(pending.user.language), 'linked'));
      return;
    }

    const user = link.user;
    const lang = resolveLanguage(user.language);
    if (!(await this.entitlements.hasFeature(user.id, FEATURES.whatsapp))) {
      await this.reply(phone, this.t(lang, 'premium'));
      return;
    }

    if (message.type === 'image' || message.type === 'document') {
      const media = message.image ?? message.document;
      if (!media) return;
      let buffer: Buffer;
      try {
        buffer = await this.downloadMedia(media.id);
      } catch {
        await this.reply(phone, this.t(lang, 'scanFailed'));
        return;
      }
      try {
        const scan = await this.ai.scanReceipt(user.id, { buffer, mimetype: media.mime_type ?? 'image/jpeg', size: buffer.length, originalname: 'whatsapp' }, `wa:${message.id}`);
        if (!scan.recognized) {
          await this.reply(phone, this.t(lang, 'scanFailed'));
          return;
        }
        const r = scan as unknown as { attachmentId: string; merchant: string | null; date: string | null; total: number; currency: string | null; categoryKey: string | null; items: unknown };
        const created = await this.pending.create(user.id, { source: 'WHATSAPP', sourceId: `wa:${message.id}`, type: 'EXPENSE', amount: r.total, currency: r.currency ?? user.currency, date: r.date ?? todayIn(user.timezone), description: r.merchant, merchant: r.merchant, categoryKey: r.categoryKey, attachmentId: r.attachmentId, items: r.items, rawText: text || null });
        if (created.created) await this.announce(user.id, lang, phone, r.total, r.currency ?? user.currency, r.merchant ?? '');
      } catch (err) {
        const code = (err as { code?: string }).code;
        await this.reply(phone, this.t(lang, code === 'AI_QUOTA_REACHED' || code === 'AI_RATE_LIMIT' ? 'quota' : 'scanFailed'));
      }
      return;
    }

    if (!text) return;
    const parsed = parseMoneyMessage(text);
    if (!parsed) {
      await this.reply(phone, this.t(lang, 'notUnderstood'));
      return;
    }
    const created = await this.pending.create(user.id, { source: 'WHATSAPP', sourceId: `wa:${message.id}`, type: parsed.type, amount: parsed.amount, currency: user.currency, date: todayIn(user.timezone), description: parsed.description, rawText: text });
    if (created.created) await this.announce(user.id, lang, phone, parsed.amount, user.currency, parsed.description ?? '');
  }

  private async announce(userId: string, lang: string, phone: string, amount: number, currency: string, what: string) {
    const summary = `${formatMoney(amount, currency, lang)}${what ? ` (${what})` : ''}`;
    await this.notifications.notify(userId, 'whatsapp_pending', { amount, currency, description: what }, () => ({ summary }));
    await this.reply(phone, this.t(lang, 'pending', { summary }));
  }

  private get graph() {
    return `https://graph.facebook.com/${env().WHATSAPP_API_VERSION}`;
  }

  async reply(phone: string, text: string) {
    if (!this.configured) return;
    try {
      await fetch(`${this.graph}/${env().WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env().WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text } }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.warn(`Resposta WhatsApp falhou: ${(err as Error).message}`);
    }
  }

  private async downloadMedia(mediaId: string): Promise<Buffer> {
    const headers = { Authorization: `Bearer ${env().WHATSAPP_ACCESS_TOKEN}` };
    const meta = await fetch(`${this.graph}/${mediaId}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!meta.ok) throw new Error(`media ${meta.status}`);
    const { url } = (await meta.json()) as { url: string };
    const file = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!file.ok) throw new Error(`download ${file.status}`);
    return Buffer.from(await file.arrayBuffer());
  }
}

/// "12,50 café", "café 12.50", "recebi 100 freelance", "+100 salário" → valor, tipo e descrição.
export function parseMoneyMessage(text: string): { amount: number; type: 'INCOME' | 'EXPENSE'; description: string | null } | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  const m = clean.match(/(^|\s)([+-]?)(\d{1,7}(?:[.,]\d{1,2})?)\s*(€|eur|r\$|brl|\$|usd|kz)?(?=\s|$)/i);
  if (!m) return null;
  const amount = Math.round(Number(m[3].replace(',', '.')) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const rest = (clean.slice(0, m.index) + ' ' + clean.slice((m.index ?? 0) + m[0].length)).replace(/\s+/g, ' ').trim();
  const income = m[2] === '+' || /^(recebi|receita|entrou|ganhei|received|income|got|einnahme|reçu)\b/i.test(rest);
  const description = rest.replace(/^(recebi|receita|entrou|ganhei|received|income|got|einnahme|reçu|gastei|paguei|spent|paid|despesa)\b/i, '').trim();
  return { amount, type: income ? 'INCOME' : 'EXPENSE', description: description ? description.slice(0, 140) : null };
}
