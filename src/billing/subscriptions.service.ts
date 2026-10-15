import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { accessWhere, ACCESS_STATUSES, baseProductId, EntitlementsService } from './entitlements.service';
import { LocksService } from './locks.service';
import { FREE_PLAN } from './plans.catalog';
import { ExchangeService } from '../exchange/exchange.service';
import { ApiException } from '../common/errors/api.exception';
import { formatDate, round2 } from '../common/utils/money';
import { env, isTrue } from '../config/env';
import { CreditsService } from './credits.service';
import { BillingPlatform, Prisma, Subscription, SubscriptionStatus } from '../generated/prisma/client';

/// Evento de webhook do RevenueCat (só os campos que usamos).
export interface RevenueCatEvent {
  id: string;
  type: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  product_id?: string;
  /// O número da compra na loja (ex.: GPA.1234-…)
  transaction_id?: string | null;
  original_transaction_id?: string | null;
  entitlement_ids?: string[] | null;
  entitlement_id?: string | null;
  period_type?: string;
  purchased_at_ms?: number | null;
  expiration_at_ms?: number | null;
  /// Fim do período de tolerância da loja quando a cobrança falha
  grace_period_expiration_at_ms?: number | null;
  environment?: string;
  store?: string;
  cancel_reason?: string | null;
  transferred_from?: string[];
  transferred_to?: string[];
  /// Valor em USD (0 nos períodos grátis; negativo nos reembolsos)
  price?: number | null;
  /// O mesmo valor na moeda em que a pessoa pagou
  price_in_purchased_currency?: number | null;
  currency?: string | null;
  tax_percentage?: number | null;
  commission_percentage?: number | null;
  event_timestamp_ms?: number | null;
}

/// De onde vem o plano: loja (pago), código promocional, oferta ou testes.
export type SubscriptionSource = 'STORE' | 'PROMO' | 'GRANT' | 'DEV';

export function sourceOf(provider: string): SubscriptionSource {
  switch (provider) {
    case 'REVENUECAT':
      return 'STORE';
    case 'PROMO':
      return 'PROMO';
    case 'GRANT':
      return 'GRANT';
    default:
      return 'DEV';
  }
}

export interface RevenueFromEvent {
  type: 'INITIAL_PURCHASE' | 'RENEWAL' | 'NON_RENEWING_PURCHASE' | 'REFUND';
  /// Na moeda em que a pessoa pagou (negativo nos reembolsos; 0 = valor desconhecido)
  amount: number;
  amountUsd: number;
  currency: string;
}

/// O dinheiro que um evento do RevenueCat representa (null = nenhum: período
/// grátis, mudança de estado, oferta…).
export function revenueFromEvent(event: RevenueCatEvent): RevenueFromEvent | null {
  const usd = Number(event.price ?? 0) || 0;
  const local = Number(event.price_in_purchased_currency ?? 0) || 0;
  const currency = (event.currency ?? 'USD').toUpperCase().slice(0, 3);
  if (event.type === 'INITIAL_PURCHASE' || event.type === 'RENEWAL' || event.type === 'NON_RENEWING_PURCHASE') {
    if (usd <= 0 && local <= 0) return null;
    return { type: event.type, amount: round2(local > 0 ? local : usd), amountUsd: round2(Math.max(usd, 0)), currency: local > 0 ? currency : 'USD' };
  }
  // Reembolso: chega como cancelamento pelo apoio ao cliente da loja.
  if (event.type === 'CANCELLATION' && (event.cancel_reason ?? '').toUpperCase() === 'CUSTOMER_SUPPORT') {
    return { type: 'REFUND', amount: -round2(Math.abs(local !== 0 ? local : usd)), amountUsd: -round2(Math.abs(usd)), currency: local !== 0 ? currency : 'USD' };
  }
  return null;
}

export function platformForStore(store?: string | null): BillingPlatform {
  switch ((store ?? '').toUpperCase()) {
    case 'APP_STORE':
    case 'MAC_APP_STORE':
      return 'IOS';
    case 'PLAY_STORE':
      return 'ANDROID';
    case 'STRIPE':
    case 'RC_BILLING':
    case 'PADDLE':
      return 'WEB';
    default:
      return 'OTHER';
  }
}

/// A loja devolveu o dinheiro? (chega como cancelamento "pelo apoio ao cliente")
export function isRefund(event: RevenueCatEvent): boolean {
  return event.type === 'CANCELLATION' && (event.cancel_reason ?? '').toUpperCase() === 'CUSTOMER_SUPPORT';
}

const DAY_MS = 86_400_000;

/// Compras de uma só vez, por ordem: cada uma soma os seus dias a partir do
/// dia da compra ou, se ainda havia tempo pago, a partir do fim dele.
/// Devolve quando começa e quando acaba o plano (`end` null = para sempre).
export function stackPasses(purchases: Array<{ at: Date; days: number | null }>): { start: Date; end: Date | null } | null {
  const sorted = [...purchases].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (!sorted.length) return null;
  let start = sorted[0].at;
  let end: Date | null = sorted[0].at;
  for (const p of sorted) {
    if (end === null) break; // já é para sempre
    if (p.at.getTime() > end.getTime()) start = p.at; // houve um intervalo sem plano: recomeça
    const from: Date = p.at.getTime() > end.getTime() ? p.at : end;
    end = p.days === null ? null : new Date(from.getTime() + p.days * DAY_MS);
  }
  return { start, end };
}

/// Estado de uma assinatura a partir de um evento do RevenueCat.
export function statusForEvent(event: RevenueCatEvent, now = Date.now()): SubscriptionStatus | null {
  const expired = event.expiration_at_ms != null && event.expiration_at_ms <= now;
  switch (event.type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
    case 'SUBSCRIPTION_EXTENDED':
    case 'TEMPORARY_ENTITLEMENT_GRANT':
    case 'REFUND_REVERSED':
    case 'NON_RENEWING_PURCHASE':
      if (expired) return 'EXPIRED';
      return (event.period_type ?? '').toUpperCase() === 'TRIAL' ? 'TRIAL' : 'ACTIVE';
    case 'CANCELLATION':
      // Reembolso: acaba já. Cancelar só pára a renovação — o que está pago mantém-se até ao fim.
      if (isRefund(event)) return 'EXPIRED';
      return expired ? 'EXPIRED' : 'CANCELLED';
    case 'SUBSCRIPTION_PAUSED':
      return expired ? 'EXPIRED' : 'CANCELLED';
    case 'BILLING_ISSUE': {
      // A cobrança falhou: o acesso dura enquanto a loja der tolerância.
      const until = event.grace_period_expiration_at_ms ?? event.expiration_at_ms;
      return until != null && until <= now ? 'EXPIRED' : 'BILLING_ISSUE';
    }
    case 'EXPIRATION':
      return 'EXPIRED';
    default:
      return null;
  }
}

/// O nome do plano como aparece nos avisos.
export function planName(code: string): string {
  return code === 'PREMIUM_PLUS' ? 'Premium+' : code === 'PREMIUM' ? 'Premium' : code;
}

/// O que está mal configurado nos pagamentos de um servidor de produção
/// (avisos escritos ao arrancar — fora de produção não diz nada).
export function billingConfigWarnings(e: { NODE_ENV: string; REVENUECAT_WEBHOOK_AUTH?: string; REVENUECAT_SECRET_API_KEY?: string; BILLING_DEV_GRANTS: string }): string[] {
  if (e.NODE_ENV !== 'production') return [];
  const out: string[] = [];
  const auth = (e.REVENUECAT_WEBHOOK_AUTH ?? '').replace(/^Bearer\s+/i, '');
  if (!auth) out.push('REVENUECAT_WEBHOOK_AUTH está vazio: os avisos de pagamento são recusados e ninguém recebe o plano que comprou.');
  else if (auth.length < 24) out.push('REVENUECAT_WEBHOOK_AUTH é curto: usa um valor aleatório com 32 ou mais caracteres.');
  if (!e.REVENUECAT_SECRET_API_KEY) out.push('REVENUECAT_SECRET_API_KEY está vazio: as compras só são confirmadas pelo webhook, sem a segunda verificação junto da loja.');
  if (isTrue(e.BILLING_DEV_GRANTS)) out.push('BILLING_DEV_GRANTS=true não tem efeito em produção (ninguém pode dar um plano a si próprio).');
  return out;
}

@Injectable()
export class SubscriptionsService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
    private readonly exchange: ExchangeService,
    private readonly locks: LocksService,
    private readonly credits: CreditsService,
  ) {}

  onModuleInit() {
    for (const warning of billingConfigWarnings(env())) this.logger.warn(warning);
  }

  /// A assinatura que dá o plano atual: a do plano em vigor, de preferência
  /// a paga na loja e, entre iguais, a que dura mais.
  static pickCurrent<T extends Pick<Subscription, 'plan' | 'provider' | 'expirationDate'>>(subs: T[], plan: string): T | null {
    const far = 8.64e15;
    return (
      [...subs]
        .filter((s) => s.plan === plan)
        .sort((a, b) => Number(b.provider === 'REVENUECAT') - Number(a.provider === 'REVENUECAT') || (b.expirationDate?.getTime() ?? far) - (a.expirationDate?.getTime() ?? far))[0] ?? null
    );
  }

  /// O que a app mostra em Definições › Premium.
  async summary(userId: string) {
    const ent = await this.entitlements.forUser(userId);
    const valid = await this.prisma.subscription.findMany({ where: accessWhere(userId) });
    const current = SubscriptionsService.pickCurrent(valid, ent.plan);
    // Sem plano em vigor, mostra-se o que acabou há menos tempo (é dele que vêm "expirou" e "reembolsado").
    const last = current ?? (await this.prisma.subscription.findFirst({ where: { userId }, orderBy: [{ expirationDate: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }] }));
    const fromStore = !!current && sourceOf(current.provider) === 'STORE';
    return {
      plan: ent.plan,
      /// FREE | PREMIUM | PREMIUM_PLUS | TRIAL | EXPIRED | CANCELLED
      state: this.stateFor(ent.plan, last),
      status: last?.status ?? null,
      platform: last?.platform ?? null,
      provider: last?.provider ?? null,
      /// STORE (pago na loja) | PROMO (código promocional) | GRANT (oferta) | DEV
      source: current ? sourceOf(current.provider) : null,
      startDate: last?.startDate ?? null,
      expirationDate: last?.expirationDate ?? null,
      autoRenew: last?.autoRenew ?? false,
      isSandbox: last?.isSandbox ?? false,
      productId: last?.productId ?? null,
      /// SUBSCRIPTION (renova sozinha até se cancelar) | ONE_TIME (paga uma vez; acaba na data de fim)
      kind: last?.kind ?? null,
      /// Há uma subscrição da loja que ainda vai renovar: pode cancelar-se lá
      /// (o que já está pago continua até à data de fim).
      canCancel: fromStore && current?.kind !== 'ONE_TIME' && !!current?.autoRenew,
      /// A loja não conseguiu cobrar: é preciso atualizar o pagamento na loja
      billingIssue: current?.status === 'BILLING_ISSUE',
      /// O último plano acabou porque a loja devolveu o dinheiro
      refunded: !current && !!last?.refundedAt,
      /// O que ficou fechado por a pessoa já não ter o plano com que o criou
      locked: await this.locks.counts(userId),
      features: ent.features,
      limits: ent.limits,
      /// Áreas fechadas pelo código promocional (a app não as mostra)
      blockedAreas: ent.blockedAreas,
    };
  }

  private stateFor(plan: string, sub: { status: SubscriptionStatus; plan: string } | null): string {
    if (plan === FREE_PLAN) {
      if (sub?.status === 'EXPIRED') return 'EXPIRED';
      return 'FREE';
    }
    if (sub?.status === 'TRIAL') return 'TRIAL';
    if (sub?.status === 'CANCELLED') return 'CANCELLED';
    return plan;
  }

  // ------------------------------------------------------------------
  // RevenueCat
  // ------------------------------------------------------------------

  verifyWebhookAuth(header: string | undefined) {
    const expected = env().REVENUECAT_WEBHOOK_AUTH;
    if (!expected) throw ApiException.unavailable('BILLING_NOT_CONFIGURED');
    // Comparação em tempo constante (sobre o hash, para os tamanhos baterem).
    const digest = (value: string) => createHash('sha256').update(value.replace(/^Bearer\s+/i, '')).digest();
    if (!timingSafeEqual(digest(header ?? ''), digest(expected))) throw ApiException.unauthorized();
  }

  async handleRevenueCatWebhook(body: { event?: RevenueCatEvent }) {
    const received = body?.event;
    if (!received?.id || !received.type) throw ApiException.badRequest('INVALID_REQUEST');
    // Na Google Play o produto pode vir como "produto:plano-base": conta o produto.
    const event: RevenueCatEvent = { ...received, product_id: baseProductId(received.product_id) ?? undefined };

    // Os webhooks podem chegar repetidos — cada evento só conta uma vez.
    try {
      await this.prisma.billingEvent.create({
        data: { provider: 'REVENUECAT', eventId: event.id, type: event.type, userId: event.app_user_id ?? null, payload: body as object },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { duplicate: true };
      throw err;
    }
    if (event.type === 'TEST') return { ok: true };

    if (event.type === 'TRANSFER') {
      for (const from of event.transferred_from ?? []) {
        if (await this.userExists(from)) {
          await this.prisma.subscription.updateMany({ where: { userId: from, provider: 'REVENUECAT' }, data: { status: 'EXPIRED', autoRenew: false } });
        }
      }
      for (const to of event.transferred_to ?? []) {
        if (await this.userExists(to)) await this.reconcile(to).catch(() => undefined);
      }
      return { ok: true };
    }

    const userId = await this.resolveUserId(event);
    const entitlementIds = event.entitlement_ids ?? (event.entitlement_id ? [event.entitlement_id] : []);
    // Uma compra de uma só vez só conta se o produto estiver configurado como
    // tal (com os dias que dá): um produto desconhecido nunca dá acesso.
    const oneTime = await this.entitlements.oneTimeProduct(event.product_id);
    const plan = event.type === 'NON_RENEWING_PURCHASE' ? (oneTime?.plan ?? null) : await this.entitlements.planForStoreProduct(entitlementIds, event.product_id);
    const isSandbox = (event.environment ?? '').toUpperCase() === 'SANDBOX';
    // O dinheiro conta sempre, mesmo que a conta já tenha sido apagada.
    const paid = await this.recordRevenue(event, userId, plan?.code ?? null, isSandbox);

    if (!userId) {
      this.logger.warn(`Evento ${event.type} para um utilizador desconhecido (${event.app_user_id}).`);
      return { ok: true, ignored: 'unknown_user' };
    }
    if (!plan) {
      // Um pacote de créditos de IA (compra única): junta os créditos, uma só vez por evento.
      const credits = this.credits.creditsForProduct(event.product_id);
      if (event.type === 'NON_RENEWING_PURCHASE' && credits && (!isSandbox || isTrue(env().BILLING_ACCEPT_SANDBOX))) {
        await this.credits.add(userId, credits, 'PURCHASE', { productId: event.product_id, eventId: `rc:${event.id}` });
        return { ok: true, credits };
      }
      if (event.type === 'REFUND' && credits) {
        // Devolveram o dinheiro de um pacote: tiram-se os créditos que ainda houver.
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { aiCredits: true } });
        const remove = Math.min(credits, user?.aiCredits ?? 0);
        if (remove > 0) {
          await this.prisma.$transaction([
            this.prisma.aiCreditEvent.create({ data: { userId, delta: -remove, reason: 'REFUND', productId: event.product_id, eventId: `rc:${event.id}` } }),
            this.prisma.user.update({ where: { id: userId }, data: { aiCredits: { decrement: remove } } }),
          ]).catch(() => undefined);
        }
        return { ok: true, refundedCredits: remove };
      }
      if (event.type === 'NON_RENEWING_PURCHASE') this.logger.warn(`Compra única de um produto que não está no catálogo (${event.product_id}): não dá acesso.`);
      return { ok: true, ignored: 'unknown_product' };
    }

    const before = await this.planBefore(userId);
    const eventAt = new Date(event.event_timestamp_ms ?? Date.now());
    const platform = platformForStore(event.store);
    // Uma compra a sério cujo valor a loja não comunicou continua a ser "paga".
    const paidWithoutPrice =
      ['INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE'].includes(event.type) &&
      event.price == null &&
      event.price_in_purchased_currency == null &&
      (event.period_type ?? '').toUpperCase() !== 'TRIAL' &&
      (event.store ?? '').toUpperCase() !== 'PROMOTIONAL';

    if (oneTime) {
      // Produto de compra única: ou é a compra, ou é a loja a devolver o dinheiro.
      if (event.type === 'NON_RENEWING_PURCHASE') {
        await this.applyOneTimePurchase({
          userId,
          plan: plan.code,
          productId: event.product_id as string,
          days: oneTime.days,
          purchasedAt: event.purchased_at_ms ? new Date(event.purchased_at_ms) : eventAt,
          platform,
          isSandbox,
          isPaid: paid || paidWithoutPrice,
        });
      } else if (isRefund(event)) {
        await this.refundOneTime(userId, plan.code, oneTime.days, isSandbox);
      } else {
        return { ok: true, ignored: 'event_type' };
      }
    } else {
      const status = statusForEvent(event);
      if (!status) return { ok: true, ignored: 'event_type' };
      // Os eventos podem chegar fora de ordem: um mais antigo do que o último
      // já aplicado não pode repor um estado que entretanto mudou.
      const rowId = this.rowId(userId, event.product_id ?? plan.code, isSandbox);
      const existing = await this.prisma.subscription.findUnique({
        where: { provider_providerSubscriptionId: { provider: 'REVENUECAT', providerSubscriptionId: rowId } },
        select: { lastEventAt: true },
      });
      if (existing?.lastEventAt && eventAt.getTime() < existing.lastEventAt.getTime()) return { ok: true, ignored: 'stale' };
      const refunded = isRefund(event);
      // Cobrança falhada: o acesso vai até ao fim da tolerância que a loja der.
      const endMs = event.type === 'BILLING_ISSUE' ? (event.grace_period_expiration_at_ms ?? event.expiration_at_ms) : event.expiration_at_ms;
      await this.upsert({
        userId,
        plan: plan.code,
        status,
        platform,
        productId: event.product_id ?? null,
        startDate: event.purchased_at_ms ? new Date(event.purchased_at_ms) : new Date(),
        expirationDate: refunded ? new Date() : endMs ? new Date(endMs) : null,
        autoRenew: !['CANCELLATION', 'EXPIRATION', 'SUBSCRIPTION_PAUSED'].includes(event.type),
        isSandbox,
        isPaid: paid || paidWithoutPrice,
        lastEventAt: eventAt,
        refundedAt: refunded ? new Date() : null,
      });
      // A loja não conseguiu cobrar: a pessoa tem uns dias para atualizar o pagamento.
      if (status === 'BILLING_ISSUE') await this.notifications.notify(userId, 'subscription_billing_issue', { plan: plan.code }, () => ({ plan: planName(plan.code) }));
    }

    // A última palavra é da loja: com a chave secreta configurada, confirma-se
    // o estado diretamente no RevenueCat (de servidor para servidor).
    await this.reconcile(userId).catch((err) => this.logger.warn(`Não foi possível confirmar ${userId} no RevenueCat: ${(err as Error).message}`));
    await this.announceChange(userId, before);
    return { ok: true };
  }

  private rowId(userId: string, product: string, isSandbox: boolean) {
    return `${userId}:${product}${isSandbox ? ':sandbox' : ''}`;
  }

  /// Uma linha por pessoa + plano para as compras de uma só vez.
  private passId(userId: string, plan: string, isSandbox: boolean) {
    return `${userId}:pass:${plan}${isSandbox ? ':sandbox' : ''}`;
  }

  /// Uma compra de uma só vez soma dias ao plano: a partir do dia da compra
  /// ou, se ainda havia tempo pago, a partir do fim dele. Nunca renova.
  private async applyOneTimePurchase(input: {
    userId: string;
    plan: string;
    productId: string;
    days: number | null;
    purchasedAt: Date;
    platform: BillingPlatform;
    isSandbox: boolean;
    isPaid: boolean;
  }) {
    const providerSubscriptionId = this.passId(input.userId, input.plan, input.isSandbox);
    const where = { provider_providerSubscriptionId: { provider: 'REVENUECAT', providerSubscriptionId } };
    const existing = await this.prisma.subscription.findUnique({ where });
    // A app pediu a confirmação junto da loja antes de este aviso chegar: a
    // compra já está contada (a confirmação é posterior à compra) — somá-la
    // outra vez dava dias a mais.
    if (existing?.verifiedAt && existing.verifiedAt.getTime() > input.purchasedAt.getTime()) {
      if (input.isPaid && !existing.isPaid) await this.prisma.subscription.update({ where, data: { isPaid: true } });
      return;
    }
    const running =
      !!existing && (ACCESS_STATUSES as readonly string[]).includes(existing.status) && (existing.expirationDate === null || existing.expirationDate.getTime() > input.purchasedAt.getTime());
    const window = stackPasses([
      ...(running && existing ? [{ at: existing.startDate, days: existing.expirationDate ? (existing.expirationDate.getTime() - existing.startDate.getTime()) / DAY_MS : null }] : []),
      { at: input.purchasedAt, days: input.days },
    ]);
    const expirationDate = window?.end ?? null;
    const active = expirationDate === null || expirationDate.getTime() > Date.now();
    const data = {
      plan: input.plan,
      status: (active ? 'ACTIVE' : 'EXPIRED') as SubscriptionStatus,
      platform: input.platform,
      productId: input.productId,
      kind: 'ONE_TIME',
      startDate: running && existing ? existing.startDate : input.purchasedAt,
      expirationDate,
      autoRenew: false,
      isSandbox: input.isSandbox,
      refundedAt: null,
      lastEventAt: new Date(),
    };
    await this.prisma.subscription.upsert({
      where,
      create: { ...data, userId: input.userId, provider: 'REVENUECAT', providerSubscriptionId, isPaid: input.isPaid },
      update: { ...data, ...(input.isPaid ? { isPaid: true } : {}) },
    });
  }

  /// A loja devolveu o dinheiro de uma compra única: saem os dias que ela
  /// tinha dado (se não sobrar nada, o plano acaba já).
  private async refundOneTime(userId: string, plan: string, days: number | null, isSandbox: boolean) {
    const where = { provider_providerSubscriptionId: { provider: 'REVENUECAT', providerSubscriptionId: this.passId(userId, plan, isSandbox) } };
    const row = await this.prisma.subscription.findUnique({ where });
    if (!row) return;
    const now = new Date();
    const reduced = days !== null && row.expirationDate ? new Date(row.expirationDate.getTime() - days * DAY_MS) : now;
    const ended = reduced.getTime() <= now.getTime();
    await this.prisma.subscription.update({
      where,
      data: { expirationDate: ended ? now : reduced, status: ended ? 'EXPIRED' : row.status, refundedAt: now, lastEventAt: now },
    });
  }

  /// Guarda o pagamento (ou reembolso) de um evento. Devolve true se foi um
  /// pagamento a sério — é isso que marca a assinatura como "paga".
  private async recordRevenue(event: RevenueCatEvent, userId: string | null, plan: string | null, isSandbox: boolean): Promise<boolean> {
    const revenue = revenueFromEvent(event);
    if (!revenue) return false;
    let { amount, amountUsd, currency } = revenue;
    if (revenue.type === 'REFUND' && amount === 0) {
      // A loja não disse quanto devolveu: devolve-se o último pagamento desse produto.
      const last = await this.prisma.revenueEvent.findFirst({
        where: { userId, productId: event.product_id ?? null, amount: { gt: 0 } },
        orderBy: { occurredAt: 'desc' },
      });
      if (!last) return false;
      amount = -Number(last.amount);
      amountUsd = -Number(last.amountUsd);
      currency = last.currency;
    }
    if (amountUsd === 0 && amount !== 0) amountUsd = this.exchange.convert(amount, currency, 'USD') ?? 0;
    const rate = (value: number | null | undefined) => (typeof value === 'number' && value >= 0 && value <= 1 ? new Prisma.Decimal(value).toDecimalPlaces(4) : null);
    try {
      await this.prisma.revenueEvent.create({
        data: {
          userId,
          provider: 'REVENUECAT',
          eventId: event.id,
          type: revenue.type,
          plan,
          productId: event.product_id ?? null,
          platform: platformForStore(event.store),
          amount: new Prisma.Decimal(amount).toDecimalPlaces(2),
          currency,
          amountUsd: new Prisma.Decimal(amountUsd).toDecimalPlaces(2),
          commissionRate: rate(event.commission_percentage),
          taxRate: rate(event.tax_percentage),
          isSandbox,
          occurredAt: new Date(event.event_timestamp_ms ?? event.purchased_at_ms ?? Date.now()),
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      return revenue.type !== 'REFUND';
    }
    // O que a pessoa paga pela app fica logo registado como despesa dela
    // (categoria "Subscrições"), para não ter de a meter à mão.
    if (userId && !isSandbox && revenue.type !== 'REFUND' && amount > 0) {
      await this.recordAppExpense(userId, amount, currency, plan, new Date(event.purchased_at_ms ?? event.event_timestamp_ms ?? Date.now()), event.id).catch((err) => this.logger.warn(`Não deu para registar a despesa da subscrição de ${userId}: ${(err as Error).message}`));
    }
    return revenue.type !== 'REFUND';
  }

  /// Cria a despesa do pagamento da app na conta da pessoa com a moeda do
  /// pagamento (ou na primeira conta), com a categoria "Subscrições".
  private async recordAppExpense(userId: string, amount: number, currency: string, plan: string | null, at: Date, eventId: string) {
    const marker = `rc:${eventId}`;
    if (await this.prisma.transaction.findFirst({ where: { userId, note: marker }, select: { id: true } })) return;
    const accounts = await this.prisma.account.findMany({ where: { userId, archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true, currency: true } });
    const account = accounts.find((a) => a.currency === currency) ?? accounts[0];
    if (!account) return;
    const category = await this.prisma.category.findFirst({ where: { userId, key: 'subscriptions' }, select: { id: true } });
    const value = account.currency === currency ? amount : (this.exchange.convert(amount, currency, account.currency) ?? amount);
    await this.prisma.transaction.create({
      data: {
        userId,
        type: 'EXPENSE',
        amount: new Prisma.Decimal(value).toDecimalPlaces(2),
        currency: account.currency,
        accountId: account.id,
        categoryId: category?.id ?? null,
        date: at,
        description: `Contalexy ${plan ? planName(plan) : ''}`.trim(),
        merchant: 'Contalexy',
        note: marker,
      },
    });
  }

  private async userExists(id: string) {
    return !!(await this.prisma.user.findUnique({ where: { id }, select: { id: true } }));
  }

  private async resolveUserId(event: RevenueCatEvent): Promise<string | null> {
    const candidates = [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? [])].filter((x): x is string => !!x && !x.startsWith('$RCAnonymousID'));
    for (const id of candidates) {
      if (/^[0-9a-f-]{36}$/i.test(id) && (await this.userExists(id))) return id;
    }
    return null;
  }

  private async upsert(input: {
    userId: string;
    plan: string;
    status: SubscriptionStatus;
    platform: BillingPlatform;
    productId: string | null;
    startDate: Date;
    expirationDate: Date | null;
    autoRenew: boolean;
    isSandbox: boolean;
    /// true quando este evento trouxe um pagamento (nunca volta a false)
    isPaid?: boolean;
    /// O momento do evento que trouxe este estado
    lastEventAt?: Date;
    refundedAt?: Date | null;
    /// Quando a loja confirmou este estado (só a confirmação de servidor para servidor o diz)
    verifiedAt?: Date;
  }) {
    // Uma linha por pessoa + produto (renovações atualizam a mesma). As
    // compras de teste (sandbox) ficam numa linha à parte, para nunca
    // "despromoverem" uma assinatura paga a sério.
    const providerSubscriptionId = this.rowId(input.userId, input.productId ?? input.plan, input.isSandbox);
    const { isPaid, lastEventAt, refundedAt, verifiedAt, ...rest } = input;
    await this.prisma.subscription.upsert({
      where: { provider_providerSubscriptionId: { provider: 'REVENUECAT', providerSubscriptionId } },
      create: { ...rest, kind: 'SUBSCRIPTION', isPaid: !!isPaid, provider: 'REVENUECAT', providerSubscriptionId, lastEventAt: lastEventAt ?? null, refundedAt: refundedAt ?? null, verifiedAt: verifiedAt ?? null },
      update: {
        plan: input.plan,
        status: input.status,
        platform: input.platform,
        expirationDate: input.expirationDate,
        autoRenew: input.autoRenew,
        isSandbox: input.isSandbox,
        ...(isPaid ? { isPaid: true } : {}),
        ...(lastEventAt ? { lastEventAt } : {}),
        ...(refundedAt !== undefined ? { refundedAt } : {}),
        ...(verifiedAt ? { verifiedAt } : {}),
      },
    });
    return providerSubscriptionId;
  }

  /// O plano que a pessoa tinha "até agora": o que está em vigor ou, se já
  /// passou da data mas ainda ninguém lhe disse que acabou, esse.
  private async planBefore(userId: string): Promise<string> {
    const current = await this.entitlements.planCodeFor(userId);
    if (current !== FREE_PLAN) return current;
    const lapsed = await this.prisma.subscription.findFirst({
      where: { userId, endNotifiedAt: null, status: { in: [...ACCESS_STATUSES] }, expirationDate: { lt: new Date() } },
      orderBy: { expirationDate: 'desc' },
      select: { plan: true },
    });
    return lapsed?.plan ?? FREE_PLAN;
  }

  /// Diz à pessoa o que mudou no plano: ativou (ou subiu) → boas-vindas;
  /// ficou sem ele → que acabou e o que ficou fechado.
  private async announceChange(userId: string, before: string) {
    const after = await this.entitlements.planCodeFor(userId);
    if (after === before) return;
    if (after !== FREE_PLAN) {
      await this.notifications.notify(userId, 'subscription_active', { plan: after }, () => ({ plan: planName(after) }));
    } else {
      await this.announceEnded(userId, before);
    }
  }

  /// "O teu Premium terminou" — com o que ficou fechado, se ficou alguma
  /// coisa. Um aviso por plano que acaba.
  private async announceEnded(userId: string, plan: string) {
    const now = new Date();
    await this.prisma.subscription.updateMany({
      where: { userId, endNotifiedAt: null, OR: [{ status: 'EXPIRED' }, { expirationDate: { lt: now } }] },
      data: { endNotifiedAt: now },
    });
    const locked = await this.locks.counts(userId);
    await this.notifications.notify(userId, locked.total > 0 ? 'subscription_ended_locked' : 'subscription_ended', { plan, locked: locked.total }, () => ({ plan: planName(plan), count: locked.total }));
  }

  /// Depois de uma compra (ou de cancelar na loja), a app pede para confirmar
  /// logo — o webhook pode demorar uns segundos. A app nunca diz "paguei": o
  /// servidor vai buscar o estado ao RevenueCat.
  async syncFromRevenueCat(userId: string) {
    const before = await this.planBefore(userId);
    const store = await this.reconcile(userId).catch((err) => {
      this.logger.warn(`Não foi possível sincronizar ${userId} com o RevenueCat: ${(err as Error).message}`);
      return null;
    });
    await this.announceChange(userId, before);
    return { ...(await this.summary(userId)), managementUrl: store?.managementUrl ?? null };
  }

  /// Põe as assinaturas da pessoa iguais ao que o RevenueCat diz (pedido de
  /// servidor para servidor, com a chave secreta). É a fonte de verdade: o
  /// que a loja já não reconhece (reembolsado, passado para outra conta)
  /// deixa de dar acesso. Sem chave configurada, não faz nada (null).
  private async reconcile(userId: string): Promise<{ managementUrl: string | null } | null> {
    const key = env().REVENUECAT_SECRET_API_KEY;
    if (!key) return null;
    const response = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`RevenueCat respondeu ${response.status}`);
    const json = (await response.json()) as {
      subscriber?: {
        subscriptions?: Record<string, {
          expires_date?: string | null;
          grace_period_expires_date?: string | null;
          purchase_date?: string | null;
          period_type?: string | null;
          store?: string | null;
          is_sandbox?: boolean;
          unsubscribe_detected_at?: string | null;
          billing_issues_detected_at?: string | null;
          refunded_at?: string | null;
        }>;
        non_subscriptions?: Record<string, Array<{ purchase_date?: string | null; store?: string | null; is_sandbox?: boolean; store_transaction_id?: string | null }>>;
        entitlements?: Record<string, { product_identifier?: string }>;
        management_url?: string | null;
      };
    };
    const subscriber = json.subscriber;
    if (!subscriber) throw new Error('resposta sem "subscriber"');
    const now = Date.now();
    const seen: string[] = [];

    // --- Subscrições (renovam sozinhas)
    const entitlements = subscriber.entitlements ?? {};
    for (const [rawProductId, sub] of Object.entries(subscriber.subscriptions ?? {})) {
      const productId = baseProductId(rawProductId) ?? rawProductId;
      const entitlementIds = Object.entries(entitlements).filter(([, e]) => baseProductId(e.product_identifier) === productId).map(([id]) => id);
      const plan = await this.entitlements.planForStoreProduct(entitlementIds, productId);
      if (!plan) continue;
      const expires = sub.expires_date ? new Date(sub.expires_date) : null;
      const grace = sub.billing_issues_detected_at && sub.grace_period_expires_date ? new Date(sub.grace_period_expires_date) : null;
      const until = grace && (!expires || grace.getTime() > expires.getTime()) ? grace : expires;
      const refunded = !!sub.refunded_at;
      const active = !refunded && (!until || until.getTime() > now);
      const status: SubscriptionStatus = !active
        ? 'EXPIRED'
        : sub.billing_issues_detected_at
          ? 'BILLING_ISSUE'
          : sub.unsubscribe_detected_at
            ? 'CANCELLED'
            : (sub.period_type ?? '').toLowerCase() === 'trial'
              ? 'TRIAL'
              : 'ACTIVE';
      seen.push(
        await this.upsert({
          userId,
          plan: plan.code,
          status,
          platform: platformForStore(sub.store),
          productId,
          startDate: sub.purchase_date ? new Date(sub.purchase_date) : new Date(),
          expirationDate: refunded ? new Date(sub.refunded_at as string) : until,
          autoRenew: active && !sub.unsubscribe_detected_at && !sub.billing_issues_detected_at,
          isSandbox: !!sub.is_sandbox,
          // Compra a sério numa loja (as ofertas feitas no RevenueCat vêm como PROMOTIONAL).
          isPaid: active && (sub.period_type ?? '').toLowerCase() !== 'trial' && (sub.store ?? '').toUpperCase() !== 'PROMOTIONAL',
          refundedAt: refunded ? new Date(sub.refunded_at as string) : null,
          verifiedAt: new Date(now),
        }),
      );
    }

    // --- Compras de uma só vez: somam-se por plano (e por loja de teste / a sério)
    const passes = new Map<string, { plan: string; isSandbox: boolean; productId: string; store: string | null; purchases: Array<{ at: Date; days: number | null }> }>();
    // As compras únicas que a loja devolveu não voltam a contar, mesmo que ainda venham na lista.
    const refundedTx = await this.refundedTransactions(userId);
    for (const [rawProductId, purchases] of Object.entries(subscriber.non_subscriptions ?? {})) {
      const productId = baseProductId(rawProductId) ?? rawProductId;
      const oneTime = await this.entitlements.oneTimeProduct(productId);
      if (!oneTime) continue;
      for (const purchase of purchases ?? []) {
        if (!purchase.purchase_date) continue;
        if (purchase.store_transaction_id && refundedTx.has(purchase.store_transaction_id)) continue;
        const isSandbox = !!purchase.is_sandbox;
        const id = this.passId(userId, oneTime.plan.code, isSandbox);
        const entry = passes.get(id) ?? { plan: oneTime.plan.code, isSandbox, productId, store: purchase.store ?? null, purchases: [] };
        entry.purchases.push({ at: new Date(purchase.purchase_date), days: oneTime.days });
        entry.productId = productId;
        passes.set(id, entry);
      }
    }
    for (const [providerSubscriptionId, pass] of passes) {
      const window = stackPasses(pass.purchases);
      if (!window) continue;
      const active = window.end === null || window.end.getTime() > now;
      const data = {
        plan: pass.plan,
        status: (active ? 'ACTIVE' : 'EXPIRED') as SubscriptionStatus,
        platform: platformForStore(pass.store),
        productId: pass.productId,
        kind: 'ONE_TIME',
        startDate: window.start,
        expirationDate: window.end,
        autoRenew: false,
        isSandbox: pass.isSandbox,
        refundedAt: null,
        verifiedAt: new Date(now),
      };
      const isPaid = (pass.store ?? '').toUpperCase() !== 'PROMOTIONAL';
      await this.prisma.subscription.upsert({
        where: { provider_providerSubscriptionId: { provider: 'REVENUECAT', providerSubscriptionId } },
        create: { ...data, userId, provider: 'REVENUECAT', providerSubscriptionId, isPaid },
        update: { ...data, ...(isPaid ? { isPaid: true } : {}) },
      });
      seen.push(providerSubscriptionId);
    }

    // --- O que a loja já não reconhece deixa de dar acesso.
    const gone = { userId, provider: 'REVENUECAT', status: { in: [...ACCESS_STATUSES] }, providerSubscriptionId: { notIn: seen } };
    const endedAt = new Date();
    // (se a data de fim ainda estava no futuro, passa a ser agora — acabou mesmo)
    await this.prisma.subscription.updateMany({
      where: { ...gone, OR: [{ expirationDate: null }, { expirationDate: { gt: endedAt } }] },
      data: { status: 'EXPIRED', autoRenew: false, expirationDate: endedAt },
    });
    await this.prisma.subscription.updateMany({ where: gone, data: { status: 'EXPIRED', autoRenew: false } });
    return { managementUrl: subscriber.management_url ?? null };
  }

  /// Os números das compras que a loja devolveu a esta pessoa (dos avisos guardados).
  private async refundedTransactions(userId: string): Promise<Set<string>> {
    const events = await this.prisma.billingEvent.findMany({
      where: { provider: 'REVENUECAT', userId, type: 'CANCELLATION' },
      select: { payload: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const out = new Set<string>();
    for (const row of events) {
      const event = (row.payload as { event?: RevenueCatEvent } | null)?.event;
      if (!event || !isRefund(event)) continue;
      for (const id of [event.transaction_id, event.original_transaction_id]) if (id) out.add(id);
    }
    return out;
  }

  /// Só para testar o Premium sem lojas (BILLING_DEV_GRANTS=true).
  async countryOf(userId: string): Promise<string> {
    return (await this.prisma.user.findUnique({ where: { id: userId }, select: { country: true } }))?.country ?? 'PT';
  }

  async devGrant(userId: string, plan: string, days: number) {
    // Só em testes: nunca num servidor de produção, mesmo que a opção fique ligada por engano.
    if (env().NODE_ENV === 'production' || !isTrue(env().BILLING_DEV_GRANTS)) throw ApiException.forbidden();
    const definition = await this.entitlements.planDefinition(plan);
    if (definition.code !== plan) throw ApiException.badRequest('INVALID_REQUEST');
    const before = await this.planBefore(userId);
    const providerSubscriptionId = `${userId}:dev`;
    const expirationDate = plan === FREE_PLAN ? new Date() : new Date(Date.now() + days * 86_400_000);
    await this.prisma.subscription.upsert({
      where: { provider_providerSubscriptionId: { provider: 'MANUAL', providerSubscriptionId } },
      create: {
        userId, plan, status: plan === FREE_PLAN ? 'EXPIRED' : 'ACTIVE', platform: 'OTHER', provider: 'MANUAL', providerSubscriptionId,
        startDate: new Date(), expirationDate, autoRenew: false, isSandbox: true,
      },
      update: { plan, status: plan === FREE_PLAN ? 'EXPIRED' : 'ACTIVE', expirationDate },
    });
    await this.announceChange(userId, before);
    return this.summary(userId);
  }

  // ------------------------------------------------------------------
  // Ofertas (administração) — nunca contam como receita
  // ------------------------------------------------------------------

  /// Dá um plano a alguém sem pagamento (ex.: ao criador da app, a testers).
  /// `days` null = sem data de fim.
  async grant(adminId: string, userId: string, plan: string, days: number | null, note?: string | null) {
    if (!(await this.userExists(userId))) throw ApiException.notFound('USER_NOT_FOUND');
    const definition = await this.entitlements.planDefinition(plan);
    if (definition.code !== plan || plan === FREE_PLAN) throw ApiException.badRequest('INVALID_REQUEST');
    const before = await this.planBefore(userId);
    const data = {
      plan,
      status: 'ACTIVE' as SubscriptionStatus,
      startDate: new Date(),
      expirationDate: days ? new Date(Date.now() + days * 86_400_000) : null,
      autoRenew: false,
      isPaid: false,
      grantedById: adminId,
      note: note ?? null,
    };
    await this.prisma.subscription.upsert({
      where: { provider_providerSubscriptionId: { provider: 'GRANT', providerSubscriptionId: `${userId}:grant` } },
      create: { ...data, userId, platform: 'OTHER', provider: 'GRANT', providerSubscriptionId: `${userId}:grant` },
      update: data,
    });
    await this.announceChange(userId, before);
    return this.summary(userId);
  }

  /// Tira o plano que não foi pago (oferta, código promocional, compras de
  /// teste). As assinaturas pagas a sério na loja não são tocadas.
  async revokeFree(userId: string) {
    const before = await this.planBefore(userId);
    const result = await this.prisma.subscription.updateMany({
      where: { userId, status: { in: [...ACCESS_STATUSES] }, OR: [{ provider: { not: 'REVENUECAT' } }, { isSandbox: true }] },
      data: { status: 'EXPIRED', expirationDate: new Date(), autoRenew: false },
    });
    await this.announceChange(userId, before);
    return { revoked: result.count, subscription: await this.summary(userId) };
  }

  /// Reconciliação diária: as assinaturas pagas na loja que não são confirmadas
  /// há mais de um dia (webhook perdido, por exemplo) são lidas de novo ao
  /// RevenueCat, de servidor para servidor. Nunca desliga ninguém por falha
  /// de rede: só aplica o que a loja responder.
  @Cron('25 5 * * *')
  async reconcileJob() {
    if (!isTrue(env().JOBS_ENABLED) || !env().REVENUECAT_SECRET_API_KEY) return;
    const stale = await this.prisma.subscription.findMany({
      where: { provider: 'REVENUECAT', status: { in: [...ACCESS_STATUSES] }, OR: [{ verifiedAt: null }, { verifiedAt: { lt: new Date(Date.now() - 86_400_000) } }] },
      select: { userId: true },
      distinct: ['userId'],
      take: 500,
    });
    let done = 0;
    for (const { userId } of stale) {
      try {
        await this.reconcile(userId);
        done += 1;
      } catch (err) {
        this.logger.warn(`Reconciliação de ${userId} falhou: ${(err as Error).message}`);
      }
    }
    if (done) this.logger.log(`${done} conta(s) confirmadas junto da loja.`);
  }

  /// De hora a hora: o que passou da data de fim fica EXPIRED (e a pessoa é
  /// avisada), e quem tem um plano a acabar sem renovação é lembrado antes.
  @Cron('7 * * * *')
  async expireJob() {
    if (!isTrue(env().JOBS_ENABLED)) return;
    const expired = await this.expireLapsed();
    const reminded = await this.remindEnding();
    if (expired || reminded) this.logger.log(`${expired} assinatura(s) expiradas; ${reminded} aviso(s) de plano a acabar.`);
  }

  /// O que passou da data de fim fica EXPIRED; quem ficou sem plano recebe o
  /// aviso (com o que ficou fechado). Devolve quantas assinaturas expiraram.
  async expireLapsed(): Promise<number> {
    const lapsed = await this.prisma.subscription.findMany({
      where: { status: { in: [...ACCESS_STATUSES] }, expirationDate: { lt: new Date() } },
      select: { id: true, userId: true, plan: true, endNotifiedAt: true },
      orderBy: { expirationDate: 'desc' },
      take: 2000,
    });
    if (!lapsed.length) return 0;
    await this.prisma.subscription.updateMany({ where: { id: { in: lapsed.map((s) => s.id) } }, data: { status: 'EXPIRED', autoRenew: false } });
    const plans = new Map<string, string>();
    for (const sub of lapsed) if (!sub.endNotifiedAt && !plans.has(sub.userId)) plans.set(sub.userId, sub.plan);
    for (const [userId, plan] of plans) {
      if ((await this.entitlements.planCodeFor(userId)) === FREE_PLAN) {
        await this.announceEnded(userId, plan);
      } else {
        // Continua com outro plano em vigor: não perdeu nada, não há nada a dizer.
        await this.prisma.subscription.updateMany({ where: { userId, endNotifiedAt: null, status: 'EXPIRED' }, data: { endNotifiedAt: new Date() } });
      }
    }
    return lapsed.length;
  }

  /// Dias antes do fim em que se lembra quem tem um plano que não renova.
  static readonly ENDING_NOTICE_DAYS = 3;

  /// Planos que acabam dentro de dias e não renovam (subscrição cancelada,
  /// compra única, código promocional, oferta): um lembrete, uma vez, para a
  /// pessoa poder prolongar antes de as coisas dela ficarem fechadas.
  async remindEnding(): Promise<number> {
    const now = new Date();
    const until = new Date(now.getTime() + SubscriptionsService.ENDING_NOTICE_DAYS * DAY_MS);
    const ending = await this.prisma.subscription.findMany({
      where: { status: { in: [...ACCESS_STATUSES] }, autoRenew: false, endingNotifiedAt: null, expirationDate: { gt: now, lte: until } },
      select: { id: true, userId: true, plan: true, startDate: true, expirationDate: true },
      take: 2000,
    });
    let sent = 0;
    for (const sub of ending) {
      const end = sub.expirationDate as Date;
      await this.prisma.subscription.update({ where: { id: sub.id }, data: { endingNotifiedAt: now } });
      // Planos muito curtos (uns dias de teste) não precisam de lembrete.
      if (end.getTime() - sub.startDate.getTime() < 7 * DAY_MS) continue;
      // Há outra assinatura que dura mais (ou que renova): o plano não acaba nessa data.
      const longer = await this.prisma.subscription.findFirst({
        where: { ...accessWhere(sub.userId, now), id: { not: sub.id }, AND: [{ OR: [{ expirationDate: null }, { expirationDate: { gt: end } }, { autoRenew: true }] }] },
        select: { id: true },
      });
      if (longer) continue;
      const date = end.toISOString().slice(0, 10);
      await this.notifications.notify(sub.userId, 'subscription_ending', { plan: sub.plan, date }, (ctx) => ({ plan: planName(sub.plan), date: formatDate(date, ctx.lang, ctx.country) }));
      sent++;
    }
    return sent;
  }
}
