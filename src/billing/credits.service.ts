import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ApiException } from '../common/errors/api.exception';
import { env } from '../config/env';
import { NotificationsService } from '../notifications/notifications.service';

/// Os pacotes de créditos à venda (AI_CREDIT_PRODUCTS: "produto:créditos,…").
export function creditProducts(raw = env().AI_CREDIT_PRODUCTS): { productId: string; credits: number }[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [productId, credits] = p.split(':');
      return { productId: productId.trim(), credits: Number(credits) };
    })
    .filter((p) => p.productId && Number.isInteger(p.credits) && p.credits > 0);
}

/// Créditos de IA: compram-se na loja (compra única) ou são oferecidos, e
/// gastam-se um a um quando a quota do período já acabou.
@Injectable()
export class CreditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async balance(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { aiCredits: true } });
    return user?.aiCredits ?? 0;
  }

  /// Junta créditos. `eventId` garante que a mesma compra nunca conta duas vezes.
  async add(userId: string, credits: number, reason: 'PURCHASE' | 'GRANT' | 'PROMO' | 'REFUND', opts: { productId?: string | null; eventId?: string | null; note?: string | null } = {}) {
    if (!Number.isInteger(credits) || credits <= 0) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'credits', message: 'invalid' }]);
    try {
      await this.prisma.$transaction([
        this.prisma.aiCreditEvent.create({ data: { userId, delta: credits, reason, productId: opts.productId ?? null, eventId: opts.eventId ?? null, note: opts.note ?? null } }),
        this.prisma.user.update({ where: { id: userId }, data: { aiCredits: { increment: credits } } }),
      ]);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { duplicate: true, credits: await this.balance(userId) };
      throw err;
    }
    if (reason !== 'REFUND') {
      await this.notifications.notify(userId, 'ai_credits_added', { credits }, () => ({ credits })).catch(() => undefined);
    }
    return { duplicate: false, credits: await this.balance(userId) };
  }

  /// Gasta um crédito, se houver (atómico). Devolve como o devolver.
  async spendOne(userId: string, feature: string): Promise<{ spent: boolean; release: () => Promise<void> }> {
    const taken = await this.prisma.user.updateMany({ where: { id: userId, aiCredits: { gt: 0 } }, data: { aiCredits: { decrement: 1 } } });
    if (!taken.count) return { spent: false, release: async () => {} };
    const event = await this.prisma.aiCreditEvent.create({ data: { userId, delta: -1, reason: 'USE', note: feature } });
    return {
      spent: true,
      release: async () => {
        await this.prisma.$transaction([
          this.prisma.aiCreditEvent.delete({ where: { id: event.id } }),
          this.prisma.user.update({ where: { id: userId }, data: { aiCredits: { increment: 1 } } }),
        ]).catch(() => undefined);
      },
    };
  }

  /// Uma compra na loja de um pacote de créditos (pelo webhook): quantos dá.
  creditsForProduct(productId?: string | null): number | null {
    if (!productId) return null;
    return creditProducts().find((p) => p.productId === productId)?.credits ?? null;
  }

  async history(userId: string, limit = 50) {
    const rows = await this.prisma.aiCreditEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map((r) => ({ id: r.id, delta: r.delta, reason: r.reason, productId: r.productId, note: r.note, createdAt: r.createdAt }));
  }
}
