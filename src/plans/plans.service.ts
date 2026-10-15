import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { LocksService } from '../billing/locks.service';
import { ExchangeService } from '../exchange/exchange.service';
import { TransactionsService, txInclude, toTransactionDto } from '../transactions/transactions.service';
import { ApiException } from '../common/errors/api.exception';
import { fromDbDate, fromDbDateOrNull, todayIn, toDbDate } from '../common/utils/dates';
import { money, num, numOrNull, round2 } from '../common/utils/money';
import { Category, Plan, PlanItem, PlanType } from '../generated/prisma/client';
import { toCategoryDto } from '../categories/categories.service';
import { CheckoutDto, CreatePlanDto, ItemKind, PayItemDto, PlanItemDto, UpdatePlanDto, UpdatePlanItemDto } from './plans.dto';
import { isCurrency } from '../meta/countries.data';

const PLAN_ICONS: Record<string, string> = {
  TRIP: 'flight',
  EVENT: 'celebration',
  PROJECT: 'construction',
  PURCHASE: 'shopping_bag',
  SHOPPING: 'shopping_cart',
  BUSINESS: 'storefront',
  MOVING: 'local_shipping',
  COURSE: 'school',
  VEHICLE: 'directions_car',
  OTHER: 'map',
};
const ACTIVE = ['PLANNING', 'ACTIVE'] as const;

/// As listas que detalham uma categoria do plano do mês ("o que vou comprar na
/// Alimentação em novembro") fazem parte desse plano: não gastam o limite de
/// planos. Só têm um teto por mês, para não haver abusos.
const MONTH_LISTS_MAX = 30;
const isMonthList = (p: { periodKey?: string | null; categoryId?: string | null }) => !!p.periodKey && !!p.categoryId;

/// As contas de um plano de negócio a partir dos itens (por tipo).
export function businessSummary(input: { capital: number | null; items: Array<{ kind: string; estimatedAmount: number }>; spent: number; earned: number }) {
  const of = (kind: string) => round2(input.items.filter((i) => i.kind === kind).reduce((acc, i) => acc + i.estimatedAmount, 0));
  const startupCosts = of('COST');
  const monthlyCosts = of('MONTHLY_COST');
  const reserve = of('RESERVE');
  const expectedRevenue = of('REVENUE');
  const totalCosts = round2(startupCosts + monthlyCosts);
  const expectedProfit = round2(expectedRevenue - totalCosts);
  const actualProfit = round2(input.earned - input.spent);
  return {
    capital: input.capital,
    startupCosts,
    monthlyCosts,
    reserve,
    totalCosts,
    /// Quanto é preciso ter para arrancar (custos + reserva)
    capitalNeeded: round2(totalCosts + reserve),
    /// O que sobra do capital depois dos custos e da reserva (negativo = falta dinheiro)
    capitalLeft: input.capital !== null ? round2(input.capital - totalCosts - reserve) : null,
    expectedRevenue,
    expectedProfit,
    marginPercent: expectedRevenue > 0 ? round2((expectedProfit / expectedRevenue) * 100) : null,
    /// Retorno sobre o que se investe
    roiPercent: totalCosts > 0 ? round2((expectedProfit / totalCosts) * 100) : null,
    /// Quanto é preciso vender para não perder dinheiro
    breakEvenRevenue: totalCosts,
    // Resultados reais (movimentos ligados ao plano)
    actualCosts: input.spent,
    actualRevenue: input.earned,
    actualProfit,
    /// Real − previsto (positivo = correu melhor do que o previsto)
    profitDifference: round2(actualProfit - expectedProfit),
  };
}

/// O preço por unidade e o total de uma linha: com preço por unidade, o total
/// é quantidade × preço; sem ele, vale a estimativa dada para a linha toda.
export function linePricing(input: { quantity: number; unitPrice?: number | null; estimatedAmount?: number | null }): { unitPrice: number | null; estimatedAmount: number | null } {
  if (input.unitPrice != null) return { unitPrice: round2(input.unitPrice), estimatedAmount: round2(input.unitPrice * input.quantity) };
  return { unitPrice: null, estimatedAmount: input.estimatedAmount != null ? round2(input.estimatedAmount) : null };
}

/// Planos: viagens, eventos, projetos, compras grandes, listas de compras
/// e planos de negócio. Cada item tem uma estimativa; ao "pagar" um item
/// cria-se a despesa ligada ao plano — e o plano mostra planeado vs. real.
@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly exchange: ExchangeService,
    private readonly transactions: TransactionsService,
    private readonly locks: LocksService,
  ) {}

  private pricingData(p: { unitPrice: number | null; estimatedAmount: number | null }) {
    return { unitPrice: p.unitPrice !== null ? money(p.unitPrice) : null, estimatedAmount: p.estimatedAmount !== null ? money(p.estimatedAmount) : null };
  }

  private itemDto(i: PlanItem) {
    return {
      id: i.id,
      title: i.title,
      notes: i.notes,
      quantity: i.quantity,
      /// Preço de uma unidade (null = só se sabe o total da linha)
      unitPrice: numOrNull(i.unitPrice),
      /// Total previsto da linha (quantidade × preço, quando há preço por unidade)
      estimatedAmount: numOrNull(i.estimatedAmount),
      actualAmount: numOrNull(i.actualAmount),
      kind: i.kind,
      isDone: i.isDone,
      dueDate: fromDbDateOrNull(i.dueDate),
      categoryKey: i.categoryKey,
      transactionId: i.transactionId,
      sortOrder: i.sortOrder,
    };
  }

  /// Gasto e recebido = despesas e receitas ligadas ao plano (na moeda do plano).
  private async flowsByPlan(userId: string, planIds: string[], currencies: Map<string, string>) {
    const rows = planIds.length
      ? await this.prisma.transaction.groupBy({
          by: ['planId', 'type', 'currency'],
          where: { userId, planId: { in: planIds }, type: { in: ['EXPENSE', 'INCOME'] } },
          _sum: { amount: true },
        })
      : [];
    const flows = new Map<string, { spent: number; earned: number }>();
    for (const row of rows) {
      if (!row.planId) continue;
      const to = currencies.get(row.planId) ?? row.currency;
      const value = this.exchange.convert(num(row._sum.amount), row.currency, to) ?? 0;
      const entry = flows.get(row.planId) ?? { spent: 0, earned: 0 };
      if (row.type === 'EXPENSE') entry.spent = round2(entry.spent + value);
      else entry.earned = round2(entry.earned + value);
      flows.set(row.planId, entry);
    }
    return flows;
  }

  planDto(plan: Plan & { items: PlanItem[]; category?: Category | null }, flows: { spent: number; earned: number } | undefined, withItems: boolean) {
    const spent = flows?.spent ?? 0;
    const earned = flows?.earned ?? 0;
    // Custos previstos: tudo menos as receitas e a reserva (planos de negócio).
    const costs = plan.items.filter((i) => i.kind !== 'REVENUE' && i.kind !== 'RESERVE');
    const estimatedItems = round2(costs.reduce((acc, i) => acc + num(i.estimatedAmount), 0));
    const budget = numOrNull(plan.budget);
    const reference = budget ?? (estimatedItems > 0 ? estimatedItems : null);
    const done = plan.items.filter((i) => i.isDone).length;
    // Planeado vs. real, só nos itens que já têm o valor real.
    const priced = costs.filter((i) => i.actualAmount !== null);
    const actual = round2(priced.reduce((acc, i) => acc + num(i.actualAmount), 0));
    const estimatedForActual = round2(priced.reduce((acc, i) => acc + num(i.estimatedAmount), 0));
    return {
      id: plan.id,
      name: plan.name,
      type: plan.type,
      status: plan.status,
      description: plan.description,
      icon: plan.icon,
      color: plan.color,
      budget,
      capital: numOrNull(plan.capital),
      currency: plan.currency,
      startDate: fromDbDateOrNull(plan.startDate),
      endDate: fromDbDateOrNull(plan.endDate),
      aiGenerated: plan.aiGenerated,
      pinned: plan.pinnedAt !== null,
      /// Mês a que pertence ("2026-11") e a categoria que detalha
      periodKey: plan.periodKey,
      categoryId: plan.categoryId,
      category: plan.category ? toCategoryDto(plan.category) : null,
      estimated: estimatedItems,
      spent,
      earned,
      remaining: reference !== null ? round2(reference - spent) : null,
      budgetUsedPercent: reference ? round2((spent / reference) * 100) : null,
      /// Soma dos valores reais dos itens (null = ainda nenhum item com valor real)
      actual: priced.length ? actual : null,
      /// Real − planeado nesses itens (positivo = ficou mais caro)
      actualDifference: priced.length ? round2(actual - estimatedForActual) : null,
      itemsTotal: plan.items.length,
      itemsDone: done,
      progress: plan.items.length ? round2((done / plan.items.length) * 100) : 0,
      business:
        plan.type === 'BUSINESS'
          ? businessSummary({ capital: numOrNull(plan.capital), items: plan.items.map((i) => ({ kind: i.kind, estimatedAmount: num(i.estimatedAmount) })), spent, earned })
          : null,
      /// Fechado: criado com um plano pago que a pessoa já não tem (ver LocksService)
      locked: false,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      ...(withItems ? { items: [...plan.items].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime()).map((i) => this.itemDto(i)) } : {}),
    };
  }

  /// A amostra de um plano fechado: o nome, o tipo e quantos itens tem — sem
  /// valores, datas nem o que lá está escrito.
  private teaser(plan: Plan & { items: PlanItem[] }) {
    return {
      ...this.planDto({ ...plan, items: [], description: null, budget: null, capital: null, startDate: null, endDate: null, pinnedAt: null, aiGenerated: false, category: null }, undefined, false),
      itemsTotal: plan.items.length,
      locked: true,
    };
  }

  /// `period`: só os planos de um mês ("2026-11"). Por omissão, os planos
  /// fechados ficam de fora; com `teasers`, vêm como amostra (lista da app).
  async list(userId: string, status?: string, period?: string, opts: { teasers?: boolean; type?: string } = {}) {
    const [plans, locked] = await Promise.all([
      this.prisma.plan.findMany({
        where: {
          userId,
          ...(status === 'active' ? { status: { in: [...ACTIVE] } } : status === 'closed' ? { status: { in: ['DONE', 'CANCELLED'] } } : {}),
          ...(opts.type ? { type: opts.type as PlanType } : {}),
          ...(period ? { periodKey: period } : {}),
        },
        include: { items: true, category: true },
        orderBy: [{ startDate: 'asc' }, { createdAt: 'desc' }],
      }),
      this.locks.lockedIds(userId, 'plans'),
    ]);
    const open = plans.filter((p) => !locked.has(p.id));
    const flows = await this.flowsByPlan(userId, open.map((p) => p.id), new Map(open.map((p) => [p.id, p.currency])));
    // Os fixados primeiro (o mais recente à frente).
    open.sort((a, b) => (b.pinnedAt?.getTime() ?? 0) - (a.pinnedAt?.getTime() ?? 0));
    const out: Array<ReturnType<PlansService['planDto']>> = open.map((p) => this.planDto(p, flows.get(p.id), false));
    if (opts.teasers) {
      for (const p of plans) {
        if (locked.has(p.id)) out.push(this.teaser(p));
      }
    }
    return out;
  }

  private async ownedOrThrow(userId: string, id: string) {
    const plan = await this.prisma.plan.findFirst({ where: { id, userId }, include: { items: true, category: true } });
    if (!plan) throw ApiException.notFound('PLAN_NOT_FOUND');
    return plan;
  }

  /// A categoria que um plano detalha tem de ser de despesa e da própria pessoa.
  private async assertCategory(userId: string, categoryId?: string | null) {
    if (!categoryId) return;
    const category = await this.prisma.category.findFirst({ where: { id: categoryId, userId, type: 'EXPENSE' }, select: { id: true } });
    if (!category) throw ApiException.notFound('CATEGORY_NOT_FOUND');
  }

  /// Quantos planos em aberto contam para o limite (as listas do mês ficam de fora).
  private plansInLimit(userId: string) {
    return this.prisma.plan.count({ where: { userId, status: { in: [...ACTIVE] }, OR: [{ periodKey: null }, { categoryId: null }] } });
  }

  private async assertMonthLists(userId: string, periodKey: string) {
    const inMonth = await this.prisma.plan.count({ where: { userId, periodKey, categoryId: { not: null } } });
    if (inMonth >= MONTH_LISTS_MAX) throw ApiException.badRequest('MONTH_LISTS_LIMIT', { max: MONTH_LISTS_MAX });
  }

  async get(userId: string, id: string) {
    const plan = await this.ownedOrThrow(userId, id);
    const flows = await this.flowsByPlan(userId, [id], new Map([[id, plan.currency]]));
    const recent = await this.prisma.transaction.findMany({ where: { userId, planId: id }, include: txInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 30 });
    return { ...this.planDto(plan, flows.get(id), true), transactions: recent.map(toTransactionDto) };
  }

  async create(userId: string, dto: CreatePlanDto, opts: { aiGenerated?: boolean } = {}) {
    if (isMonthList(dto)) await this.assertMonthLists(userId, dto.periodKey!);
    else await this.entitlements.assertLimit(userId, 'plans', await this.plansInLimit(userId));
    const items = dto.items ?? [];
    const maxItems = await this.entitlements.limit(userId, 'planItems');
    if (maxItems !== null && items.length > maxItems) await this.entitlements.assertLimit(userId, 'planItems', items.length);
    if (dto.startDate && dto.endDate && dto.endDate < dto.startDate) throw ApiException.badRequest('DATE_RANGE_INVALID');
    if (dto.currency && !isCurrency(dto.currency)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'currency', message: 'unknown' }]);
    await this.assertCategory(userId, dto.categoryId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true } });
    const plan = await this.prisma.plan.create({
      data: {
        userId,
        name: dto.name,
        type: dto.type,
        status: dto.status ?? 'PLANNING',
        description: dto.description ?? null,
        icon: dto.icon ?? PLAN_ICONS[dto.type] ?? 'map',
        color: dto.color ?? '#2D4BE0',
        budget: dto.budget ? money(dto.budget) : null,
        capital: dto.capital ? money(dto.capital) : null,
        pinnedAt: dto.pinned ? new Date() : null,
        currency: dto.currency ?? user?.currency ?? 'EUR',
        startDate: dto.startDate ? toDbDate(dto.startDate) : null,
        endDate: dto.endDate ? toDbDate(dto.endDate) : null,
        periodKey: dto.periodKey ?? null,
        categoryId: dto.categoryId ?? null,
        aiGenerated: opts.aiGenerated ?? dto.aiGenerated ?? false,
        items: {
          create: items.map((item, index) => ({
            title: item.title,
            notes: item.notes ?? null,
            quantity: item.quantity,
            ...this.pricingData(linePricing(item)),
            actualAmount: item.actualAmount != null ? money(item.actualAmount) : null,
            kind: item.kind ?? 'COST',
            dueDate: item.dueDate ? toDbDate(item.dueDate) : null,
            categoryKey: item.categoryKey ?? null,
            isDone: item.isDone ?? false,
            sortOrder: index,
          })),
        },
      },
    });
    return this.get(userId, plan.id);
  }

  async update(userId: string, id: string, dto: UpdatePlanDto) {
    const plan = await this.ownedOrThrow(userId, id);
    // O limite de planos conta os que estão em aberto e não são listas do mês:
    // verifica-se quando o plano passa a contar (reabrir, ou tirar-lhe o mês/categoria).
    const open = (status: string) => (ACTIVE as readonly string[]).includes(status);
    const after = {
      periodKey: dto.periodKey !== undefined ? dto.periodKey : plan.periodKey,
      categoryId: dto.categoryId !== undefined ? dto.categoryId : plan.categoryId,
    };
    const counted = open(plan.status) && !isMonthList(plan);
    if (open(dto.status ?? plan.status) && !isMonthList(after) && !counted) {
      await this.entitlements.assertLimit(userId, 'plans', await this.plansInLimit(userId));
    }
    if (isMonthList(after) && (!isMonthList(plan) || after.periodKey !== plan.periodKey)) await this.assertMonthLists(userId, after.periodKey!);
    const start = dto.startDate !== undefined ? dto.startDate : fromDbDateOrNull(plan.startDate);
    const end = dto.endDate !== undefined ? dto.endDate : fromDbDateOrNull(plan.endDate);
    if (start && end && end < start) throw ApiException.badRequest('DATE_RANGE_INVALID');
    if (dto.categoryId) await this.assertCategory(userId, dto.categoryId);
    await this.prisma.plan.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.budget !== undefined ? { budget: dto.budget === null ? null : money(dto.budget) } : {}),
        ...(dto.capital !== undefined ? { capital: dto.capital === null ? null : money(dto.capital) } : {}),
        ...(dto.pinned !== undefined ? { pinnedAt: dto.pinned ? (plan.pinnedAt ?? new Date()) : null } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.startDate !== undefined ? { startDate: dto.startDate ? toDbDate(dto.startDate) : null } : {}),
        ...(dto.endDate !== undefined ? { endDate: dto.endDate ? toDbDate(dto.endDate) : null } : {}),
        ...(dto.periodKey !== undefined ? { periodKey: dto.periodKey } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
      },
    });
    return this.get(userId, id);
  }

  async remove(userId: string, id: string) {
    await this.ownedOrThrow(userId, id);
    await this.prisma.plan.delete({ where: { id } });
    return { deleted: true };
  }

  async addItem(userId: string, id: string, dto: PlanItemDto) {
    const plan = await this.ownedOrThrow(userId, id);
    await this.entitlements.assertLimit(userId, 'planItems', plan.items.length);
    const last = plan.items.reduce((max, i) => Math.max(max, i.sortOrder), -1);
    await this.prisma.planItem.create({
      data: {
        planId: id,
        title: dto.title,
        notes: dto.notes ?? null,
        quantity: dto.quantity,
        ...this.pricingData(linePricing(dto)),
        actualAmount: dto.actualAmount != null ? money(dto.actualAmount) : null,
        kind: dto.kind ?? 'COST',
        dueDate: dto.dueDate ? toDbDate(dto.dueDate) : null,
        categoryKey: dto.categoryKey ?? null,
        isDone: dto.isDone ?? false,
        sortOrder: last + 1,
      },
    });
    return this.get(userId, id);
  }

  private async itemOrThrow(userId: string, planId: string, itemId: string) {
    const item = await this.prisma.planItem.findFirst({ where: { id: itemId, planId, plan: { userId } } });
    if (!item) throw ApiException.notFound('PLAN_ITEM_NOT_FOUND');
    return item;
  }

  async updateItem(userId: string, planId: string, itemId: string, dto: UpdatePlanItemDto) {
    const item = await this.itemOrThrow(userId, planId, itemId);
    // Preço: dar o preço por unidade manda no total; dar só o total apaga o
    // preço por unidade; mudar só a quantidade refaz o total pelo preço que havia.
    const quantity = dto.quantity ?? item.quantity;
    let pricing: { unitPrice: number | null; estimatedAmount: number | null } | null = null;
    if (dto.unitPrice !== undefined) {
      pricing = linePricing({ quantity, unitPrice: dto.unitPrice, estimatedAmount: dto.estimatedAmount !== undefined ? dto.estimatedAmount : numOrNull(item.estimatedAmount) });
    } else if (dto.estimatedAmount !== undefined) {
      pricing = linePricing({ quantity, unitPrice: null, estimatedAmount: dto.estimatedAmount });
    } else if (dto.quantity !== undefined && item.unitPrice !== null) {
      pricing = linePricing({ quantity, unitPrice: num(item.unitPrice) });
    }
    await this.prisma.planItem.update({
      where: { id: itemId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
        ...(pricing ? this.pricingData(pricing) : {}),
        ...(dto.actualAmount !== undefined ? { actualAmount: dto.actualAmount === null ? null : money(dto.actualAmount) } : {}),
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(dto.dueDate !== undefined ? { dueDate: dto.dueDate ? toDbDate(dto.dueDate) : null } : {}),
        ...(dto.categoryKey !== undefined ? { categoryKey: dto.categoryKey } : {}),
        ...(dto.isDone !== undefined ? { isDone: dto.isDone } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
    return this.get(userId, planId);
  }

  async removeItem(userId: string, planId: string, itemId: string) {
    await this.itemOrThrow(userId, planId, itemId);
    await this.prisma.planItem.delete({ where: { id: itemId } });
    return this.get(userId, planId);
  }

  /// "Paguei este item": cria a despesa (ligada ao plano) e marca como feito.
  async payItem(userId: string, planId: string, itemId: string, dto: PayItemDto) {
    const plan = await this.ownedOrThrow(userId, planId);
    const item = await this.itemOrThrow(userId, planId, itemId);
    const amount = dto.amount ?? num(item.estimatedAmount);
    if (!amount || amount <= 0) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'amount', message: 'required' }]);
    let categoryId = dto.categoryId ?? null;
    if (!categoryId && item.categoryKey) {
      const category = await this.prisma.category.findFirst({ where: { userId, key: item.categoryKey, type: 'EXPENSE' }, select: { id: true } });
      categoryId = category?.id ?? null;
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    const tx = await this.transactions.create(userId, {
      type: 'EXPENSE',
      amount,
      accountId: dto.accountId,
      categoryId,
      date: dto.date ?? todayIn(user?.timezone ?? 'UTC'),
      description: item.title,
      planId: plan.id,
    });
    await this.prisma.planItem.update({ where: { id: itemId }, data: { isDone: true, transactionId: tx.id, actualAmount: money(amount) } });
    return this.get(userId, planId);
  }

  /// "Fiz as compras" (listas de compras): guarda quanto custou cada item,
  /// marca-os como feitos e cria UMA despesa com o total — para comparar o
  /// que se planeou gastar com o que se gastou de facto.
  async checkout(userId: string, planId: string, dto: CheckoutDto) {
    const plan = await this.ownedOrThrow(userId, planId);
    const byId = new Map(plan.items.map((i) => [i.id, i]));
    for (const entry of dto.items ?? []) {
      if (!byId.has(entry.itemId)) throw ApiException.notFound('PLAN_ITEM_NOT_FOUND');
    }
    if (dto.items?.length) {
      await this.prisma.$transaction(
        dto.items.map((entry) => this.prisma.planItem.update({ where: { id: entry.itemId }, data: { actualAmount: money(entry.actualAmount), isDone: true } })),
      );
    }
    const items = await this.prisma.planItem.findMany({ where: { planId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    // Entram na despesa os itens feitos que ainda não têm movimento.
    const unpaid = items.filter((i) => i.isDone && !i.transactionId && i.kind !== 'REVENUE' && i.kind !== 'RESERVE');
    const total = dto.total ?? round2(unpaid.reduce((acc, i) => acc + num(i.actualAmount ?? i.estimatedAmount), 0));
    if (!total || total <= 0) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'total', message: 'required' }]);

    let categoryId = dto.categoryId ?? null;
    if (!categoryId) {
      // A categoria mais comum entre os itens (ou "Compras" numa lista de compras).
      const counts = new Map<string, number>();
      for (const i of unpaid) if (i.categoryKey) counts.set(i.categoryKey, (counts.get(i.categoryKey) ?? 0) + 1);
      const key = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (plan.type === 'SHOPPING' ? 'shopping' : null);
      if (key) categoryId = (await this.prisma.category.findFirst({ where: { userId, key, type: 'EXPENSE' }, select: { id: true } }))?.id ?? null;
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    const tx = await this.transactions.create(userId, {
      type: 'EXPENSE',
      amount: total,
      accountId: dto.accountId,
      categoryId,
      date: dto.date ?? todayIn(user?.timezone ?? 'UTC'),
      description: dto.description ?? plan.name,
      planId: plan.id,
      // Os itens da lista ficam no movimento (como num recibo lido).
      items: unpaid.slice(0, 80).map((i) => ({ name: i.title, quantity: i.quantity, price: numOrNull(i.actualAmount ?? i.estimatedAmount) })),
    });
    if (unpaid.length) await this.prisma.planItem.updateMany({ where: { id: { in: unpaid.map((i) => i.id) } }, data: { transactionId: tx.id } });
    // Fechar a lista: fica como concluída (o total pago fica no movimento; o estimado nos itens).
    if (dto.close) await this.prisma.plan.update({ where: { id: planId }, data: { status: 'DONE' } });
    return this.get(userId, planId);
  }

  /// Duplicar um plano (ex.: a lista de compras da semana) — `periodKey`
  /// põe a cópia logo noutro mês; sem ele, fica no mesmo mês do original.
  async duplicate(userId: string, id: string, periodKey?: string | null) {
    const plan = await this.ownedOrThrow(userId, id);
    return this.create(userId, {
      name: plan.name,
      type: plan.type,
      periodKey: periodKey !== undefined ? periodKey : plan.periodKey,
      categoryId: plan.categoryId,
      description: plan.description,
      icon: plan.icon,
      color: plan.color,
      budget: numOrNull(plan.budget),
      capital: numOrNull(plan.capital),
      currency: plan.currency,
      items: plan.items
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((i) => ({ title: i.title, notes: i.notes, quantity: i.quantity, unitPrice: numOrNull(i.unitPrice), estimatedAmount: numOrNull(i.estimatedAmount), kind: i.kind as ItemKind, categoryKey: i.categoryKey, isDone: false })),
    });
  }

  dateOf(d: Date) {
    return fromDbDate(d);
  }
}
