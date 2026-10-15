import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ApiException } from '../common/errors/api.exception';
import { DEFAULT_PLANS, FREE_PLAN, LIMIT_KEYS, LimitKey, PlanDefinition, PlanLimits, REMOVED_FEATURES } from './plans.catalog';
import { env, isTrue } from '../config/env';
import { Prisma } from '../generated/prisma/client';

/// Estados de assinatura que ainda dão acesso (até à data de fim).
export const ACCESS_STATUSES = ['ACTIVE', 'TRIAL', 'CANCELLED', 'BILLING_ISSUE'] as const;

/// { "produto": dias } como está guardado na tabela (só entram valores válidos).
export function parseOneTimeProducts(value: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, days] of Object.entries(value as Record<string, unknown>)) {
    if (days === null) out[id] = null;
    else if (typeof days === 'number' && Number.isFinite(days) && days > 0) out[id] = Math.round(days);
  }
  return out;
}

/// O produto de uma loja sem o plano-base: na Google Play uma subscrição pode
/// vir como "produto:plano-base" (e o mesmo produto sem ele noutros sítios).
export function baseProductId(id?: string | null): string | null {
  const base = (id ?? '').split(':')[0].trim();
  return base ? base : null;
}

/// As assinaturas que dão acesso agora. As compras de teste das lojas
/// (sandbox) só contam se BILLING_ACCEPT_SANDBOX o permitir.
export function accessWhere(userId: string, now = new Date()): Prisma.SubscriptionWhereInput {
  return {
    userId,
    status: { in: [...ACCESS_STATUSES] },
    // Um código promocional usado com um plano pago em vigor só começa quando o pago acabar.
    startDate: { lte: now },
    OR: [{ expirationDate: null }, { expirationDate: { gt: now } }],
    ...(isTrue(env().BILLING_ACCEPT_SANDBOX) ? {} : { NOT: { provider: 'REVENUECAT', isSandbox: true } }),
  };
}

export interface UserEntitlements {
  plan: string;
  rank: number;
  features: string[];
  limits: PlanLimits;
  /// Áreas fechadas pelo código promocional em vigor (a app esconde-as)
  blockedAreas: string[];
}

/// Quem pode o quê: o plano de cada pessoa (pelas assinaturas ativas) e
/// os benefícios/limites desse plano (tabela SubscriptionPlan).
@Injectable()
export class EntitlementsService implements OnModuleInit {
  private readonly logger = new Logger(EntitlementsService.name);
  private plans = new Map<string, PlanDefinition>();
  private loadedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      await this.ensureDefaults();
      await this.reload();
    } catch (err) {
      this.logger.warn(`Não foi possível carregar os planos: ${(err as Error).message}`);
      this.useDefaults();
    }
  }

  /// Cria os planos por defeito que ainda não existam (não mexe nos que já
  /// estão na base de dados — podem ter sido ajustados).
  async ensureDefaults() {
    for (const plan of DEFAULT_PLANS) {
      const existing = await this.prisma.subscriptionPlan.findUnique({ where: { code: plan.code } });
      if (!existing) {
        await this.prisma.subscriptionPlan.create({
          data: {
            code: plan.code,
            rank: plan.rank,
            features: plan.features,
            limits: plan.limits as unknown as object,
            entitlementId: plan.entitlementId,
            productIds: plan.productIds,
            oneTimeProducts: plan.oneTimeProducts as object,
          },
        });
      } else {
        const data: { oneTimeProducts?: object; features?: string[] } = {};
        if (Object.keys(plan.oneTimeProducts).length && !Object.keys(parseOneTimeProducts(existing.oneTimeProducts)).length) {
          // Planos criados antes de haver compras de uma só vez: ficam com as de origem.
          data.oneTimeProducts = plan.oneTimeProducts as object;
        }
        // Funcionalidades novas entram; as retiradas do catálogo saem (os limites ficam como estão).
        const removed = REMOVED_FEATURES[plan.code] ?? [];
        const features = [...new Set([...existing.features, ...plan.features])].filter((f) => !removed.includes(f));
        if (features.length !== existing.features.length || features.some((f) => !existing.features.includes(f))) data.features = features;
        if (Object.keys(data).length) await this.prisma.subscriptionPlan.update({ where: { code: plan.code }, data });
      }
    }
  }

  async reload() {
    const rows = await this.prisma.subscriptionPlan.findMany({ where: { isActive: true }, orderBy: { rank: 'asc' } });
    const map = new Map<string, PlanDefinition>();
    for (const row of rows) {
      const defaults = DEFAULT_PLANS.find((p) => p.code === row.code)?.limits ?? DEFAULT_PLANS[0].limits;
      const stored = (row.limits ?? {}) as Partial<Record<LimitKey, number | null>>;
      const limits = {} as PlanLimits;
      for (const key of LIMIT_KEYS) limits[key] = key in stored ? (stored[key] ?? null) : defaults[key];
      map.set(row.code, {
        code: row.code,
        rank: row.rank,
        features: row.features,
        limits,
        entitlementId: row.entitlementId,
        productIds: row.productIds,
        oneTimeProducts: parseOneTimeProducts(row.oneTimeProducts),
      });
    }
    if (!map.has(FREE_PLAN)) map.set(FREE_PLAN, DEFAULT_PLANS[0]);
    this.plans = map;
    this.loadedAt = Date.now();
  }

  /// Para testes / arranque sem base de dados.
  useDefaults() {
    this.plans = new Map(DEFAULT_PLANS.map((p) => [p.code, p]));
    this.loadedAt = Date.now();
  }

  private async catalog(): Promise<Map<string, PlanDefinition>> {
    if (Date.now() - this.loadedAt > 5 * 60_000) {
      try {
        await this.reload();
      } catch {
        // fica com o que tinha
      }
    }
    return this.plans;
  }

  async listPlans(): Promise<PlanDefinition[]> {
    return [...(await this.catalog()).values()].sort((a, b) => a.rank - b.rank);
  }

  async planDefinition(code: string): Promise<PlanDefinition> {
    const catalog = await this.catalog();
    return catalog.get(code) ?? catalog.get(FREE_PLAN) ?? DEFAULT_PLANS[0];
  }

  /// O plano que a pessoa tem agora (o melhor entre as assinaturas válidas).
  async planCodeFor(userId: string): Promise<string> {
    const subs = await this.prisma.subscription.findMany({ where: accessWhere(userId), select: { plan: true } });
    if (!subs.length) return FREE_PLAN;
    const catalog = await this.catalog();
    let best = FREE_PLAN;
    let bestRank = -1;
    for (const s of subs) {
      const rank = catalog.get(s.plan)?.rank ?? -1;
      if (rank > bestRank) {
        best = s.plan;
        bestRank = rank;
      }
    }
    return bestRank < 0 ? FREE_PLAN : best;
  }

  async forUser(userId: string): Promise<UserEntitlements> {
    const code = await this.planCodeFor(userId);
    const plan = await this.planDefinition(code);
    const blocks = await this.promoBlocks(userId, code);
    return { plan: plan.code, rank: plan.rank, features: plan.features.filter((f) => !blocks.features.includes(f)), limits: plan.limits, blockedAreas: blocks.areas };
  }

  /// O que o código promocional que dá o plano atual deixa fechado.
  private async promoBlocks(userId: string, plan: string): Promise<{ areas: string[]; features: string[] }> {
    if (plan === FREE_PLAN) return { areas: [], features: [] };
    const subs = await this.prisma.subscription.findMany({ where: { ...accessWhere(userId), plan, provider: 'PROMO', promoCodeId: { not: null } }, select: { promoCodeId: true } });
    if (!subs.length) return { areas: [], features: [] };
    // Se também houver um acesso sem restrições a este plano (loja ou oferta), nada fica fechado.
    const free = await this.prisma.subscription.count({ where: { ...accessWhere(userId), plan, provider: { not: 'PROMO' } } });
    if (free) return { areas: [], features: [] };
    const codes = await this.prisma.promoCode.findMany({ where: { id: { in: subs.map((s) => s.promoCodeId as string) } }, select: { blockedAreas: true, blockedFeatures: true } });
    // Com vários códigos, só fica fechado o que todos fecham.
    const inter = (lists: string[][]) => lists.reduce((acc, l) => acc.filter((x) => l.includes(x)));
    return { areas: inter(codes.map((c) => c.blockedAreas)), features: inter(codes.map((c) => c.blockedFeatures)) };
  }

  async hasFeature(userId: string, feature: string): Promise<boolean> {
    return (await this.forUser(userId)).features.includes(feature);
  }

  /// O plano mais barato que tem esta funcionalidade (para a app mostrar).
  async lowestPlanWith(feature: string): Promise<string> {
    const plans = await this.listPlans();
    return plans.find((p) => p.features.includes(feature))?.code ?? plans[plans.length - 1]?.code ?? FREE_PLAN;
  }

  async assertFeature(userId: string, feature: string): Promise<void> {
    if (!(await this.hasFeature(userId, feature))) {
      throw ApiException.premiumRequired(feature, await this.lowestPlanWith(feature));
    }
  }

  async limit(userId: string, key: LimitKey): Promise<number | null> {
    return (await this.forUser(userId)).limits[key];
  }

  /// O plano mais barato acima do atual que dá mais deste limite (null = não há).
  async nextPlanWithMore(ent: UserEntitlements, key: LimitKey): Promise<string | null> {
    const max = ent.limits[key];
    if (max === null) return null;
    const plans = await this.listPlans();
    return plans.find((p) => p.rank > ent.rank && (p.limits[key] === null || (p.limits[key] as number) > max))?.code ?? null;
  }

  /// Lança PLAN_LIMIT_REACHED se `currentCount` já chegou ao limite.
  async assertLimit(userId: string, key: LimitKey, currentCount: number): Promise<void> {
    const ent = await this.forUser(userId);
    const max = ent.limits[key];
    if (max === null || currentCount < max) return;
    throw ApiException.planLimit(key, max, await this.nextPlanWithMore(ent, key));
  }

  /// O plano que corresponde a um produto/entitlement do RevenueCat.
  async planForStoreProduct(entitlementIds: string[], rawProductId?: string | null): Promise<PlanDefinition | null> {
    const productId = baseProductId(rawProductId);
    const plans = await this.listPlans();
    const matches = plans.filter(
      (p) =>
        p.code !== FREE_PLAN &&
        ((p.entitlementId && entitlementIds.includes(p.entitlementId)) || (productId && (p.productIds.includes(productId) || productId in p.oneTimeProducts))),
    );
    if (!matches.length) return null;
    return matches.sort((a, b) => b.rank - a.rank)[0];
  }

  /// Uma compra de uma só vez: o plano que dá e por quantos dias (null = para
  /// sempre). Devolve null se o produto não está configurado como tal — uma
  /// compra única desconhecida nunca dá acesso.
  async oneTimeProduct(rawProductId?: string | null): Promise<{ plan: PlanDefinition; days: number | null } | null> {
    const productId = baseProductId(rawProductId);
    if (!productId) return null;
    for (const plan of await this.listPlans()) {
      if (plan.code !== FREE_PLAN && productId in plan.oneTimeProducts) return { plan, days: plan.oneTimeProducts[productId] };
    }
    return null;
  }
}
