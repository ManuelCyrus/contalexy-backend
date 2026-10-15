import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { env } from '../config/env';

/// none = tudo normal · heavy = funções pesadas em pausa (plano grátis) ·
/// all = toda a IA em pausa (plano grátis)
export type AiLimitLevel = 'none' | 'heavy' | 'all';

/// A partir de que parte do teto se começa a limitar.
export const HEAVY_AT = 0.8;
export const ALL_AT = 1;

export function limitLevel(cost: number, budget: number): AiLimitLevel {
  if (budget <= 0) return 'none';
  const ratio = cost / budget;
  if (ratio >= ALL_AT) return 'all';
  if (ratio >= HEAVY_AT) return 'heavy';
  return 'none';
}

/// Custo estimado (USD) de um pedido, pelos preços configurados no .env.
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const e = env();
  const advanced = model === e.AI_MODEL_ADVANCED && e.AI_MODEL_ADVANCED !== e.AI_MODEL;
  const input = advanced ? e.AI_PRICE_ADVANCED_INPUT_PER_MTOK : e.AI_PRICE_INPUT_PER_MTOK;
  const output = advanced ? e.AI_PRICE_ADVANCED_OUTPUT_PER_MTOK : e.AI_PRICE_OUTPUT_PER_MTOK;
  return (inputTokens * input + outputTokens * output) / 1_000_000;
}

/// Teto global de custo da IA (AI_MONTHLY_BUDGET_USD): quanto já se gastou
/// este mês e se é preciso travar o plano grátis.
@Injectable()
export class AiBudgetService {
  private cache: { month: string; at: number; cost: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  monthStart(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  /// Custo deste mês (a soma é guardada um minuto para não pesar em cada pedido).
  async monthCost(force = false): Promise<number> {
    const since = this.monthStart();
    const month = since.toISOString().slice(0, 7);
    if (!force && this.cache && this.cache.month === month && Date.now() - this.cache.at < 60_000) return this.cache.cost;
    const sum = await this.prisma.aiUsage.aggregate({ where: { createdAt: { gte: since } }, _sum: { costUsd: true } });
    const cost = Number(sum._sum.costUsd ?? 0);
    this.cache = { month, at: Date.now(), cost };
    return cost;
  }

  /// Junta um pedido acabado de fazer à soma em memória.
  add(cost: number) {
    if (this.cache) this.cache.cost += cost;
  }

  async state() {
    const budget = env().AI_MONTHLY_BUDGET_USD;
    const cost = await this.monthCost();
    return {
      budgetUsd: budget,
      costUsd: Math.round(cost * 10000) / 10000,
      percent: budget > 0 ? Math.round((cost / budget) * 1000) / 10 : null,
      level: limitLevel(cost, budget),
    };
  }
}
