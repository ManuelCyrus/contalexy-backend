import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LocksService } from '../billing/locks.service';
import { ApiException } from '../common/errors/api.exception';
import { categoryName } from '../common/i18n/messages';
import { toCategoryDto } from '../categories/categories.service';
import { addDays, addMonths, daysBetween, financialMonth, financialMonthByKey, fromDbDate, isMonthKey, Period, todayIn, toDbDate } from '../common/utils/dates';
import { formatMoney, money, num, round2 } from '../common/utils/money';
import { Category } from '../generated/prisma/client';
import { MonthlyPlanDto, MonthlyPlanLineFlagsDto } from './monthly-plans.dto';

export type LineStatus = 'OK' | 'WARNING' | 'EXCEEDED';

/// Estado de uma linha: até 80% está bem, depois avisa, acima de 100% passou.
export function lineStatus(planned: number, actual: number): LineStatus {
  if (planned <= 0) return actual > 0 ? 'EXCEEDED' : 'OK';
  const percent = (actual / planned) * 100;
  if (percent > 100) return 'EXCEEDED';
  if (percent >= 80) return 'WARNING';
  return 'OK';
}

/// Categorias onde uma lista "o que vou comprar" não faz sentido à partida
/// (mensalidades, passes e combustível): a pessoa pode ligá-la se quiser.
const NO_LIST_KEYS = new Set(['subscriptions', 'transport']);

/// Uma linha do plano tem "o que vou comprar"? Vale a escolha da pessoa; sem
/// escolha, decide-se pela categoria.
export function lineHasList(choice: boolean | null, category: { key: string | null } | null | undefined): boolean {
  if (choice !== null) return choice;
  if (!category) return false;
  return !(category.key && NO_LIST_KEYS.has(category.key));
}

/// Arredonda para cima para um número "redondo" (sugestões do plano).
export function roundUpNice(value: number): number {
  if (value <= 0) return 0;
  const step = value < 50 ? 5 : value < 500 ? 10 : value < 5000 ? 50 : 100;
  return Math.ceil(value / step) * step;
}

/// Plano mensal: rendimento − despesas previstas − objetivos = dinheiro
/// livre; e durante o mês, o planeado contra o que aconteceu de facto.
@Injectable()
export class MonthlyPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exchange: ExchangeService,
    private readonly notifications: NotificationsService,
    private readonly locks: LocksService,
  ) {}

  private async settings(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true, timezone: true, monthStartDay: true } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    return { ...user, today: todayIn(user.timezone) };
  }

  private period(key: string, monthStartDay: number): Period {
    if (!isMonthKey(key)) throw ApiException.badRequest('INVALID_REQUEST');
    return financialMonthByKey(key, monthStartDay);
  }

  /// Planeia-se o mês que está a correr e os que aí vêm (até dois anos).
  /// Um mês que já acabou fica fechado: vê-se, mas não se mexe.
  private assertPlannable(period: Period, today: string) {
    if (today > period.end) throw ApiException.badRequest('MONTHLY_PLAN_CLOSED');
    if (period.start > addMonths(today, 24)) throw ApiException.badRequest('MONTHLY_PLAN_TOO_FAR');
  }

  /// Receitas e despesas reais de um período, por categoria, na moeda principal.
  private async actuals(userId: string, period: Period, currency: string) {
    const rows = await this.prisma.transaction.groupBy({
      by: ['type', 'categoryId', 'currency'],
      where: { userId, excludeFromReports: false, type: { in: ['INCOME', 'EXPENSE'] }, date: { gte: toDbDate(period.start), lte: toDbDate(period.end) } },
      _sum: { amount: true },
    });
    let income = 0;
    let expense = 0;
    const byCategory = new Map<string, number>(); // '' = sem categoria
    for (const r of rows) {
      const value = this.exchange.convert(num(r._sum.amount), r.currency, currency) ?? 0;
      if (r.type === 'INCOME') {
        income += value;
      } else {
        expense += value;
        const key = r.categoryId ?? '';
        byCategory.set(key, (byCategory.get(key) ?? 0) + value);
      }
    }
    return { income: round2(income), expense: round2(expense), byCategory };
  }

  /// O que foi posto de lado no período: dinheiro que entrou em contas de
  /// poupança/investimento + contribuições para objetivos sem conta ligada
  /// (os objetivos com conta já contam pela transferência).
  private async saved(userId: string, period: Period, currency: string) {
    const range = { gte: toDbDate(period.start), lte: toDbDate(period.end) };
    const savingsAccounts = await this.prisma.account.findMany({ where: { userId, type: { in: ['SAVINGS', 'INVESTMENT'] } }, select: { id: true, currency: true } });
    const ids = savingsAccounts.map((a) => a.id);
    let total = 0;
    if (ids.length) {
      const transfers = await this.prisma.transaction.findMany({
        where: { userId, type: 'TRANSFER', date: range, OR: [{ toAccountId: { in: ids } }, { accountId: { in: ids } }] },
        select: { amount: true, toAmount: true, currency: true, accountId: true, toAccountId: true },
      });
      const currencyOf = new Map(savingsAccounts.map((a) => [a.id, a.currency]));
      for (const t of transfers) {
        const into = t.toAccountId !== null && ids.includes(t.toAccountId);
        const outOf = ids.includes(t.accountId);
        if (into && outOf) continue; // entre poupanças: não muda nada
        if (into) total += this.exchange.convert(num(t.toAmount ?? t.amount), currencyOf.get(t.toAccountId as string) ?? t.currency, currency) ?? 0;
        else total -= this.exchange.convert(num(t.amount), t.currency, currency) ?? 0;
      }
    }
    const contributions = await this.prisma.goalContribution.findMany({
      where: { userId, date: range, goal: { accountId: null } },
      select: { amount: true, goalId: true, goal: { select: { currency: true } } },
    });
    const byGoal = new Map<string, number>();
    for (const c of contributions) {
      const value = this.exchange.convert(num(c.amount), c.goal.currency, currency) ?? 0;
      total += value;
      byGoal.set(c.goalId, (byGoal.get(c.goalId) ?? 0) + value);
    }
    // Para as linhas de objetivo interessam TODAS as contribuições (com ou sem conta).
    const linked = await this.prisma.goalContribution.findMany({
      where: { userId, date: range, goal: { accountId: { not: null } } },
      select: { amount: true, goalId: true, goal: { select: { currency: true } } },
    });
    for (const c of linked) {
      const value = this.exchange.convert(num(c.amount), c.goal.currency, currency) ?? 0;
      byGoal.set(c.goalId, (byGoal.get(c.goalId) ?? 0) + value);
    }
    return { total: round2(total), byGoal };
  }

  /// Os planos (viagem, lista de compras…) que a pessoa pôs neste mês, com o
  /// que estimam custar e o que já se gastou neles — na moeda principal.
  private async plansOf(userId: string, periodKey: string, currency: string) {
    const plans = await this.prisma.plan.findMany({
      where: { userId, periodKey, status: { not: 'CANCELLED' } },
      include: { items: { select: { estimatedAmount: true, kind: true, isDone: true } }, category: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!plans.length) return [];
    const flows = await this.prisma.transaction.groupBy({
      by: ['planId', 'currency'],
      where: { userId, planId: { in: plans.map((p) => p.id) }, type: 'EXPENSE' },
      _sum: { amount: true },
    });
    const spent = new Map<string, number>();
    for (const f of flows) {
      if (!f.planId) continue;
      spent.set(f.planId, (spent.get(f.planId) ?? 0) + (this.exchange.convert(num(f._sum.amount), f.currency, currency) ?? 0));
    }
    return plans.map((p) => {
      const costs = p.items.filter((i) => i.kind !== 'REVENUE' && i.kind !== 'RESERVE');
      const estimated = costs.reduce((acc, i) => acc + num(i.estimatedAmount), 0);
      return {
        id: p.id,
        name: p.name,
        type: p.type,
        status: p.status,
        icon: p.icon,
        color: p.color,
        categoryId: p.categoryId,
        category: p.category ? toCategoryDto(p.category) : null,
        /// O que os itens somam (ou o orçamento do plano, se não tiver itens com valor)
        estimated: round2(this.exchange.convert(estimated > 0 ? estimated : num(p.budget), p.currency, currency) ?? 0),
        spent: round2(spent.get(p.id) ?? 0),
        itemsTotal: p.items.length,
        itemsDone: p.items.filter((i) => i.isDone).length,
      };
    });
  }

  /// O plano de um mês com o planeado vs. real de cada linha.
  async get(userId: string, key: string, opts: { suggestion?: boolean } = {}) {
    const s = await this.settings(userId);
    const period = this.period(key, s.monthStartDay);
    return this.compute(userId, period, s, opts);
  }

  /// `suggestion: false` poupa as contas da sugestão a quem só quer os números.
  async current(userId: string, opts: { suggestion?: boolean } = {}) {
    const s = await this.settings(userId);
    return this.compute(userId, financialMonth(s.today, s.monthStartDay), s, opts);
  }

  private async compute(userId: string, period: Period, s: { currency: string; today: string; monthStartDay: number }, opts: { suggestion?: boolean } = {}) {
    const [plan, categories, goals, actual, saved, linkedPlans] = await Promise.all([
      this.prisma.monthlyPlan.findUnique({ where: { userId_periodKey: { userId, periodKey: period.key } }, include: { lines: { orderBy: { sortOrder: 'asc' } } } }),
      this.prisma.category.findMany({ where: { userId } }),
      this.prisma.goal.findMany({ where: { userId }, select: { id: true, name: true, icon: true, color: true, status: true } }),
      this.actuals(userId, period, s.currency),
      this.saved(userId, period, s.currency),
      this.plansOf(userId, period.key, s.currency),
    ]);
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const goalById = new Map(goals.map((g) => [g.id, g]));
    const childrenOf = (id: string) => categories.filter((c) => c.parentId === id).map((c) => c.id);
    const spentIn = (id: string) => round2([id, ...childrenOf(id)].reduce((acc, c) => acc + (actual.byCategory.get(c) ?? 0), 0));

    const totalDays = daysBetween(period.start, period.end) + 1;
    const isCurrent = s.today >= period.start && s.today <= period.end;
    const isPast = s.today > period.end;
    const elapsedDays = s.today < period.start ? 0 : Math.min(totalDays, daysBetween(period.start, s.today) + 1);
    const daysLeft = s.today > period.end ? 0 : Math.max(0, daysBetween(s.today, period.end));
    const base = {
      period: { key: period.key, start: period.start, end: period.end, isCurrent, isPast, isFuture: s.today < period.start, editable: !isPast, daysLeft, elapsedDays, totalDays },
      currency: s.currency,
      actualIncome: actual.income,
      actualExpenses: actual.expense,
      actualSaved: saved.total,
      /// Planos (viagem, lista de compras…) deste mês e quanto estimam custar
      linkedPlans,
      plansEstimated: round2(linkedPlans.reduce((acc, p) => acc + p.estimated, 0)),
    };

    if (!plan) {
      // Para um mês que já passou não se sugere nada: já não há plano a fazer.
      return { ...base, exists: false as const, plan: null, suggestion: opts.suggestion === false || isPast ? null : await this.suggest(userId, period, s, categories) };
    }

    const covered = new Set<string>();
    const lines = plan.lines.map((l) => {
      const planned = num(l.amount);
      const category = l.categoryId ? categoryById.get(l.categoryId) : undefined;
      const goal = l.goalId ? goalById.get(l.goalId) : undefined;
      let actualValue: number | null = null;
      if (category) {
        actualValue = spentIn(category.id);
        covered.add(category.id);
        for (const c of childrenOf(category.id)) covered.add(c);
      } else if (goal) {
        actualValue = round2(saved.byGoal.get(goal.id) ?? 0);
      }
      const kind = goal ? 'GOAL' : category ? 'CATEGORY' : 'CUSTOM';
      // Listas/planos deste mês que detalham esta categoria ("o que vou comprar").
      const lists = category ? linkedPlans.filter((p) => p.categoryId !== null && [category.id, ...childrenOf(category.id)].includes(p.categoryId)) : [];
      return {
        id: l.id,
        kind,
        /// A escolha da pessoa (null = automático) e o que vale: esta linha mostra "o que vou comprar"?
        list: l.list,
        canList: kind === 'CATEGORY' && lineHasList(l.list, category),
        listCount: lists.length,
        /// Quanto essas listas somam (para comparar com o planeado)
        listEstimated: lists.length ? round2(lists.reduce((acc, p) => acc + p.estimated, 0)) : null,
        categoryId: category?.id ?? null,
        category: category ? toCategoryDto(category) : null,
        goalId: goal?.id ?? null,
        goal: goal ? { id: goal.id, name: goal.name, icon: goal.icon, color: goal.color } : null,
        name: l.name,
        planned,
        /// null = linha livre (não dá para medir pelos movimentos)
        actual: actualValue,
        /// Planeado − real: positivo = ainda há margem; negativo = passou
        difference: actualValue === null ? null : round2(planned - actualValue),
        percent: actualValue === null || planned <= 0 ? null : round2((actualValue / planned) * 100),
        /// Nas linhas de objetivo "passar" é bom, por isso ficam sempre OK
        status: kind === 'CATEGORY' && actualValue !== null ? lineStatus(planned, actualValue) : ('OK' as LineStatus),
      };
    });

    // Despesas em categorias que não estão no plano.
    const unplanned: Array<{ categoryId: string | null; category: ReturnType<typeof toCategoryDto> | null; amount: number }> = [];
    for (const [categoryId, amount] of actual.byCategory) {
      if (categoryId && covered.has(categoryId)) continue;
      if (amount <= 0) continue;
      const category = categoryId ? categoryById.get(categoryId) : undefined;
      unplanned.push({ categoryId: categoryId || null, category: category ? toCategoryDto(category) : null, amount: round2(amount) });
    }
    unplanned.sort((a, b) => b.amount - a.amount);

    const spendingLines = lines.filter((l) => l.kind !== 'GOAL');
    const goalLines = lines.filter((l) => l.kind === 'GOAL');
    const plannedIncome = num(plan.plannedIncome);
    const plannedSavings = num(plan.plannedSavings);
    const plannedExpenses = round2(spendingLines.reduce((acc, l) => acc + l.planned, 0));
    const plannedGoals = round2(goalLines.reduce((acc, l) => acc + l.planned, 0));
    const spentPlanned = round2(spendingLines.reduce((acc, l) => acc + (l.actual ?? 0), 0));
    const unplannedSpent = round2(unplanned.reduce((acc, u) => acc + u.amount, 0));
    // Quanto ainda dá para gastar dentro do plano (linha a linha, sem negativos).
    const leftToSpend = round2(spendingLines.reduce((acc, l) => acc + Math.max(0, l.planned - (l.actual ?? 0)), 0));
    const over = lines.filter((l) => l.status === 'EXCEEDED');

    return {
      ...base,
      exists: true as const,
      plan: {
        id: plan.id,
        plannedIncome,
        plannedSavings,
        note: plan.note,
        plannedExpenses,
        plannedGoals,
        /// Rendimento − despesas previstas − objetivos − poupança = dinheiro livre
        plannedFree: round2(plannedIncome - plannedExpenses - plannedGoals - plannedSavings),
        spentPlanned,
        unplannedSpent,
        leftToSpend,
        /// Quanto dá para gastar por dia até ao fim do mês, dentro do plano
        dailyAllowance: isCurrent && daysLeft >= 0 ? round2(leftToSpend / Math.max(1, daysLeft + 1)) : null,
        /// Real − planeado (despesas): positivo = gastou mais do que planeou
        expenseDifference: round2(actual.expense - plannedExpenses),
        incomeDifference: round2(actual.income - plannedIncome),
        savingsDifference: round2(saved.total - (plannedSavings + plannedGoals)),
        overCount: over.length,
        status: over.length ? 'EXCEEDED' : lines.some((l) => l.status === 'WARNING') ? 'WARNING' : 'OK',
        lines,
        unplanned: unplanned.slice(0, 12),
      },
      suggestion: null,
    };
  }

  /// Ponto de partida para quem ainda não fez o plano: médias dos últimos 3
  /// meses, arredondadas, e o que os objetivos pedem por mês.
  private async suggest(userId: string, period: Period, s: { currency: string; monthStartDay: number }, categories: Category[]) {
    const months = 3;
    const from = financialMonth(addDays(period.start, -1 - 31 * (months - 1)), s.monthStartDay).start;
    const to = addDays(period.start, -1);
    const history = from <= to ? await this.actuals(userId, { start: from, end: to, key: '' }, s.currency) : { income: 0, expense: 0, byCategory: new Map<string, number>() };
    const span = Math.max(1, Math.round((daysBetween(from, to) + 1) / 30.4375));

    // Rendimento: o que se repete (salário…) ou, se não houver, a média.
    // O que está fechado (sem o plano pago) não entra na sugestão.
    const [lockedRecurring, lockedGoals] = await Promise.all([this.locks.lockedIds(userId, 'recurring'), this.locks.lockedIds(userId, 'goals')]);
    const recurring = (await this.prisma.recurringRule.findMany({ where: { userId, isActive: true, type: 'INCOME' }, include: { account: { select: { currency: true } } } })).filter((r) => !lockedRecurring.has(r.id));
    const perMonth: Record<string, number> = { DAILY: 30.4375, WEEKLY: 4.348, MONTHLY: 1, YEARLY: 1 / 12 };
    const recurringIncome = recurring.reduce((acc, r) => acc + (this.exchange.convert((num(r.amount) * perMonth[r.frequency]) / r.interval, r.account.currency, s.currency) ?? 0), 0);
    const plannedIncome = roundUpNice(recurringIncome > 0 ? recurringIncome : history.income / span);

    const byId = new Map(categories.map((c) => [c.id, c]));
    // Junta as subcategorias à categoria-mãe.
    const totals = new Map<string, number>();
    for (const [id, amount] of history.byCategory) {
      const c = id ? byId.get(id) : undefined;
      if (!c || c.archivedAt) continue;
      const top = c.parentId && byId.get(c.parentId) ? c.parentId : c.id;
      totals.set(top, (totals.get(top) ?? 0) + amount);
    }
    const lines = [...totals.entries()]
      .map(([id, total]) => ({ category: byId.get(id) as Category, amount: roundUpNice(total / span) }))
      .filter((l) => l.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10)
      .map((l) => ({ kind: 'CATEGORY', categoryId: l.category.id, category: toCategoryDto(l.category), goalId: null, goal: null, name: null, planned: l.amount }));

    const goals = (await this.prisma.goal.findMany({ where: { userId, status: 'ACTIVE' }, include: { contributions: true } })).filter((g) => !lockedGoals.has(g.id));
    const goalLines = goals
      .map((g) => {
        const saved = g.contributions.reduce((acc, c) => acc + num(c.amount), 0);
        const remaining = Math.max(0, num(g.targetAmount) - saved);
        if (remaining <= 0) return null;
        const monthsLeft = g.targetDate ? Math.max(1, Math.ceil(daysBetween(period.start, fromDbDate(g.targetDate)) / 30.4375)) : 12;
        const monthly = this.exchange.convert(remaining / monthsLeft, g.currency, s.currency) ?? 0;
        return { kind: 'GOAL', categoryId: null, category: null, goalId: g.id, goal: { id: g.id, name: g.name, icon: g.icon, color: g.color }, name: null, planned: roundUpNice(monthly) };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null && l.planned > 0);

    return { basedOnMonths: history.expense > 0 ? span : 0, plannedIncome, plannedSavings: 0, lines: [...lines, ...goalLines] };
  }

  async save(userId: string, key: string, dto: MonthlyPlanDto) {
    const s = await this.settings(userId);
    const period = this.period(key, s.monthStartDay);
    this.assertPlannable(period, s.today);
    // Só categorias de despesa e objetivos da própria pessoa.
    const categoryIds = [...new Set(dto.lines.map((l) => l.categoryId).filter((x): x is string => !!x))];
    const goalIds = [...new Set(dto.lines.map((l) => l.goalId).filter((x): x is string => !!x))];
    if (categoryIds.length) {
      const found = await this.prisma.category.count({ where: { userId, id: { in: categoryIds }, type: 'EXPENSE' } });
      if (found !== categoryIds.length) throw ApiException.notFound('CATEGORY_NOT_FOUND');
    }
    if (goalIds.length) {
      const found = await this.prisma.goal.count({ where: { userId, id: { in: goalIds } } });
      if (found !== goalIds.length) throw ApiException.notFound('GOAL_NOT_FOUND');
    }
    const seen = new Set<string>();
    for (const l of dto.lines) {
      const k = l.goalId ? `g:${l.goalId}` : l.categoryId ? `c:${l.categoryId}` : null;
      if (!k) continue;
      if (seen.has(k)) throw ApiException.badRequest('MONTHLY_PLAN_DUPLICATE_LINE');
      seen.add(k);
    }
    // Uma linha que já avisou "passaste o planeado" não volta a avisar este
    // mês — a não ser que se aumente o valor planeado.
    const previous = await this.prisma.monthlyPlan.findUnique({ where: { userId_periodKey: { userId, periodKey: period.key } }, include: { lines: true } });
    const alerted = new Map((previous?.lines ?? []).filter((l) => l.categoryId && l.alertedAt).map((l) => [l.categoryId as string, l]));
    // A escolha "tem / não tem o que vou comprar" de cada categoria mantém-se de um guardar para o outro.
    const listChoice = new Map((previous?.lines ?? []).filter((l) => l.categoryId).map((l) => [l.categoryId as string, l.list]));
    const lines = dto.lines.map((l, index) => {
      const categoryId = l.goalId ? null : (l.categoryId ?? null);
      const before = categoryId ? alerted.get(categoryId) : undefined;
      return {
        categoryId,
        goalId: l.goalId ?? null,
        name: l.categoryId || l.goalId ? null : (l.name ?? null),
        amount: money(l.amount),
        sortOrder: index,
        list: categoryId ? (l.list !== undefined ? l.list : (listChoice.get(categoryId) ?? null)) : null,
        alertedAt: before && l.amount <= num(before.amount) ? before.alertedAt : null,
      };
    });
    await this.prisma.$transaction(async (tx) => {
      const plan = await tx.monthlyPlan.upsert({
        where: { userId_periodKey: { userId, periodKey: period.key } },
        create: { userId, periodKey: period.key, plannedIncome: money(dto.plannedIncome), plannedSavings: money(dto.plannedSavings), note: dto.note ?? null },
        update: { plannedIncome: money(dto.plannedIncome), plannedSavings: money(dto.plannedSavings), note: dto.note ?? null },
      });
      await tx.monthlyPlanLine.deleteMany({ where: { planId: plan.id } });
      if (lines.length) await tx.monthlyPlanLine.createMany({ data: lines.map((l) => ({ ...l, planId: plan.id })) });
    });
    return this.compute(userId, period, s);
  }

  /// Depois de uma despesa: avisa (uma vez por linha e por mês) quando uma
  /// categoria passa o que estava planeado.
  async checkAlerts(userId: string, date: string) {
    const s = await this.settings(userId);
    const period = financialMonth(s.today, s.monthStartDay);
    if (date < period.start || date > period.end) return;
    const pending = await this.prisma.monthlyPlanLine.count({ where: { plan: { userId, periodKey: period.key }, categoryId: { not: null }, alertedAt: null, amount: { gt: 0 } } });
    if (!pending) return;
    const computed = await this.compute(userId, period, s, { suggestion: false });
    for (const line of computed.plan?.lines ?? []) {
      if (line.kind !== 'CATEGORY' || line.status !== 'EXCEEDED' || line.planned <= 0) continue;
      const marked = await this.prisma.monthlyPlanLine.updateMany({ where: { id: line.id, alertedAt: null }, data: { alertedAt: new Date() } });
      if (!marked.count) continue;
      const data = { periodKey: period.key, categoryId: line.categoryId, categoryKey: line.category?.key ?? null, name: line.category?.name ?? null, planned: line.planned, actual: line.actual ?? 0, currency: s.currency };
      await this.notifications.notify(userId, 'plan_line_exceeded', data, (ctx) => ({
        name: data.name ?? categoryName(data.categoryKey, ctx.lang),
        planned: formatMoney(data.planned, data.currency, ctx.lang, ctx.country),
        actual: formatMoney(data.actual, data.currency, ctx.lang, ctx.country),
      }));
    }
  }

  /// Copia o plano do mês anterior para este (ponto de partida rápido).
  async copyPrevious(userId: string, key: string) {
    const s = await this.settings(userId);
    const period = this.period(key, s.monthStartDay);
    return this.copyFrom(userId, key, financialMonth(addDays(period.start, -1), s.monthStartDay).key);
  }

  /// Reutilizar um plano antigo (de qualquer mês, mesmo de há anos): fica
  /// como o plano do mês `key`, com os valores planeados de então.
  async copyFrom(userId: string, key: string, sourceKey: string) {
    const s = await this.settings(userId);
    const period = this.period(key, s.monthStartDay);
    this.assertPlannable(period, s.today);
    if (!isMonthKey(sourceKey) || sourceKey === period.key) throw ApiException.badRequest('INVALID_REQUEST');
    const source = await this.prisma.monthlyPlan.findUnique({ where: { userId_periodKey: { userId, periodKey: sourceKey } }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
    if (!source) throw ApiException.notFound('MONTHLY_PLAN_NOT_FOUND');
    // Categorias/objetivos que entretanto foram apagados ficam de fora.
    const [categories, goals] = await Promise.all([
      this.prisma.category.findMany({ where: { userId, type: 'EXPENSE' }, select: { id: true } }),
      this.prisma.goal.findMany({ where: { userId, status: 'ACTIVE' }, select: { id: true } }),
    ]);
    const okCategory = new Set(categories.map((c) => c.id));
    const okGoal = new Set(goals.map((g) => g.id));
    return this.save(userId, key, {
      plannedIncome: num(source.plannedIncome),
      plannedSavings: num(source.plannedSavings),
      note: source.note,
      lines: source.lines
        .filter((l) => (l.categoryId ? okCategory.has(l.categoryId) : l.goalId ? okGoal.has(l.goalId) : true))
        .map((l) => ({ categoryId: l.categoryId, goalId: l.goalId, name: l.name, amount: num(l.amount), list: l.list })),
    });
  }

  /// A pessoa escolhe se uma linha tem "o que vou comprar" (null = volta ao automático).
  async setLineFlags(userId: string, key: string, lineId: string, dto: MonthlyPlanLineFlagsDto) {
    const s = await this.settings(userId);
    const period = this.period(key, s.monthStartDay);
    const result = await this.prisma.monthlyPlanLine.updateMany({ where: { id: lineId, categoryId: { not: null }, plan: { userId, periodKey: period.key } }, data: { list: dto.list } });
    if (!result.count) throw ApiException.notFound('MONTHLY_PLAN_NOT_FOUND');
    return this.compute(userId, period, s, { suggestion: false });
  }

  async remove(userId: string, key: string) {
    const s = await this.settings(userId);
    // Um mês fechado fica no histórico.
    if (s.today > this.period(key, s.monthStartDay).end) throw ApiException.badRequest('MONTHLY_PLAN_CLOSED');
    const result = await this.prisma.monthlyPlan.deleteMany({ where: { userId, periodKey: key } });
    if (!result.count) throw ApiException.notFound('MONTHLY_PLAN_NOT_FOUND');
    return { deleted: true };
  }

  /// Meses com plano (os mais recentes primeiro), com o planeado vs. real.
  async history(userId: string, limit = 12) {
    const s = await this.settings(userId);
    const plans = await this.prisma.monthlyPlan.findMany({ where: { userId }, include: { lines: true }, orderBy: { periodKey: 'desc' }, take: Math.min(Math.max(limit, 1), 120) });
    const out = [];
    for (const p of plans) {
      const period = financialMonthByKey(p.periodKey, s.monthStartDay);
      const actual = await this.actuals(userId, period, s.currency);
      const plannedExpenses = round2(p.lines.filter((l) => !l.goalId).reduce((acc, l) => acc + num(l.amount), 0));
      out.push({
        key: p.periodKey,
        start: period.start,
        end: period.end,
        plannedIncome: num(p.plannedIncome),
        actualIncome: actual.income,
        linesCount: p.lines.length,
        /// O mês já acabou (um plano antigo: pode reutilizar-se ou enviar-se a alguém)
        isPast: s.today > period.end,
        plannedExpenses,
        actualExpenses: actual.expense,
        difference: round2(actual.expense - plannedExpenses),
      });
    }
    return { currency: s.currency, items: out };
  }
}
