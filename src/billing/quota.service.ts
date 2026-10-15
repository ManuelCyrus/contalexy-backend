import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ApiException } from '../common/errors/api.exception';
import { accessWhere, EntitlementsService } from './entitlements.service';
import { FREE_PLAN, LimitKey } from './plans.catalog';
import { SubscriptionsService } from './subscriptions.service';

/// O período de quota em vigor: começa no aniversário da ativação do plano
/// (ou do registo, no plano grátis) e acaba um mês depois, ou antes se o
/// plano acabar primeiro.
export interface QuotaPeriod {
  start: Date;
  end: Date;
  anchor: Date;
  plan: string;
  /// subscription = pela ativação do plano | account = pela data do registo
  source: 'subscription' | 'account';
}

/// `anchor` + n meses, com o dia preso ao do aniversário (31 jan → 28 fev →
/// 31 mar: cada mês parte sempre do dia de origem, não do mês anterior).
export function addMonthsAnchored(anchor: Date, months: number): Date {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchor.getUTCDate(), lastDay), anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds()));
}

/// O mês de quota que contém `now`, contado desde `anchor`.
export function periodAt(anchor: Date, now: Date, endLimit: Date | null = null): { start: Date; end: Date } {
  if (now < anchor) return { start: anchor, end: endLimit && endLimit < addMonthsAnchored(anchor, 1) ? endLimit : addMonthsAnchored(anchor, 1) };
  // Aproximação pelos meses de calendário, depois ajuste para o aniversário certo.
  let k = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  while (k > 0 && addMonthsAnchored(anchor, k) > now) k -= 1;
  while (addMonthsAnchored(anchor, k + 1) <= now) k += 1;
  const start = addMonthsAnchored(anchor, k);
  let end = addMonthsAnchored(anchor, k + 1);
  if (endLimit && endLimit < end && endLimit > start) end = endLimit;
  return { start, end };
}

@Injectable()
export class QuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async period(userId: string, now = new Date()): Promise<QuotaPeriod> {
    const plan = await this.entitlements.planCodeFor(userId);
    if (plan !== FREE_PLAN) {
      const valid = await this.prisma.subscription.findMany({ where: accessWhere(userId, now) });
      const current = SubscriptionsService.pickCurrent(valid, plan);
      if (current) {
        const { start, end } = periodAt(current.startDate, now, current.expirationDate);
        return { start, end, anchor: current.startDate, plan, source: 'subscription' };
      }
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
    const anchor = user?.createdAt ?? now;
    const { start, end } = periodAt(anchor, now);
    return { start, end, anchor, plan, source: 'account' };
  }

  /// Quanto já se usou de uma funcionalidade neste período.
  async used(userId: string, feature: string, period?: QuotaPeriod): Promise<number> {
    const p = period ?? (await this.period(userId));
    const row = await this.prisma.usageCounter.findUnique({ where: { userId_feature_periodStart: { userId, feature, periodStart: p.start } }, select: { used: true } });
    return row?.used ?? 0;
  }

  /// Reserva uma utilização (de forma atómica: duas ao mesmo tempo nunca
  /// passam do limite). Devolve como a devolver se a ação falhar.
  async reserve(userId: string, feature: string, limitKey: LimitKey, period?: QuotaPeriod): Promise<{ used: number; limit: number | null; release: () => Promise<void> }> {
    const p = period ?? (await this.period(userId));
    const ent = await this.entitlements.forUser(userId);
    const limit = ent.limits[limitKey];
    const where = { userId_feature_periodStart: { userId, feature, periodStart: p.start } };
    const release = async () => {
      await this.prisma.usageCounter.updateMany({ where: { userId, feature, periodStart: p.start, used: { gt: 0 } }, data: { used: { decrement: 1 } } });
    };
    const fail = async () => {
      const plans = await this.entitlements.listPlans();
      const next = plans.find((q) => q.rank > ent.rank && (q.limits[limitKey] === null || (q.limits[limitKey] as number) > (limit as number)));
      throw ApiException.forbidden('AI_QUOTA_REACHED', { max: limit }, { limit: limitKey, bucket: feature, max: limit, requiredPlan: next?.code ?? null, resetsAt: p.end.toISOString() });
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.prisma.usageCounter.findUnique({ where, select: { used: true } });
      if (!existing) {
        if (limit !== null && limit <= 0) await fail();
        try {
          await this.prisma.usageCounter.create({ data: { userId, feature, periodStart: p.start, periodEnd: p.end, plan: p.plan, used: 1 } });
          return { used: 1, limit, release };
        } catch (err) {
          if ((err as { code?: string }).code !== 'P2002') throw err;
          continue; // outro pedido criou-o entretanto
        }
      }
      const bumped = await this.prisma.usageCounter.updateMany({
        where: { userId, feature, periodStart: p.start, ...(limit === null ? {} : { used: { lt: limit } }) },
        data: { used: { increment: 1 }, periodEnd: p.end, plan: p.plan },
      });
      if (bumped.count) return { used: existing.used + 1, limit, release };
      await fail();
    }
    await fail();
    throw new Error('unreachable');
  }

  /// Resumo para a app: por funcionalidade, usado, limite e quando renova.
  async summary(userId: string, features: { feature: string; limitKey: LimitKey }[]) {
    const p = await this.period(userId);
    const ent = await this.entitlements.forUser(userId);
    const rows = await this.prisma.usageCounter.findMany({ where: { userId, periodStart: p.start }, select: { feature: true, used: true } });
    const out: Record<string, { used: number; limit: number | null; remaining: number | null }> = {};
    for (const f of features) {
      const used = rows.find((r) => r.feature === f.feature)?.used ?? 0;
      const limit = ent.limits[f.limitKey];
      out[f.feature] = { used, limit, remaining: limit === null ? null : Math.max(0, limit - used) };
    }
    return { period: p, items: out };
  }
}
