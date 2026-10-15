import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ApiException } from '../common/errors/api.exception';
import { EntitlementsService, UserEntitlements } from './entitlements.service';
import { FEATURES } from './plans.catalog';

/// O que pode ficar bloqueado quando a pessoa deixa de ter um plano pago: as
/// ferramentas de planear. O que é dinheiro a sério ou envolve outras pessoas
/// (contas, movimentos, empréstimos, Spaces) nunca bloqueia.
export const LOCKABLE = ['goals', 'budgets', 'plans', 'recurring', 'rules'] as const;
export type LockableResource = (typeof LOCKABLE)[number];

export type LockedCounts = Record<LockableResource, number> & { total: number };

/// "O que fizeste com o plano pago fica fechado quando ele acaba."
///
/// Ninguém consegue passar dos limites do plano grátis sem ter tido um plano
/// pago; por isso, o que está PARA LÁ do limite do plano atual foi criado com
/// ele. Esses itens (a contar dos mais antigos, que ficam abertos) continuam a
/// existir, mas fechados: aparecem nas listas só com uma amostra, não se abrem
/// nem se mudam, e deixam de trabalhar sozinhos (avisos, movimentos
/// automáticos). Voltam ao normal no momento em que a pessoa recupera o plano.
/// Apagar é sempre possível — os dados são dela.
@Injectable()
export class LocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /// Quantos itens deste tipo o plano deixa ter abertos (null = sem limite).
  private limitOf(ent: UserEntitlements, resource: LockableResource): number | null {
    // As regras automáticas são uma funcionalidade paga: sem ela, fecham todas.
    if (resource === 'rules' && !ent.features.includes(FEATURES.automationRules)) return 0;
    return ent.limits[resource];
  }

  /// Os ids que passam do limite. Só contam os itens que gastam o limite
  /// (ativos); os mais antigos ficam abertos.
  private async overflow(userId: string, resource: LockableResource, limit: number): Promise<string[]> {
    const page = { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }], skip: Math.max(0, limit), select: { id: true } };
    switch (resource) {
      case 'goals':
        return (await this.prisma.goal.findMany({ where: { userId, status: 'ACTIVE' }, ...page })).map((r) => r.id);
      case 'budgets':
        return (await this.prisma.budget.findMany({ where: { userId, isActive: true }, ...page })).map((r) => r.id);
      case 'plans':
        // As listas do mês (com mês e categoria) fazem parte do plano do mês: não contam.
        return (await this.prisma.plan.findMany({ where: { userId, status: { in: ['PLANNING', 'ACTIVE'] }, OR: [{ periodKey: null }, { categoryId: null }] }, ...page })).map((r) => r.id);
      case 'recurring':
        return (await this.prisma.recurringRule.findMany({ where: { userId, isActive: true }, ...page })).map((r) => r.id);
      case 'rules':
        return (await this.prisma.categoryRule.findMany({ where: { userId }, ...page })).map((r) => r.id);
    }
  }

  private async idsFor(userId: string, resource: LockableResource, ent: UserEntitlements): Promise<string[]> {
    const limit = this.limitOf(ent, resource);
    return limit === null ? [] : this.overflow(userId, resource, limit);
  }

  /// Os itens deste tipo que estão fechados para esta pessoa.
  async lockedIds(userId: string, resource: LockableResource): Promise<Set<string>> {
    return new Set(await this.idsFor(userId, resource, await this.entitlements.forUser(userId)));
  }

  async isLocked(userId: string, resource: LockableResource, id: string): Promise<boolean> {
    return (await this.lockedIds(userId, resource)).has(id);
  }

  /// Lança PLAN_ITEM_LOCKED se o item está fechado.
  async assertUnlocked(userId: string, resource: LockableResource, id: string): Promise<void> {
    const ent = await this.entitlements.forUser(userId);
    const limit = this.limitOf(ent, resource);
    if (limit === null) return;
    if (!(await this.overflow(userId, resource, limit)).includes(id)) return;
    throw ApiException.itemLocked(resource, limit, await this.entitlements.nextPlanWithMore(ent, resource));
  }

  /// Quantos itens estão fechados (para a app avisar e dar a amostra).
  async counts(userId: string): Promise<LockedCounts> {
    const ent = await this.entitlements.forUser(userId);
    const out = { goals: 0, budgets: 0, plans: 0, recurring: 0, rules: 0, total: 0 };
    await Promise.all(
      LOCKABLE.map(async (resource) => {
        out[resource] = (await this.idsFor(userId, resource, ent)).length;
      }),
    );
    out.total = LOCKABLE.reduce((acc, resource) => acc + out[resource], 0);
    return out;
  }

  /// Para as tarefas automáticas, que percorrem itens de muita gente: pergunta
  /// "este item está fechado?" guardando a resposta por pessoa.
  checker(resource: LockableResource): (userId: string, id: string) => Promise<boolean> {
    const cache = new Map<string, Set<string>>();
    return async (userId, id) => {
      let ids = cache.get(userId);
      if (!ids) {
        ids = await this.lockedIds(userId, resource);
        cache.set(userId, ids);
      }
      return ids.has(id);
    };
  }
}
