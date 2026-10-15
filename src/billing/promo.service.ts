import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { accessWhere, ACCESS_STATUSES, EntitlementsService } from './entitlements.service';
import { SubscriptionsService } from './subscriptions.service';
import { AREAS, FEATURES, FREE_PLAN } from './plans.catalog';
import { ApiException } from '../common/errors/api.exception';
import { PromoCode } from '../generated/prisma/client';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/// "contalex 2026 " → "CONTALEX2026" (maiúsculas, sem espaços).
export function normalizePromoCode(input: string): string {
  return input.toUpperCase().replace(/\s+/g, '');
}

export function randomPromoCode(): string {
  const block = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `CONTALEX-${block()}-${block()}`;
}

/// active | inactive (desligado) | expired (passou a data) | exhausted (já foi todo usado)
export function promoCodeState(code: Pick<PromoCode, 'isActive' | 'expiresAt' | 'maxRedemptions' | 'redeemedCount'>, now = new Date()): 'active' | 'inactive' | 'expired' | 'exhausted' {
  if (!code.isActive) return 'inactive';
  if (code.expiresAt && code.expiresAt <= now) return 'expired';
  if (code.maxRedemptions !== null && code.redeemedCount >= code.maxRedemptions) return 'exhausted';
  return 'active';
}

export interface PromoCodeInput {
  code?: string | null;
  plan: string;
  durationDays?: number | null;
  maxRedemptions?: number | null;
  expiresAt?: string | null;
  note?: string | null;
  blockedAreas?: string[] | null;
  blockedFeatures?: string[] | null;
}

const FEATURE_KEYS = Object.values(FEATURES) as string[];
function cleanBlocks(input: Pick<PromoCodeInput, 'blockedAreas' | 'blockedFeatures'>) {
  const areas = [...new Set((input.blockedAreas ?? []).filter((a) => (AREAS as readonly string[]).includes(a)))];
  const features = [...new Set((input.blockedFeatures ?? []).filter((f) => FEATURE_KEYS.includes(f)))];
  return { areas, features };
}

/// Códigos promocionais: quem escreve o código fica com o plano sem pagar.
/// Estas assinaturas ficam marcadas como PROMO e nunca entram na receita.
@Injectable()
export class PromoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly notifications: NotificationsService,
  ) {}

  /// A pessoa usa um código na app.
  async redeem(userId: string, input: string) {
    const code = await this.prisma.promoCode.findUnique({ where: { code: normalizePromoCode(input) } });
    const state = code ? promoCodeState(code) : 'inactive';
    if (!code || state === 'inactive') throw ApiException.badRequest('PROMO_CODE_INVALID');
    if (state === 'expired') throw ApiException.badRequest('PROMO_CODE_EXPIRED');
    if (state === 'exhausted') throw ApiException.badRequest('PROMO_CODE_EXHAUSTED');
    if (await this.prisma.promoRedemption.findUnique({ where: { promoCodeId_userId: { promoCodeId: code.id, userId } }, select: { id: true } })) {
      throw ApiException.conflict('PROMO_CODE_ALREADY_USED');
    }
    const plan = await this.entitlements.planDefinition(code.plan);
    if (plan.code !== code.plan || plan.code === FREE_PLAN) throw ApiException.badRequest('PROMO_CODE_INVALID');

    const before = await this.entitlements.planCodeFor(userId);
    const now = new Date();
    // Já tem um plano pago (loja) em vigor? Se o código dá um plano melhor,
    // entra já (o pago continua até ao fim). Se dá o mesmo ou pior, fica
    // guardado e começa no dia em que o pago acabar, para não se perder nada.
    const paid = await this.prisma.subscription.findFirst({
      where: { ...accessWhere(userId), isPaid: true, expirationDate: { not: null } },
      orderBy: { expirationDate: 'desc' },
      select: { plan: true, expirationDate: true, autoRenew: true },
    });
    const paidRank = paid ? (await this.entitlements.planDefinition(paid.plan)).rank : -1;
    const queued = !!paid && plan.rank <= paidRank;
    const startsAt = queued ? (paid.expirationDate as Date) : now;
    const run = this.prisma.$transaction(async (tx) => {
      // Reserva um lugar: só passa se ainda houver utilizações livres
      // (duas pessoas ao mesmo tempo não gastam o mesmo último lugar).
      const reserved = await tx.promoCode.updateMany({
        where: { id: code.id, isActive: true, ...(code.maxRedemptions !== null ? { redeemedCount: { lt: code.maxRedemptions } } : {}) },
        data: { redeemedCount: { increment: 1 } },
      });
      if (!reserved.count) throw ApiException.badRequest('PROMO_CODE_EXHAUSTED');
      const expiresAt = code.durationDays ? new Date(startsAt.getTime() + code.durationDays * 86_400_000) : null;
      const subscription = await tx.subscription.create({
        data: {
          userId,
          plan: code.plan,
          status: 'ACTIVE',
          platform: 'OTHER',
          provider: 'PROMO',
          providerSubscriptionId: `${userId}:${code.id}`,
          startDate: startsAt,
          expirationDate: expiresAt,
          autoRenew: false,
          isPaid: false,
          promoCodeId: code.id,
        },
      });
      // Fica registado quem usou, que plano deu, quando e até quando.
      await tx.promoRedemption.create({ data: { promoCodeId: code.id, userId, plan: code.plan, activatedAt: startsAt, expiresAt, subscriptionId: subscription.id } });
    });
    try {
      await run;
    } catch (err) {
      // Dois pedidos ao mesmo tempo da mesma pessoa: o segundo já não conta.
      if ((err as { code?: string }).code === 'P2002') throw ApiException.conflict('PROMO_CODE_ALREADY_USED');
      throw err;
    }
    const after = await this.entitlements.planCodeFor(userId);
    if (after !== before && after !== FREE_PLAN) {
      await this.notifications.notify(userId, 'subscription_active', { plan: after }, () => ({ plan: after === 'PREMIUM_PLUS' ? 'Premium+' : 'Premium' }));
    }
    return {
      redeemed: true,
      plan: code.plan,
      durationDays: code.durationDays,
      /// Quando começa a contar (no futuro se já havia um plano pago em vigor)
      startsAt,
      /// true = ficou guardado para quando o plano pago acabar
      queued,
      /// O plano pago ainda vai renovar na loja: para não pagar, cancela-se lá
      paidRenews: !!paid?.autoRenew,
      subscription: await this.subscriptions.summary(userId),
    };
  }

  // ------------------------------------------------------------------
  // Administração
  // ------------------------------------------------------------------

  private async toDto(code: PromoCode) {
    const active = await this.prisma.subscription.count({
      where: { promoCodeId: code.id, status: { in: [...ACCESS_STATUSES] }, OR: [{ expirationDate: null }, { expirationDate: { gt: new Date() } }] },
    });
    return {
      id: code.id,
      code: code.code,
      plan: code.plan,
      durationDays: code.durationDays,
      maxRedemptions: code.maxRedemptions,
      redeemedCount: code.redeemedCount,
      remaining: code.maxRedemptions === null ? null : Math.max(0, code.maxRedemptions - code.redeemedCount),
      /// Quantas pessoas têm AGORA o plano por causa deste código
      activeUsers: active,
      expiresAt: code.expiresAt,
      isActive: code.isActive,
      state: promoCodeState(code),
      note: code.note,
      blockedAreas: code.blockedAreas,
      blockedFeatures: code.blockedFeatures,
      createdAt: code.createdAt,
    };
  }

  async list() {
    const codes = await this.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
    return Promise.all(codes.map((c) => this.toDto(c)));
  }

  private async assertPlan(plan: string) {
    const definition = await this.entitlements.planDefinition(plan);
    if (definition.code !== plan || plan === FREE_PLAN) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'plan', message: 'unknown' }]);
  }

  async create(adminId: string, input: PromoCodeInput) {
    await this.assertPlan(input.plan);
    let code = input.code ? normalizePromoCode(input.code) : '';
    if (code) {
      if (!/^[A-Z0-9_-]{4,32}$/.test(code)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'code', message: 'invalid' }]);
      if (await this.prisma.promoCode.findUnique({ where: { code }, select: { id: true } })) throw ApiException.conflict('PROMO_CODE_TAKEN');
    } else {
      do code = randomPromoCode();
      while (await this.prisma.promoCode.findUnique({ where: { code }, select: { id: true } }));
    }
    const created = await this.prisma.promoCode.create({
      data: {
        code,
        plan: input.plan,
        durationDays: input.durationDays ?? null,
        maxRedemptions: input.maxRedemptions ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        note: input.note ?? null,
        blockedAreas: cleanBlocks(input).areas,
        blockedFeatures: cleanBlocks(input).features,
        createdById: adminId,
      },
    });
    return this.toDto(created);
  }

  async update(id: string, input: { isActive?: boolean; maxRedemptions?: number | null; expiresAt?: string | null; note?: string | null; durationDays?: number | null; blockedAreas?: string[] | null; blockedFeatures?: string[] | null }) {
    const existing = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!existing) throw ApiException.notFound('PROMO_CODE_NOT_FOUND');
    const updated = await this.prisma.promoCode.update({
      where: { id },
      data: {
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.maxRedemptions !== undefined ? { maxRedemptions: input.maxRedemptions } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        // Só muda a duração para quem usar o código daqui para a frente.
        ...(input.durationDays !== undefined ? { durationDays: input.durationDays } : {}),
        // Mudar o que fica fechado aplica-se logo a quem já usou o código.
        ...(input.blockedAreas !== undefined ? { blockedAreas: cleanBlocks({ blockedAreas: input.blockedAreas }).areas } : {}),
        ...(input.blockedFeatures !== undefined ? { blockedFeatures: cleanBlocks({ blockedFeatures: input.blockedFeatures }).features } : {}),
      },
    });
    return this.toDto(updated);
  }

  /// Apaga um código que ninguém usou. Um código já usado só se desliga
  /// (para o histórico de quem o usou continuar certo).
  async remove(id: string) {
    const existing = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!existing) throw ApiException.notFound('PROMO_CODE_NOT_FOUND');
    if (existing.redeemedCount > 0) {
      await this.prisma.promoCode.update({ where: { id }, data: { isActive: false } });
      return { deleted: false, deactivated: true };
    }
    await this.prisma.promoCode.delete({ where: { id } });
    return { deleted: true, deactivated: false };
  }

  async redemptions(id: string) {
    const code = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!code) throw ApiException.notFound('PROMO_CODE_NOT_FOUND');
    const rows = await this.prisma.promoRedemption.findMany({
      where: { promoCodeId: id },
      include: { user: { select: { id: true, name: true, username: true, email: true } } },
      orderBy: { redeemedAt: 'desc' },
      take: 500,
    });
    const subs = await this.prisma.subscription.findMany({ where: { promoCodeId: id }, select: { userId: true, status: true, expirationDate: true } });
    const byUser = new Map(subs.map((s) => [s.userId, s]));
    const now = new Date();
    return rows.map((r) => {
      const sub = byUser.get(r.userId);
      const active = !!sub && (ACCESS_STATUSES as readonly string[]).includes(sub.status) && (!sub.expirationDate || sub.expirationDate > now);
      return { user: r.user, redeemedAt: r.redeemedAt, plan: r.plan ?? code.plan, activatedAt: r.activatedAt ?? r.redeemedAt, active, expirationDate: sub?.expirationDate ?? r.expiresAt ?? null };
    });
  }
}
