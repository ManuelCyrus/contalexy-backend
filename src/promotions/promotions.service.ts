import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { env, isTrue } from '../config/env';
import { FEATURES } from '../billing/plans.catalog';
import { ApiException } from '../common/errors/api.exception';

export const PLACEMENTS = ['DASHBOARD', 'REPORTS', 'TRANSACTIONS', 'GOALS', 'PLANS', 'SPACES', 'RECURRING', 'SETTINGS', 'SIMULATOR', 'INSIGHTS', 'AI'] as const;

/// Promoções por defeito (criadas na 1.ª vez; depois ajustam-se na tabela).
/// Só anunciam o que é mesmo do Premium — o que o plano grátis já tem
/// (assistente, recibos, previsões, com limite mensal) não se anuncia como pago.
export const DEFAULT_PROMOTIONS = [
  { key: 'dashboard_premium', placement: 'DASHBOARD', feature: null, variants: ['A', 'B'], priority: 1, minIntervalHours: 72, cooldownAfterDismissDays: 10, maxImpressions: 20 },
  { key: 'reports_advanced', placement: 'REPORTS', feature: FEATURES.reportsAdvanced, variants: ['A'], priority: 1, minIntervalHours: 96, cooldownAfterDismissDays: 21, maxImpressions: 8 },
  { key: 'transactions_rules', placement: 'TRANSACTIONS', feature: FEATURES.automationRules, variants: ['A'], priority: 1, minIntervalHours: 120, cooldownAfterDismissDays: 21, maxImpressions: 6 },
  { key: 'goals_simulations', placement: 'GOALS', feature: FEATURES.simulationsAdvanced, variants: ['A'], priority: 1, minIntervalHours: 120, cooldownAfterDismissDays: 21, maxImpressions: 6 },
  { key: 'plans_more', placement: 'PLANS', feature: null, variants: ['A'], priority: 1, minIntervalHours: 120, cooldownAfterDismissDays: 21, maxImpressions: 6 },
  { key: 'recurring_insights', placement: 'RECURRING', feature: FEATURES.insightsAdvanced, variants: ['A'], priority: 1, minIntervalHours: 120, cooldownAfterDismissDays: 30, maxImpressions: 5 },
  { key: 'spaces_more', placement: 'SPACES', feature: null, variants: ['A'], priority: 1, minIntervalHours: 168, cooldownAfterDismissDays: 30, maxImpressions: 5 },
  { key: 'simulator_advanced', placement: 'SIMULATOR', feature: FEATURES.simulationsAdvanced, variants: ['A'], priority: 1, minIntervalHours: 120, cooldownAfterDismissDays: 21, maxImpressions: 6 },
  { key: 'insights_advanced', placement: 'INSIGHTS', feature: FEATURES.insightsAdvanced, variants: ['A'], priority: 1, minIntervalHours: 120, cooldownAfterDismissDays: 21, maxImpressions: 6 },
  { key: 'ai_more', placement: 'AI', feature: null, variants: ['A'], priority: 1, minIntervalHours: 168, cooldownAfterDismissDays: 30, maxImpressions: 5 },
];

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/// Promoções do Premium SEM spam: cada uma tem intervalo mínimo, pausa
/// depois de fechada e um máximo de vezes; e no total nunca mais de uma
/// por X horas. Nunca aparece a quem já é Premium, nem durante tarefas
/// (a app pede com context=busy e não recebe nada).
@Injectable()
export class PromotionsService implements OnModuleInit {
  private readonly logger = new Logger(PromotionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async onModuleInit() {
    try {
      await this.prisma.promotion.createMany({ data: DEFAULT_PROMOTIONS.map((p) => ({ ...p, targetPlans: ['FREE'] })), skipDuplicates: true });
    } catch (err) {
      this.logger.warn(`Promoções por defeito: ${(err as Error).message}`);
    }
  }

  async next(userId: string, placement: string, context?: string, now = new Date()) {
    if (!isTrue(env().PROMOTIONS_ENABLED) || context === 'busy') return null;
    const plan = await this.entitlements.planCodeFor(userId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { lastPromotionAt: true, createdAt: true } });
    if (!user) return null;
    // Nos primeiros 2 dias não se mostra nada — primeiro a app tem de ser útil.
    if (now.getTime() - user.createdAt.getTime() < 2 * DAY) return null;
    const gap = env().PROMOTIONS_GLOBAL_GAP_HOURS * HOUR;
    if (user.lastPromotionAt && now.getTime() - user.lastPromotionAt.getTime() < gap) return null;

    const promotions = await this.prisma.promotion.findMany({
      where: {
        placement,
        isEnabled: true,
        targetPlans: { has: plan },
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
      include: { states: { where: { userId } } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    for (const p of promotions) {
      const state = p.states[0];
      if (state?.dismissedAt && now.getTime() - state.dismissedAt.getTime() < p.cooldownAfterDismissDays * DAY) continue;
      if (state?.lastShownAt && now.getTime() - state.lastShownAt.getTime() < p.minIntervalHours * HOUR) continue;
      if ((state?.impressions ?? 0) >= p.maxImpressions) continue;
      const variant = state?.variant ?? p.variants[randomInt(p.variants.length)] ?? 'A';
      if (!state) await this.prisma.userPromotionState.create({ data: { userId, promotionKey: p.key, variant } });
      return { key: p.key, placement: p.placement, feature: p.feature, variant };
    }
    return null;
  }

  private async state(userId: string, key: string) {
    const promotion = await this.prisma.promotion.findUnique({ where: { key }, select: { key: true, variants: true } });
    if (!promotion) throw ApiException.notFound();
    return promotion;
  }

  /// A app mostrou-a (uma vez por visualização).
  async seen(userId: string, key: string, now = new Date()) {
    const p = await this.state(userId, key);
    await this.prisma.userPromotionState.upsert({
      where: { userId_promotionKey: { userId, promotionKey: key } },
      create: { userId, promotionKey: key, variant: p.variants[0] ?? 'A', impressions: 1, lastShownAt: now },
      update: { impressions: { increment: 1 }, lastShownAt: now },
    });
    await this.prisma.user.update({ where: { id: userId }, data: { lastPromotionAt: now } });
    return { ok: true };
  }

  async dismiss(userId: string, key: string, now = new Date()) {
    const p = await this.state(userId, key);
    await this.prisma.userPromotionState.upsert({
      where: { userId_promotionKey: { userId, promotionKey: key } },
      create: { userId, promotionKey: key, variant: p.variants[0] ?? 'A', dismissedAt: now, lastShownAt: now },
      update: { dismissedAt: now },
    });
    return { ok: true };
  }

  async click(userId: string, key: string, now = new Date()) {
    const p = await this.state(userId, key);
    await this.prisma.userPromotionState.upsert({
      where: { userId_promotionKey: { userId, promotionKey: key } },
      create: { userId, promotionKey: key, variant: p.variants[0] ?? 'A', clickedAt: now, lastShownAt: now },
      update: { clickedAt: now },
    });
    return { ok: true };
  }
}
