import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { LocksService } from '../billing/locks.service';
import { AccountsService } from '../accounts/accounts.service';
import { BalancesService } from '../accounts/balances.service';
import { BudgetsService } from '../budgets/budgets.service';
import { TransactionsService, txInclude, toTransactionDto } from '../transactions/transactions.service';
import { RecurringService } from '../recurring/recurring.service';
import { GoalsService } from '../goals/goals.service';
import { GoalDepositsService } from '../goals/goal-deposits.service';
import { PlansService } from '../plans/plans.service';
import { LoansService } from '../loans/loans.service';
import { MonthlyPlansService } from '../monthly-plans/monthly-plans.service';
import { ApiException } from '../common/errors/api.exception';
import { FEATURES } from '../billing/plans.catalog';
import {
  addDays, addMonths, daysBetween, endOfMonth, financialMonth, fromDbDate, monthKey, monthsBetween, startOfMonth, todayIn, toDbDate,
} from '../common/utils/dates';
import { num, round2 } from '../common/utils/money';
import { computeBalances } from '../spaces/split';
import { DailyLimitService } from '../daily-limit/daily-limit.service';

const LIQUID = ['BANK', 'CASH', 'DIGITAL_WALLET', 'OTHER'];
const SAVINGS = ['SAVINGS', 'INVESTMENT'];

export interface Insight {
  type: string;
  /// positive | negative | neutral | warning
  tone: string;
  params: Record<string, unknown>;
}

/// Painel inicial, relatórios e calendário. Tudo calculado no servidor (a
/// app só desenha), na moeda principal da pessoa.
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exchange: ExchangeService,
    private readonly entitlements: EntitlementsService,
    private readonly accounts: AccountsService,
    private readonly balances: BalancesService,
    private readonly budgets: BudgetsService,
    private readonly transactions: TransactionsService,
    private readonly recurring: RecurringService,
    private readonly goals: GoalsService,
    private readonly goalDeposits: GoalDepositsService,
    private readonly plans: PlansService,
    private readonly loans: LoansService,
    private readonly monthlyPlans: MonthlyPlansService,
    private readonly locks: LocksService,
    private readonly dailyLimit: DailyLimitService,
  ) {}

  private async settings(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { currency: true, timezone: true, monthStartDay: true, weekStartsOn: true, language: true, country: true },
    });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    return user;
  }

  // ------------------------------------------------------------------
  // Painel inicial
  // ------------------------------------------------------------------

  async dashboard(userId: string) {
    const s = await this.settings(userId);
    const main = s.currency;
    const today = todayIn(s.timezone);
    const period = financialMonth(today, s.monthStartDay);
    const daysLeft = daysBetween(today, period.end) + 1;
    const elapsedDays = daysBetween(period.start, today) + 1;

    const [accountList, month, previous, budgets, upcoming, goals, plans, recent, spaces, loans, monthPlan, pendingShares, daily] = await Promise.all([
      this.accounts.list(userId),
      this.transactions.summary(userId, { from: period.start, to: today }),
      // Mesmo número de dias do período anterior (comparação justa).
      (() => {
        const prev = financialMonth(addDays(period.start, -1), s.monthStartDay);
        return this.transactions.summary(userId, { from: prev.start, to: addDays(prev.start, elapsedDays - 1) });
      })(),
      this.budgets.list(userId, today),
      this.recurring.upcoming(userId, 14),
      this.goals.list(userId),
      this.plans.list(userId, 'active'),
      this.prisma.transaction.findMany({ where: { userId }, include: txInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 8 }),
      this.spacesSummary(userId),
      this.loans.summary(userId),
      this.monthlyPlans.current(userId, { suggestion: false }),
      this.prisma.sharedAccess.count({ where: { viewerId: userId, status: 'PENDING' } }),
      this.dailyLimit.get(userId),
    ]);

    // Saldos por tipo de conta (na moeda principal).
    let available = 0;
    let savings = 0;
    let creditDebt = 0;
    for (const a of accountList.accounts) {
      if (a.archived || !a.includeInTotal) continue;
      const value = a.convertedBalance ?? 0;
      if (LIQUID.includes(a.type)) available += value;
      else if (SAVINGS.includes(a.type)) savings += value;
      else if (a.type === 'CREDIT_CARD' && value < 0) creditDebt += value;
    }

    // Contas a pagar até ao fim do período.
    const upcomingUntilEnd = (await this.recurring.upcoming(userId, Math.max(daysLeft, 1))).items.filter((i) => i.type === 'EXPENSE' && i.date <= period.end);
    let billsUntilEnd = 0;
    for (const i of upcomingUntilEnd) billsUntilEnd += this.exchange.convert(i.amount, i.currency, main) ?? 0;

    const globalBudget = budgets.find((b) => b.isActive && b.categoryIds.length === 0 && b.period === 'MONTHLY');
    let base = available - billsUntilEnd;
    let basis = 'balance';
    if (globalBudget) {
      const remaining = this.exchange.convert(globalBudget.remaining, globalBudget.currency, main) ?? globalBudget.remaining;
      if (remaining < base) {
        base = remaining;
        basis = 'budget';
      }
    }
    // Com plano do mês, o que ainda dá para gastar é o que falta do plano.
    if (monthPlan.plan && monthPlan.plan.plannedExpenses > 0 && monthPlan.plan.leftToSpend < base) {
      base = monthPlan.plan.leftToSpend;
      basis = 'plan';
    }
    const perDay = round2(Math.max(0, base) / Math.max(daysLeft, 1));

    const activeBudgets = budgets.filter((b) => b.isActive);
    let budgetTotal = 0;
    let budgetSpent = 0;
    for (const b of activeBudgets.filter((x) => x.period === 'MONTHLY')) {
      // Um orçamento geral já inclui os de categoria — não somar duas vezes.
      if (globalBudget && b.id !== globalBudget.id) continue;
      budgetTotal += this.exchange.convert(b.available, b.currency, main) ?? 0;
      budgetSpent += this.exchange.convert(b.spent, b.currency, main) ?? 0;
    }

    const expenseChange = previous.expense > 0 ? round2(((month.expense - previous.expense) / previous.expense) * 100) : null;
    const savingsRate = month.income > 0 ? round2(((month.income - month.expense) / month.income) * 100) : null;

    const insights = this.insights({
      month,
      expenseChange,
      savingsRate,
      budgets: activeBudgets,
      upcoming: upcoming.items,
      goals,
      lastTransactionDate: recent[0] ? fromDbDate(recent[0].date) : null,
      today,
      loans,
      monthPlan,
    });

    return {
      currency: main,
      today,
      period: { start: period.start, end: period.end, key: period.key, daysLeft, elapsedDays },
      balances: {
        total: accountList.total,
        available: round2(available),
        savings: round2(savings),
        creditDebt: round2(creditDebt),
        unconverted: accountList.unconverted,
        accounts: accountList.accounts.filter((a) => !a.archived).slice(0, 8),
      },
      month: {
        income: month.income,
        expense: month.expense,
        net: month.net,
        savingsRate,
        previousExpense: previous.expense,
        expenseChange,
        topCategories: month.expenseByCategory.slice(0, 5),
      },
      budgets: {
        count: activeBudgets.length,
        total: round2(budgetTotal),
        spent: round2(budgetSpent),
        remaining: round2(budgetTotal - budgetSpent),
        items: [...activeBudgets].sort((a, b) => b.percent - a.percent).slice(0, 3),
      },
      safeToSpend: { perDay, total: round2(Math.max(0, base)), basis, billsUntilEnd: round2(billsUntilEnd) },
      upcoming: { items: upcoming.items.slice(0, 5), totalExpenses: upcoming.totalExpenses, totalIncome: upcoming.totalIncome },
      goals: goals.filter((g) => g.status === 'ACTIVE').slice(0, 3),
      plans: plans.slice(0, 3),
      recent: recent.map(toTransactionDto),
      spaces,
      /// Plano do mês: planeado vs. real em poucas linhas
      monthlyPlan: monthPlan.plan
        ? {
            exists: true,
            key: monthPlan.period.key,
            status: monthPlan.plan.status,
            plannedIncome: monthPlan.plan.plannedIncome,
            plannedExpenses: monthPlan.plan.plannedExpenses,
            spent: monthPlan.actualExpenses,
            leftToSpend: monthPlan.plan.leftToSpend,
            dailyAllowance: monthPlan.plan.dailyAllowance,
            /// Quanto se planeou pôr de lado este mês (poupança + objetivos)
            plannedSavings: round2(monthPlan.plan.plannedSavings + monthPlan.plan.plannedGoals),
            saved: monthPlan.actualSaved,
            overCount: monthPlan.plan.overCount,
          }
        : { exists: false, key: monthPlan.period.key, spent: monthPlan.actualExpenses, saved: monthPlan.actualSaved },
      /// Limite de hoje: quanto se pode gastar, quanto já foi e quanto falta (limit null = sem limite)
      dailyLimit: daily,
      /// Empréstimos em aberto: o que me devem e o que devo
      loans,
      /// Convites para acompanhar os gastos de alguém, à espera de resposta
      sharing: { pendingReceived: pendingShares },
      insights,
    };
  }

  private async spacesSummary(userId: string) {
    const memberships = await this.prisma.spaceMember.findMany({ where: { userId, space: { archivedAt: null } }, select: { spaceId: true, space: { select: { currency: true } } } });
    const s = await this.settings(userId);
    let owedToMe = 0;
    let iOwe = 0;
    for (const m of memberships) {
      const [expenses, settlements] = await Promise.all([
        this.prisma.spaceExpense.findMany({ where: { spaceId: m.spaceId }, select: { paidById: true, amount: true, shares: { select: { userId: true, amount: true } } } }),
        this.prisma.spaceSettlement.findMany({ where: { spaceId: m.spaceId }, select: { fromUserId: true, toUserId: true, amount: true } }),
      ]);
      const net = computeBalances(expenses, settlements).find((b) => b.userId === userId)?.net ?? 0;
      const converted = this.exchange.convert(net, m.space.currency, s.currency) ?? 0;
      if (converted > 0) owedToMe += converted;
      else iOwe += -converted;
    }
    return { count: memberships.length, owedToMe: round2(owedToMe), iOwe: round2(iOwe) };
  }

  /// Frases curtas e úteis (a app traduz pelo `type`).
  private insights(input: {
    month: Awaited<ReturnType<TransactionsService['summary']>>;
    expenseChange: number | null;
    savingsRate: number | null;
    budgets: Awaited<ReturnType<BudgetsService['list']>>;
    upcoming: Awaited<ReturnType<RecurringService['upcoming']>>['items'];
    goals: Awaited<ReturnType<GoalsService['list']>>;
    lastTransactionDate: string | null;
    today: string;
    loans: Awaited<ReturnType<LoansService['summary']>>;
    monthPlan: Awaited<ReturnType<MonthlyPlansService['current']>>;
  }): Insight[] {
    const out: Insight[] = [];
    // Um empréstimo que vence nos próximos 3 dias (ou já passou da data).
    const due = input.loans.nextDue;
    if (due && due.daysUntilDue !== null && due.daysUntilDue <= 3) {
      out.push({
        type: due.direction === 'LENT' ? 'loan_to_receive' : 'loan_to_pay',
        tone: due.daysUntilDue < 0 ? 'negative' : 'warning',
        params: { loanId: due.loanId, person: due.personName, amount: due.remaining, currency: due.currency, days: due.daysUntilDue, dueDate: due.dueDate },
      });
    }
    const overLine = input.monthPlan.plan?.lines.find((l) => l.status === 'EXCEEDED');
    if (overLine) {
      out.push({
        type: 'plan_exceeded',
        tone: 'warning',
        params: { count: input.monthPlan.plan?.overCount ?? 1, categoryId: overLine.categoryId, key: overLine.category?.key ?? null, name: overLine.category?.name ?? overLine.name, planned: overLine.planned, actual: overLine.actual },
      });
    }
    const exceeded = input.budgets.filter((b) => b.status === 'EXCEEDED');
    const warning = input.budgets.filter((b) => b.status === 'WARNING');
    for (const b of exceeded.slice(0, 1)) out.push({ type: 'budget_exceeded', tone: 'negative', params: { budgetId: b.id, name: b.name, percent: Math.round(b.percent) } });
    for (const b of warning.slice(0, 1)) out.push({ type: 'budget_warning', tone: 'warning', params: { budgetId: b.id, name: b.name, percent: Math.round(b.percent), dailyAllowance: b.dailyAllowance, currency: b.currency } });

    const big = input.upcoming.find((u) => u.type === 'EXPENSE' && u.daysUntil >= 0 && u.daysUntil <= 3);
    if (big) out.push({ type: 'upcoming_payment', tone: 'neutral', params: { description: big.description, amount: big.amount, currency: big.currency, days: big.daysUntil } });

    if (input.expenseChange !== null && Math.abs(input.expenseChange) >= 10 && input.month.expense > 0) {
      out.push({ type: input.expenseChange > 0 ? 'spending_up' : 'spending_down', tone: input.expenseChange > 0 ? 'warning' : 'positive', params: { percent: Math.abs(Math.round(input.expenseChange)) } });
    }
    const top = input.month.expenseByCategory[0];
    if (top && top.percent >= 25 && input.month.expense > 0) {
      out.push({ type: 'top_category', tone: 'neutral', params: { categoryId: top.categoryId, key: top.category?.key ?? null, name: top.category?.name ?? null, percent: Math.round(top.percent) } });
    }
    if (input.savingsRate !== null && input.month.income > 0) {
      out.push({ type: input.savingsRate >= 20 ? 'savings_good' : input.savingsRate < 0 ? 'savings_negative' : 'savings_rate', tone: input.savingsRate >= 20 ? 'positive' : input.savingsRate < 0 ? 'negative' : 'neutral', params: { percent: Math.round(input.savingsRate) } });
    }
    const behind = input.goals.find((g) => g.status === 'ACTIVE' && g.onTrack === false);
    if (behind) out.push({ type: 'goal_behind', tone: 'warning', params: { goalId: behind.id, name: behind.name, monthlyNeeded: behind.monthlyNeeded, currency: behind.currency } });
    if (!input.lastTransactionDate || daysBetween(input.lastTransactionDate, input.today) >= 3) {
      out.push({ type: 'log_reminder', tone: 'neutral', params: { days: input.lastTransactionDate ? daysBetween(input.lastTransactionDate, input.today) : null } });
    }
    // Ainda sem plano para este mês (só uma sugestão, no fim da lista).
    if (!input.monthPlan.plan && input.month.count > 0) out.push({ type: 'no_monthly_plan', tone: 'neutral', params: { key: input.monthPlan.period.key } });
    return out.slice(0, 5);
  }

  // ------------------------------------------------------------------
  // Relatórios
  // ------------------------------------------------------------------

  /// No plano grátis os relatórios vão até X meses para trás.
  private async assertReportRange(userId: string, from: string, today: string) {
    const ent = await this.entitlements.forUser(userId);
    if (ent.features.includes(FEATURES.reportsAdvanced)) return;
    const months = ent.limits.reportMonths;
    if (months === null) return;
    const oldest = startOfMonth(addMonths(today, -(months - 1), 1));
    if (from < oldest) {
      throw ApiException.forbidden('REPORT_RANGE_LIMIT', { months }, { feature: FEATURES.reportsAdvanced, requiredPlan: await this.entitlements.lowestPlanWith(FEATURES.reportsAdvanced) });
    }
  }

  async overview(userId: string, from?: string, to?: string) {
    const s = await this.settings(userId);
    const today = todayIn(s.timezone);
    const period = financialMonth(today, s.monthStartDay);
    const start = from ?? period.start;
    const end = to ?? (from ? today : period.end);
    if (end < start) throw ApiException.badRequest('DATE_RANGE_INVALID');
    await this.assertReportRange(userId, start, today);
    const length = daysBetween(start, end) + 1;
    const prevEnd = addDays(start, -1);
    const prevStart = addDays(prevEnd, -(length - 1));
    const [current, previous] = await Promise.all([
      this.transactions.summary(userId, { from: start, to: end }),
      this.transactions.summary(userId, { from: prevStart, to: prevEnd }),
    ]);
    const change = (a: number, b: number) => (b > 0 ? round2(((a - b) / b) * 100) : null);
    // Comparação por categoria com o período anterior.
    const prevByCat = new Map(previous.expenseByCategory.map((c) => [c.categoryId ?? 'none', c.amount]));
    return {
      from: start,
      to: end,
      days: length,
      ...current,
      savingsRate: current.income > 0 ? round2(((current.income - current.expense) / current.income) * 100) : null,
      previous: { from: prevStart, to: prevEnd, income: previous.income, expense: previous.expense, net: previous.net },
      changes: { income: change(current.income, previous.income), expense: change(current.expense, previous.expense) },
      expenseByCategory: current.expenseByCategory.map((c) => ({ ...c, previousAmount: prevByCat.get(c.categoryId ?? 'none') ?? 0 })),
    };
  }

  /// Receitas e despesas por mês (últimos N meses).
  async trend(userId: string, months = 6) {
    const s = await this.settings(userId);
    const today = todayIn(s.timezone);
    const ent = await this.entitlements.forUser(userId);
    const max = ent.features.includes(FEATURES.reportsAdvanced) ? 36 : Math.min(6, ent.limits.reportMonths ?? 6);
    const n = Math.min(Math.max(months, 1), max);
    const from = startOfMonth(addMonths(today, -(n - 1), 1));
    const rows = await this.prisma.$queryRaw<Array<{ month: string; type: string; currency: string; total: unknown }>>`
      SELECT to_char(date_trunc('month', "date"), 'YYYY-MM') AS month, "type"::text AS type, "currency", SUM("amount") AS total
      FROM "Transaction"
      WHERE "userId" = ${userId}
        AND "excludeFromReports" = false
        AND "type" IN ('INCOME', 'EXPENSE')
        AND "date" >= ${toDbDate(from)}
        AND "date" <= ${toDbDate(today)}
      GROUP BY 1, 2, 3
      ORDER BY 1`;
    const byMonth = new Map(monthsBetween(from, today).map((m) => [m, { month: m, income: 0, expense: 0 }]));
    for (const row of rows) {
      const entry = byMonth.get(row.month);
      if (!entry) continue;
      const value = this.exchange.convert(Number(row.total), row.currency, s.currency) ?? 0;
      if (row.type === 'INCOME') entry.income += value;
      else entry.expense += value;
    }
    const points = [...byMonth.values()].map((p) => ({ month: p.month, income: round2(p.income), expense: round2(p.expense), net: round2(p.income - p.expense) }));
    const withData = points.filter((p) => p.income || p.expense);
    const avg = (key: 'income' | 'expense') => (withData.length ? round2(withData.reduce((acc, p) => acc + p[key], 0) / withData.length) : 0);
    return { currency: s.currency, months: n, maxMonths: max, points, averageIncome: avg('income'), averageExpense: avg('expense') };
  }

  /// Património (soma das contas) no fim de cada mês — Premium para mais de 3 meses.
  async netWorth(userId: string, months = 12) {
    const s = await this.settings(userId);
    const today = todayIn(s.timezone);
    const ent = await this.entitlements.forUser(userId);
    const max = ent.features.includes(FEATURES.reportsAdvanced) ? 36 : 3;
    const n = Math.min(Math.max(months, 1), max);
    const accounts = await this.prisma.account.findMany({ where: { userId, includeInTotal: true }, select: { id: true, currency: true, type: true } });
    const ids = accounts.map((a) => a.id);
    const currencyOf = new Map(accounts.map((a) => [a.id, a.currency]));
    const typeOf = new Map(accounts.map((a) => [a.id, a.type]));
    const points: Array<{ month: string; date: string; total: number; assets: number; liabilities: number }> = [];
    for (let i = n - 1; i >= 0; i--) {
      const date = i === 0 ? today : endOfMonth(addMonths(today, -i, 1));
      const balances = await this.balances.balances(userId, ids, date);
      let assets = 0;
      let liabilities = 0;
      for (const [id, value] of balances) {
        const converted = this.exchange.convert(num(value), currencyOf.get(id) ?? s.currency, s.currency) ?? 0;
        if (converted < 0 || typeOf.get(id) === 'CREDIT_CARD') {
          if (converted < 0) liabilities += converted;
          else assets += converted;
        } else assets += converted;
      }
      points.push({ month: monthKey(date), date, total: round2(assets + liabilities), assets: round2(assets), liabilities: round2(liabilities) });
    }
    return { currency: s.currency, maxMonths: max, points };
  }

  /// Onde se gasta mais (comerciantes/descrições) — Premium.
  async merchants(userId: string, from?: string, to?: string) {
    await this.entitlements.assertFeature(userId, FEATURES.reportsAdvanced);
    const s = await this.settings(userId);
    const today = todayIn(s.timezone);
    const period = financialMonth(today, s.monthStartDay);
    const start = from ?? period.start;
    const end = to ?? today;
    const rows = await this.prisma.$queryRaw<Array<{ name: string; currency: string; total: unknown; count: bigint }>>`
      SELECT COALESCE(NULLIF(TRIM("merchant"), ''), NULLIF(TRIM("description"), ''), '') AS name, "currency", SUM("amount") AS total, COUNT(*)::bigint AS count
      FROM "Transaction"
      WHERE "userId" = ${userId} AND "type" = 'EXPENSE' AND "excludeFromReports" = false
        AND "date" >= ${toDbDate(start)} AND "date" <= ${toDbDate(end)}
      GROUP BY 1, 2`;
    const merged = new Map<string, { name: string; amount: number; count: number }>();
    for (const r of rows) {
      const key = r.name.toLowerCase();
      const entry = merged.get(key) ?? { name: r.name, amount: 0, count: 0 };
      entry.amount += this.exchange.convert(Number(r.total), r.currency, s.currency) ?? 0;
      entry.count += Number(r.count);
      merged.set(key, entry);
    }
    return {
      currency: s.currency,
      from: start,
      to: end,
      items: [...merged.values()].sort((a, b) => b.amount - a.amount).slice(0, 30).map((m) => ({ ...m, amount: round2(m.amount) })),
    };
  }

  /// Gastos por etiqueta — Premium.
  async tags(userId: string, from?: string, to?: string) {
    await this.entitlements.assertFeature(userId, FEATURES.reportsAdvanced);
    const s = await this.settings(userId);
    const today = todayIn(s.timezone);
    const period = financialMonth(today, s.monthStartDay);
    const start = from ?? period.start;
    const end = to ?? today;
    const rows = await this.prisma.$queryRaw<Array<{ tag: string; currency: string; total: unknown; count: bigint }>>`
      SELECT tag, "currency", SUM("amount") AS total, COUNT(*)::bigint AS count
      FROM (SELECT unnest("tags") AS tag, "currency", "amount" FROM "Transaction"
            WHERE "userId" = ${userId} AND "type" = 'EXPENSE' AND "excludeFromReports" = false
              AND "date" >= ${toDbDate(start)} AND "date" <= ${toDbDate(end)}) t
      GROUP BY 1, 2`;
    const merged = new Map<string, { tag: string; amount: number; count: number }>();
    for (const r of rows) {
      const entry = merged.get(r.tag) ?? { tag: r.tag, amount: 0, count: 0 };
      entry.amount += this.exchange.convert(Number(r.total), r.currency, s.currency) ?? 0;
      entry.count += Number(r.count);
      merged.set(r.tag, entry);
    }
    return { currency: s.currency, from: start, to: end, items: [...merged.values()].sort((a, b) => b.amount - a.amount).map((t) => ({ ...t, amount: round2(t.amount) })) };
  }

  // ------------------------------------------------------------------
  // Calendário
  // ------------------------------------------------------------------

  async calendar(userId: string, month?: string) {
    const s = await this.settings(userId);
    const today = todayIn(s.timezone);
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : monthKey(today);
    const start = `${m}-01`;
    const end = endOfMonth(start);

    const range = { gte: toDbDate(start), lte: toDbDate(end) };
    // O que está fechado (sem o plano pago) não aparece no calendário.
    const [lockedGoals, lockedPlans] = await Promise.all([this.locks.lockedIds(userId, 'goals'), this.locks.lockedIds(userId, 'plans')]);
    const openGoals = lockedGoals.size ? { id: { notIn: [...lockedGoals] } } : {};
    const openPlans = lockedPlans.size ? { id: { notIn: [...lockedPlans] } } : {};
    const [rows, rules, goals, plans, loans, deposits, contributions, planItems] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['date', 'type', 'currency'],
        where: { userId, excludeFromReports: false, type: { in: ['INCOME', 'EXPENSE'] }, date: { gte: toDbDate(start), lte: toDbDate(end) } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      end >= today ? this.recurring.upcoming(userId, Math.max(1, daysBetween(today, end))) : Promise.resolve({ items: [] as Awaited<ReturnType<RecurringService['upcoming']>>['items'] }),
      this.prisma.goal.findMany({ where: { userId, status: 'ACTIVE', targetDate: { gte: toDbDate(start), lte: toDbDate(end) }, ...openGoals }, select: { id: true, name: true, targetDate: true, color: true, icon: true } }),
      this.prisma.plan.findMany({
        where: {
          userId,
          ...openPlans,
          status: { in: ['PLANNING', 'ACTIVE'] },
          OR: [{ startDate: { gte: toDbDate(start), lte: toDbDate(end) } }, { endDate: { gte: toDbDate(start), lte: toDbDate(end) } }],
        },
        select: { id: true, name: true, startDate: true, endDate: true, color: true, icon: true, type: true },
      }),
      // Os meus empréstimos e os ligados que aceitei (vistos do meu lado)
      this.prisma.loan.findMany({
        where: { status: 'OPEN', dueDate: { gte: toDbDate(start), lte: toDbDate(end) }, OR: [{ userId }, { counterpartId: userId, linkStatus: 'ACCEPTED' }] },
        include: { payments: { select: { amount: true } }, user: { select: { name: true } } },
      }),
      // Depósitos planeados nos objetivos (os pendentes e os que aí vêm até ao fim do mês)
      end >= today ? this.goalDeposits.occurrences(userId, end) : Promise.resolve({ today, items: [] as Awaited<ReturnType<GoalDepositsService['occurrences']>>['items'] }),
      // O que já se pôs (ou tirou) dos objetivos em cada dia
      this.prisma.goalContribution.findMany({
        where: { userId, date: range, ...(lockedGoals.size ? { goalId: { notIn: [...lockedGoals] } } : {}) },
        select: { id: true, amount: true, date: true, depositId: true, goal: { select: { id: true, name: true, icon: true, color: true, currency: true } } },
      }),
      // Itens de planos com data marcada e ainda por fazer
      this.prisma.planItem.findMany({
        where: { plan: { userId, status: { in: ['PLANNING', 'ACTIVE'] }, ...openPlans }, isDone: false, dueDate: range },
        select: { id: true, title: true, estimatedAmount: true, dueDate: true, plan: { select: { id: true, name: true, icon: true, color: true, currency: true } } },
      }),
    ]);

    const days = new Map<string, {
      date: string;
      income: number;
      expense: number;
      count: number;
      upcoming: Array<{ ruleId: string; description: string; amount: number; currency: string; type: string; overdue: boolean; autoCreate: boolean }>;
      goals: Array<{ id: string; name: string; color: string; icon: string }>;
      plans: Array<{ id: string; name: string; color: string; icon: string; type: string; edge: 'start' | 'end' }>;
      /// Empréstimos que vencem neste dia
      loans: Array<{ id: string; direction: string; personName: string; remaining: number; currency: string }>;
      /// Depósitos planeados em objetivos (por fazer)
      deposits: Array<{ depositId: string; goalId: string; name: string; icon: string; color: string; amount: number; currency: string; autoApply: boolean; overdue: boolean; date: string }>;
      /// Dinheiro que entrou (ou saiu) de objetivos neste dia
      contributions: Array<{ id: string; goalId: string; name: string; icon: string; color: string; amount: number; currency: string; planned: boolean }>;
      /// Itens de planos com esta data
      planItems: Array<{ id: string; planId: string; planName: string; title: string; amount: number | null; currency: string; icon: string; color: string }>;
    }>();
    for (let d = start; d <= end; d = addDays(d, 1)) {
      days.set(d, { date: d, income: 0, expense: 0, count: 0, upcoming: [], goals: [], plans: [], loans: [], deposits: [], contributions: [], planItems: [] });
    }
    let income = 0;
    let expense = 0;
    for (const r of rows) {
      const day = days.get(fromDbDate(r.date));
      if (!day) continue;
      const value = this.exchange.convert(num(r._sum.amount), r.currency, s.currency) ?? 0;
      if (r.type === 'INCOME') {
        day.income = round2(day.income + value);
        income += value;
      } else {
        day.expense = round2(day.expense + value);
        expense += value;
      }
      day.count += r._count._all;
    }
    let planned = 0;
    // Receitas fixas que ainda aí vêm neste mês ("no dia X recebo o salário")
    let plannedIncome = 0;
    for (const u of rules.items) {
      const day = days.get(u.date);
      if (!day) continue;
      day.upcoming.push({ ruleId: u.ruleId, description: u.description, amount: u.amount, currency: u.currency, type: u.type, overdue: u.overdue, autoCreate: u.autoCreate });
      if (u.type === 'EXPENSE') planned += this.exchange.convert(u.amount, u.currency, s.currency) ?? 0;
      else if (u.type === 'INCOME') plannedIncome += this.exchange.convert(u.amount, u.currency, s.currency) ?? 0;
    }
    for (const g of goals) {
      const day = g.targetDate ? days.get(fromDbDate(g.targetDate)) : undefined;
      day?.goals.push({ id: g.id, name: g.name, color: g.color, icon: g.icon });
    }
    for (const p of plans) {
      if (p.startDate) days.get(fromDbDate(p.startDate))?.plans.push({ id: p.id, name: p.name, color: p.color, icon: p.icon, type: p.type, edge: 'start' });
      if (p.endDate) days.get(fromDbDate(p.endDate))?.plans.push({ id: p.id, name: p.name, color: p.color, icon: p.icon, type: p.type, edge: 'end' });
    }
    for (const l of loans) {
      const remaining = round2(num(l.amount) - l.payments.reduce((acc, p) => acc + num(p.amount), 0));
      if (remaining <= 0 || !l.dueDate) continue;
      const mine = l.userId === userId;
      days.get(fromDbDate(l.dueDate))?.loans.push({
        id: l.id,
        direction: mine ? l.direction : l.direction === 'LENT' ? 'BORROWED' : 'LENT',
        personName: mine ? l.personName : l.user.name,
        remaining,
        currency: l.currency,
      });
    }
    let plannedDeposits = 0;
    for (const d of deposits.items) {
      // Um depósito em atraso de um mês anterior aparece hoje (é hoje que há algo a fazer).
      const day = days.get(d.date) ?? (d.overdue ? days.get(today) : undefined);
      if (!day) continue;
      day.deposits.push({ depositId: d.depositId, goalId: d.goalId, name: d.name, icon: d.icon, color: d.color, amount: d.amount, currency: d.currency, autoApply: d.autoApply, overdue: d.overdue, date: d.date });
      plannedDeposits += this.exchange.convert(d.amount, d.currency, s.currency) ?? 0;
    }
    for (const c of contributions) {
      days.get(fromDbDate(c.date))?.contributions.push({
        id: c.id,
        goalId: c.goal.id,
        name: c.goal.name,
        icon: c.goal.icon,
        color: c.goal.color,
        amount: num(c.amount),
        currency: c.goal.currency,
        planned: c.depositId !== null,
      });
    }
    for (const i of planItems) {
      if (!i.dueDate) continue;
      days.get(fromDbDate(i.dueDate))?.planItems.push({
        id: i.id,
        planId: i.plan.id,
        planName: i.plan.name,
        title: i.title,
        amount: i.estimatedAmount === null ? null : num(i.estimatedAmount),
        currency: i.plan.currency,
        icon: i.plan.icon,
        color: i.plan.color,
      });
    }
    return {
      month: m,
      currency: s.currency,
      today,
      totals: { income: round2(income), expense: round2(expense), plannedExpenses: round2(planned), plannedIncome: round2(plannedIncome), plannedDeposits: round2(plannedDeposits) },
      days: [...days.values()],
    };
  }

  /// Para a app saber o período atual sem fazer contas.
  async periods(userId: string) {
    const s = await this.settings(userId);
    const today = todayIn(s.timezone);
    const current = financialMonth(today, s.monthStartDay);
    const previous = financialMonth(addDays(current.start, -1), s.monthStartDay);
    return { today, current, previous, monthStartDay: s.monthStartDay, weekStartsOn: s.weekStartsOn };
  }
}
