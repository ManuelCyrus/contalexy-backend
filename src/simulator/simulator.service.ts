import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { AccountsService } from '../accounts/accounts.service';
import { RecurringService } from '../recurring/recurring.service';
import { GoalsService } from '../goals/goals.service';
import { LoansService } from '../loans/loans.service';
import { MonthlyPlansService } from '../monthly-plans/monthly-plans.service';
import { ApiException } from '../common/errors/api.exception';
import { FEATURES } from '../billing/plans.catalog';
import { addDays, addMonths, daysBetween, financialMonth, fromDbDate, monthKey, Period, todayIn, toDbDate } from '../common/utils/dates';
import { num, round2 } from '../common/utils/money';
import { ForecastSimDto, GoalSimDto, PurchaseSimDto } from './simulator.dto';
import { Baseline, monthsToSave, OneOff, projectMonths, savingScenarios, verdictFor } from './simulator.math';

/// Contas de onde se paga no dia a dia (o "saldo disponível").
const LIQUID = ['BANK', 'CASH', 'DIGITAL_WALLET', 'OTHER'];
const SAVINGS = ['SAVINGS', 'INVESTMENT'];
/// De onde vem cada número: do plano do mês, da média dos últimos meses,
/// dos pagamentos fixos, só deste mês — ou de lado nenhum (ainda sem dados).
export type Basis = 'plan' | 'history' | 'recurring' | 'current' | 'none';

const PURCHASE_HORIZON = 12;
const FREE_FORECAST_MONTHS = 6;
const PREMIUM_FORECAST_MONTHS = 36;
const FREE_ONE_OFFS = 1;

/// Simulador "E se eu fizer isto?": tudo contas do servidor (sem IA),
/// a partir do saldo, do plano do mês, das médias e dos pagamentos fixos.
@Injectable()
export class SimulatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exchange: ExchangeService,
    private readonly entitlements: EntitlementsService,
    private readonly accounts: AccountsService,
    private readonly recurring: RecurringService,
    private readonly goals: GoalsService,
    private readonly loans: LoansService,
    private readonly monthlyPlans: MonthlyPlansService,
  ) {}

  private async settings(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true, timezone: true, monthStartDay: true } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    return { ...user, today: todayIn(user.timezone) };
  }

  /// Média de receitas e despesas dos últimos 3 meses financeiros completos
  /// (só contam os meses em que houve movimentos).
  private async history(userId: string, period: Period, s: { currency: string; monthStartDay: number }) {
    const months: Period[] = [];
    let cursor = period;
    for (let i = 0; i < 3; i++) {
      cursor = financialMonth(addDays(cursor.start, -1), s.monthStartDay);
      months.push(cursor);
    }
    const rows = await this.prisma.transaction.groupBy({
      by: ['date', 'type', 'currency'],
      where: {
        userId,
        excludeFromReports: false,
        type: { in: ['INCOME', 'EXPENSE'] },
        date: { gte: toDbDate(months[2].start), lte: toDbDate(months[0].end) },
      },
      _sum: { amount: true },
    });
    const totals = months.map(() => ({ income: 0, expense: 0 }));
    for (const r of rows) {
      const date = fromDbDate(r.date);
      const index = months.findIndex((m) => date >= m.start && date <= m.end);
      if (index < 0) continue;
      const value = this.exchange.convert(num(r._sum.amount), r.currency, s.currency) ?? 0;
      if (r.type === 'INCOME') totals[index].income += value;
      else totals[index].expense += value;
    }
    const withData = totals.filter((t) => t.income > 0 || t.expense > 0);
    const avg = (key: 'income' | 'expense') => (withData.length ? round2(withData.reduce((acc, t) => acc + t[key], 0) / withData.length) : 0);
    return { months: withData.length, income: avg('income'), expense: avg('expense') };
  }

  /// Tudo o que as simulações precisam de saber sobre a pessoa.
  async context(userId: string) {
    const s = await this.settings(userId);
    const main = s.currency;
    const period = financialMonth(s.today, s.monthStartDay);
    const totalDays = daysBetween(period.start, period.end) + 1;
    const elapsedDays = daysBetween(period.start, s.today) + 1;
    const daysLeft = daysBetween(s.today, period.end);

    const [accountList, month, fixed, upcoming, goalList, loanList, history] = await Promise.all([
      this.accounts.list(userId),
      this.monthlyPlans.current(userId, { suggestion: false }),
      this.recurring.list(userId),
      this.recurring.upcoming(userId, Math.max(1, daysLeft)),
      this.goals.list(userId),
      this.loans.list(userId, 'open'),
      this.history(userId, period, s),
    ]);

    let available = 0;
    let savingsBalance = 0;
    for (const a of accountList.accounts) {
      if (a.archived || !a.includeInTotal) continue;
      if (LIQUID.includes(a.type)) available += a.convertedBalance ?? 0;
      else if (SAVINGS.includes(a.type)) savingsBalance += a.convertedBalance ?? 0;
    }

    // Pagamentos e recebimentos fixos que ainda faltam este mês.
    let upcomingExpenses = 0;
    let upcomingIncome = 0;
    for (const u of upcoming.items) {
      if (u.date > period.end) continue;
      const value = this.exchange.convert(u.amount, u.currency, main) ?? 0;
      if (u.type === 'EXPENSE') upcomingExpenses += value;
      else if (u.type === 'INCOME') upcomingIncome += value;
    }

    const plan = month.plan;
    const incomeSoFar = month.actualIncome;
    const spentSoFar = month.actualExpenses;
    const savedSoFar = month.actualSaved;

    // Quanto se põe de lado por mês para cada objetivo: o que está no plano
    // do mês ou, sem plano, o que o objetivo pede (ou o ritmo recente).
    const activeGoals = goalList.filter((g) => g.status === 'ACTIVE' && g.remaining > 0);
    const goalMonthly = new Map<string, number>();
    if (plan) {
      for (const l of plan.lines) if (l.kind === 'GOAL' && l.goalId) goalMonthly.set(l.goalId, l.planned);
    } else {
      for (const g of activeGoals) {
        const monthly = g.monthlyNeeded ?? g.monthlyPace;
        if (monthly > 0) goalMonthly.set(g.id, this.exchange.convert(monthly, g.currency, main) ?? 0);
      }
    }
    const goalsMonthly = round2([...goalMonthly.values()].reduce((acc, v) => acc + v, 0));
    // Para prever quando se chega a cada objetivo: o que está no plano ou,
    // se o objetivo não está lá, o ritmo a que se tem posto dinheiro.
    const goalRate = new Map(goalMonthly);
    for (const g of activeGoals) {
      if (!goalRate.has(g.id) && g.monthlyPace > 0) goalRate.set(g.id, this.exchange.convert(g.monthlyPace, g.currency, main) ?? 0);
    }

    // Um mês "normal".
    let incomeBasis: Basis = 'none';
    let monthlyIncome = 0;
    if (plan && plan.plannedIncome > 0) {
      incomeBasis = 'plan';
      monthlyIncome = plan.plannedIncome;
    } else if (history.income > 0) {
      incomeBasis = 'history';
      monthlyIncome = history.income;
    } else if (fixed.monthlyIncome > 0) {
      incomeBasis = 'recurring';
      monthlyIncome = fixed.monthlyIncome;
    } else if (incomeSoFar > 0) {
      incomeBasis = 'current';
      monthlyIncome = incomeSoFar;
    }

    let expenseBasis: Basis = 'none';
    let monthlyExpenses = 0;
    if (plan && plan.plannedExpenses > 0) {
      expenseBasis = 'plan';
      monthlyExpenses = plan.plannedExpenses;
    } else if (history.expense > 0) {
      expenseBasis = 'history';
      monthlyExpenses = history.expense;
    } else {
      // Sem histórico: o ritmo deste mês (com poucos dias, só o que já se gastou).
      const pace = elapsedDays >= 5 ? (spentSoFar / elapsedDays) * totalDays : spentSoFar;
      if (fixed.monthlyExpenses > 0 && fixed.monthlyExpenses >= pace) {
        expenseBasis = 'recurring';
        monthlyExpenses = fixed.monthlyExpenses;
      } else if (pace > 0) {
        expenseBasis = 'current';
        monthlyExpenses = round2(pace);
      }
    }
    const monthlySavings = plan ? round2(plan.plannedSavings + plan.plannedGoals) : goalsMonthly;

    // O que ainda falta acontecer este mês.
    const restIncome = round2(Math.max(upcomingIncome, incomeBasis === 'plan' || incomeBasis === 'history' ? Math.max(0, monthlyIncome - incomeSoFar) : 0));
    const restExpenses = round2(Math.max(upcomingExpenses, expenseBasis === 'plan' && plan ? plan.leftToSpend : Math.max(0, monthlyExpenses - spentSoFar)));
    const restSavings = round2(Math.max(0, monthlySavings - savedSoFar));

    // Empréstimos que tenho de devolver com data: saem do dinheiro livre no
    // mês em que vencem (os atrasados contam já para este mês).
    const loanOneOffs: OneOff[] = [];
    const loansToPay: Array<{ loanId: string; personName: string; remaining: number; currency: string; dueDate: string | null; month: number }> = [];
    const loansToReceive: typeof loansToPay = [];
    for (const l of loanList.items) {
      if (!l.dueDate || l.remaining <= 0) continue;
      const value = this.exchange.convert(l.remaining, l.currency, main);
      const index = this.monthIndex(l.dueDate, period, s.monthStartDay);
      const entry = { loanId: l.id, personName: l.personName, remaining: l.remaining, currency: l.currency, dueDate: l.dueDate, month: index };
      if (l.direction === 'BORROWED') {
        loansToPay.push(entry);
        if (value !== null) loanOneOffs.push({ month: index, amount: value });
      } else {
        loansToReceive.push(entry);
      }
    }

    const baseline: Baseline = {
      available: round2(available),
      restIncome,
      restExpenses,
      restSavings,
      monthlyIncome: round2(monthlyIncome),
      monthlyExpenses: round2(monthlyExpenses),
      monthlySavings,
    };
    return {
      currency: main,
      today: s.today,
      monthStartDay: s.monthStartDay,
      period: { key: period.key, start: period.start, end: period.end, daysLeft, elapsedDays, totalDays },
      baseline,
      basis: { income: incomeBasis, expenses: expenseBasis, historyMonths: history.months, hasPlan: !!plan },
      monthly: {
        income: baseline.monthlyIncome,
        expenses: baseline.monthlyExpenses,
        savings: baseline.monthlySavings,
        /// O que sobra num mês normal depois das despesas e da poupança planeada
        free: round2(baseline.monthlyIncome - baseline.monthlyExpenses - baseline.monthlySavings),
      },
      soFar: { income: incomeSoFar, expenses: spentSoFar, saved: savedSoFar },
      /// Dinheiro em contas de poupança/investimento (não entra no "disponível")
      savingsBalance: round2(savingsBalance),
      plan,
      goals: activeGoals,
      goalMonthly,
      goalRate,
      loanOneOffs,
      loansToPay,
      loansToReceive,
      upcoming: upcoming.items.filter((u) => u.date <= period.end),
    };
  }

  /// Em que mês (0 = este) cai uma data. Datas passadas contam como este mês.
  private monthIndex(date: string, period: Period, monthStartDay: number): number {
    if (date <= period.end) return 0;
    let cursor = period;
    for (let i = 1; i <= 120; i++) {
      cursor = financialMonth(addDays(cursor.end, 1), monthStartDay);
      if (date <= cursor.end) return i;
    }
    return 120;
  }

  /// A chave "AAAA-MM" do mês financeiro que fica `index` meses à frente.
  private monthKeyAt(periodStart: string, index: number, monthStartDay: number): string {
    return monthKey(addMonths(periodStart, index, monthStartDay));
  }

  // ------------------------------------------------------------------
  // "E se eu comprar isto?"
  // ------------------------------------------------------------------

  async purchase(userId: string, dto: PurchaseSimDto) {
    const ctx = await this.context(userId);
    const b = ctx.baseline;
    const amount = round2(dto.amount);
    const k = Math.min(dto.monthsFromNow ?? 0, PURCHASE_HORIZON);
    const without = projectMonths(b, PURCHASE_HORIZON, ctx.loanOneOffs);
    const withPurchase = projectMonths(b, PURCHASE_HORIZON, [...ctx.loanOneOffs, { month: k, amount }]);
    // "À justa" = sobra menos de 10% das despesas de um mês.
    const cushion = round2(b.monthlyExpenses * 0.1);
    const key = (i: number) => this.monthKeyAt(ctx.period.start, i, ctx.monthStartDay);

    /// As contas de comprar no mês `i` (0 = agora).
    const at = (i: number) => {
      const m = without[i];
      const remaining = round2(m.free - amount);
      return {
        monthsFromNow: i,
        month: key(i),
        date: i === 0 ? ctx.today : addMonths(ctx.today, i),
        /// Dinheiro livre no início desse mês
        balance: i === 0 ? b.available : without[i - 1].free,
        expectedIncome: m.income,
        expectedExpenses: m.expenses,
        plannedSavings: m.savings,
        loanRepayments: m.oneOff,
        purchase: amount,
        /// Dinheiro que sobra no fim desse mês depois da compra
        remaining,
        remainingWithoutPurchase: m.free,
        verdict: verdictFor(remaining, m.savedTotal, cushion),
      };
    };

    const earliestIndex = without.findIndex((m) => m.free - amount >= 0);
    const monthlyFree = ctx.monthly.free;
    const alreadySaved = round2(Math.min(dto.alreadySaved ?? 0, amount));
    const toSave = round2(amount - alreadySaved);
    const plan = (monthly: number) => {
      const months = monthsToSave(toSave, monthly);
      return { monthly: round2(monthly), months, date: months === null ? null : addMonths(ctx.today, months), feasible: monthly <= monthlyFree + 0.005 };
    };

    return {
      currency: ctx.currency,
      today: ctx.today,
      name: dto.name ?? null,
      amount,
      basis: ctx.basis,
      monthly: ctx.monthly,
      now: at(0),
      /// Só quando se perguntou "e se for daqui a X meses?"
      later: k > 0 ? at(k) : null,
      /// O primeiro mês em que a compra cabe sem ficar no negativo (até 12 meses)
      earliest: earliestIndex < 0 ? null : { monthsFromNow: earliestIndex, month: key(earliestIndex), date: earliestIndex === 0 ? ctx.today : addMonths(ctx.today, earliestIndex) },
      /// "E se eu guardar X por mês para isto?"
      saving: dto.monthlySaving ? { ...plan(dto.monthlySaving), alreadySaved, toSave, monthlyFree } : null,
      /// Quanto guardar por mês para comprar em 1, 2, 3, 6 ou 12 meses
      options: [1, 2, 3, 6, 12].map((months) => {
        const monthly = round2(toSave / months);
        return { months, monthly, date: addMonths(ctx.today, months), feasible: monthly <= monthlyFree + 0.005 };
      }),
      equivalents: {
        percentOfMonthlyIncome: b.monthlyIncome > 0 ? round2((amount / b.monthlyIncome) * 100) : null,
        daysOfSpending: b.monthlyExpenses > 0 ? Math.round(amount / (b.monthlyExpenses / 30.4375)) : null,
        percentOfBalance: b.available > 0 ? round2((amount / b.available) * 100) : null,
        /// Meses da poupança planeada que esta compra "come"
        monthsOfSavings: b.monthlySavings > 0 ? round2(amount / b.monthlySavings) : null,
      },
      /// A alternativa de pagar com o que está nas contas de poupança
      fromSavings: { balance: ctx.savingsBalance, after: round2(ctx.savingsBalance - amount), enough: ctx.savingsBalance >= amount },
      projection: without.map((m, i) => ({ month: key(i), without: m.free, with: withPurchase[i].free })),
    };
  }

  // ------------------------------------------------------------------
  // "Quanto tempo demoro a juntar X?"
  // ------------------------------------------------------------------

  async goal(userId: string, dto: GoalSimDto) {
    const ctx = await this.context(userId);
    const existing = dto.goalId ? await this.goals.get(userId, dto.goalId) : null;
    const currency = existing?.currency ?? ctx.currency;
    const target = round2(dto.targetAmount ?? existing?.targetAmount ?? 0);
    const saved = round2(Math.min(dto.saved ?? existing?.saved ?? 0, target));
    const remaining = round2(Math.max(0, target - saved));
    const targetDate = dto.targetDate ?? existing?.targetDate ?? null;
    if (targetDate && targetDate < ctx.today && dto.targetDate) throw ApiException.badRequest('DATE_RANGE_INVALID');

    // Quanto dá para pôr de lado por mês para ISTO: o que sobra das despesas
    // menos o que já está prometido aos outros objetivos.
    const ownShare = existing ? (ctx.goalMonthly.get(existing.id) ?? 0) : 0;
    const otherSavings = Math.max(0, ctx.baseline.monthlySavings - ownShare);
    const capacityMain = round2(ctx.baseline.monthlyIncome - ctx.baseline.monthlyExpenses - otherSavings);
    const capacity = this.exchange.convert(capacityMain, ctx.currency, currency) ?? capacityMain;

    const monthsUntilTarget = targetDate ? Math.max(1, Math.ceil(daysBetween(ctx.today, targetDate) / 30.4375)) : null;
    const requiredMonthly = monthsUntilTarget !== null && targetDate && targetDate >= ctx.today ? round2(remaining / monthsUntilTarget) : null;
    const fallback = existing ? (existing.monthlyNeeded ?? (existing.monthlyPace > 0 ? existing.monthlyPace : null)) : null;
    const monthly = dto.monthlySaving ?? fallback;

    const result = (value: number, extra = 0) => {
      const months = monthsToSave(remaining + extra, value);
      return { months, date: months === null ? null : addMonths(ctx.today, months) };
    };
    const base = monthly !== null ? result(monthly) : { months: null, date: null };
    const scenarioBase = monthly ?? requiredMonthly ?? (capacity > 0 ? capacity : remaining / 12);
    const unexpected = dto.unexpectedExpense && monthly !== null ? result(monthly, dto.unexpectedExpense) : null;

    const timeline: Array<{ month: string; date: string; saved: number }> = [];
    if (monthly !== null && base.months !== null) {
      for (let i = 1; i <= Math.min(base.months, 36); i++) {
        const date = addMonths(ctx.today, i);
        timeline.push({ month: monthKey(date), date, saved: round2(Math.min(target, saved + monthly * i)) });
      }
    }

    return {
      currency,
      today: ctx.today,
      goalId: existing?.id ?? null,
      name: existing?.name ?? null,
      target,
      saved,
      remaining,
      progress: target > 0 ? Math.min(100, round2((saved / target) * 100)) : 0,
      monthlySaving: monthly !== null ? round2(monthly) : null,
      months: base.months,
      date: base.date,
      targetDate,
      monthsUntilTarget,
      /// Quanto guardar por mês para chegar à data
      requiredMonthly,
      /// A este ritmo, chega a tempo?
      onTrack: base.date && targetDate ? base.date <= targetDate : null,
      /// Quanto dá para guardar por mês para isto (num mês normal)
      monthlyCapacity: round2(capacity),
      feasible: monthly !== null ? monthly <= capacity + 0.005 : null,
      basis: ctx.basis,
      /// "E se guardar mais (ou menos)?"
      scenarios: savingScenarios(scenarioBase, monthly).map((value) => ({ monthly: value, ...result(value), feasible: value <= capacity + 0.005 })),
      /// "E se aparecer uma despesa inesperada?"
      withUnexpected:
        unexpected && dto.unexpectedExpense
          ? {
              amount: round2(dto.unexpectedExpense),
              months: unexpected.months,
              date: unexpected.date,
              delayMonths: unexpected.months !== null && base.months !== null ? unexpected.months - base.months : null,
            }
          : null,
      timeline,
    };
  }

  // ------------------------------------------------------------------
  // Vários meses à frente, com "e se…"
  // ------------------------------------------------------------------

  async forecast(userId: string, dto: ForecastSimDto) {
    const advanced = await this.entitlements.hasFeature(userId, FEATURES.simulationsAdvanced);
    const maxMonths = advanced ? PREMIUM_FORECAST_MONTHS : FREE_FORECAST_MONTHS;
    const oneOffs = dto.oneOffs ?? [];
    if (!advanced && (dto.months > FREE_FORECAST_MONTHS || oneOffs.length > FREE_ONE_OFFS)) {
      throw ApiException.premiumRequired(FEATURES.simulationsAdvanced, await this.entitlements.lowestPlanWith(FEATURES.simulationsAdvanced));
    }
    const ctx = await this.context(userId);
    const months = Math.min(dto.months, maxMonths);
    const adj = { incomeChangePercent: dto.incomeChangePercent, expenseChangePercent: dto.expenseChangePercent, extraMonthlySaving: dto.extraMonthlySaving };
    const events: OneOff[] = [...ctx.loanOneOffs, ...oneOffs.filter((o) => o.month <= months).map((o) => ({ month: o.month, amount: o.amount }))];
    const base = projectMonths(ctx.baseline, months, ctx.loanOneOffs);
    const scenario = projectMonths(ctx.baseline, months, events, adj);
    const key = (i: number) => this.monthKeyAt(ctx.period.start, i, ctx.monthStartDay);
    const last = scenario[scenario.length - 1];
    const lowest = scenario.reduce((min, m) => (m.free < min.free ? m : min), scenario[0]);
    const firstNegative = scenario.find((m) => m.free < 0) ?? null;
    const next = scenario[1] ?? scenario[0];
    return {
      currency: ctx.currency,
      today: ctx.today,
      advanced,
      maxMonths,
      basis: ctx.basis,
      monthly: ctx.monthly,
      /// Um mês normal já com as alterações pedidas
      adjusted: { income: next.income, expenses: next.expenses, savings: next.savings, free: round2(next.income - next.expenses - next.savings) },
      months: scenario.map((m, i) => ({ ...m, month: key(i), baselineFree: base[i].free })),
      summary: {
        endBalance: last.free,
        baselineEndBalance: base[base.length - 1].free,
        difference: round2(last.free - base[base.length - 1].free),
        totalSaved: last.savedTotal,
        lowestBalance: lowest.free,
        lowestMonth: key(lowest.index),
        firstNegativeMonth: firstNegative ? key(firstNegative.index) : null,
      },
    };
  }

  // ------------------------------------------------------------------
  // Previsão: como acaba este mês e os próximos (sem IA)
  // ------------------------------------------------------------------

  async outlook(userId: string) {
    const ctx = await this.context(userId);
    const b = ctx.baseline;
    const projection = projectMonths(b, 6, ctx.loanOneOffs);
    const key = (i: number) => this.monthKeyAt(ctx.period.start, i, ctx.monthStartDay);
    const projectedIncome = round2(ctx.soFar.income + b.restIncome);
    const projectedSpending = round2(ctx.soFar.expenses + b.restExpenses);
    const plannedSpending = ctx.plan && ctx.plan.plannedExpenses > 0 ? ctx.plan.plannedExpenses : null;
    const perMonth = round2(Math.max(0, b.monthlyIncome - b.monthlyExpenses));

    const goals = ctx.goals.slice(0, 8).map((g) => {
      const monthlyMain = ctx.goalRate.get(g.id) ?? 0;
      const monthly = this.exchange.convert(monthlyMain, ctx.currency, g.currency) ?? monthlyMain;
      const months = monthsToSave(g.remaining, monthly);
      const estimatedDate = months === null ? null : addMonths(ctx.today, months);
      return {
        goalId: g.id,
        name: g.name,
        icon: g.icon,
        color: g.color,
        currency: g.currency,
        remaining: g.remaining,
        progress: g.progress,
        monthly: round2(monthly),
        estimatedDate,
        targetDate: g.targetDate,
        onTrack: estimatedDate && g.targetDate ? estimatedDate <= g.targetDate : null,
      };
    });

    const risks: Array<{ type: string; tone: 'warning' | 'negative'; params: Record<string, unknown> }> = [];
    if (projection[0].free < 0) risks.push({ type: 'negative_balance', tone: 'negative', params: { amount: projection[0].free } });
    // O plano do mês promete mais do que o rendimento dá.
    if (ctx.plan && ctx.plan.plannedFree < 0) risks.push({ type: 'plan_over_income', tone: 'warning', params: { amount: round2(-ctx.plan.plannedFree) } });
    if (plannedSpending !== null && projectedSpending > plannedSpending * 1.02) {
      risks.push({ type: 'over_plan', tone: 'warning', params: { planned: plannedSpending, projected: projectedSpending, difference: round2(projectedSpending - plannedSpending) } });
    }
    if (projectedIncome > 0 && projectedSpending > projectedIncome) {
      risks.push({ type: 'spending_over_income', tone: 'negative', params: { income: projectedIncome, spending: projectedSpending, difference: round2(projectedSpending - projectedIncome) } });
    }
    for (const line of (ctx.plan?.lines ?? []).filter((l) => l.status === 'EXCEEDED').slice(0, 3)) {
      risks.push({
        type: 'category_over_plan',
        tone: 'warning',
        params: { categoryId: line.categoryId, key: line.category?.key ?? null, name: line.category?.name ?? line.name, planned: line.planned, actual: line.actual },
      });
    }
    // Um pagamento grande (20%+ do saldo) nos próximos 7 dias.
    const big = ctx.upcoming
      .filter((u) => u.type === 'EXPENSE' && u.daysUntil <= 7)
      .map((u) => ({ u, value: this.exchange.convert(u.amount, u.currency, ctx.currency) ?? 0 }))
      .sort((x, y) => y.value - x.value)[0];
    if (big && big.value > 0 && big.value >= Math.max(0, b.available) * 0.2) {
      risks.push({ type: 'big_payment', tone: 'warning', params: { description: big.u.description, amount: big.u.amount, currency: big.u.currency, date: big.u.date, days: big.u.daysUntil } });
    }
    for (const l of ctx.loansToPay.filter((x) => x.month === 0).slice(0, 2)) {
      risks.push({ type: 'loan_due', tone: 'warning', params: { loanId: l.loanId, person: l.personName, amount: l.remaining, currency: l.currency, dueDate: l.dueDate } });
    }
    for (const g of goals.filter((x) => x.onTrack === false).slice(0, 2)) {
      risks.push({ type: 'goal_behind', tone: 'warning', params: { goalId: g.goalId, name: g.name, estimatedDate: g.estimatedDate, targetDate: g.targetDate } });
    }

    return {
      currency: ctx.currency,
      today: ctx.today,
      period: ctx.period,
      basis: ctx.basis,
      monthly: ctx.monthly,
      monthEnd: {
        balanceNow: b.available,
        incomeSoFar: ctx.soFar.income,
        spentSoFar: ctx.soFar.expenses,
        savedSoFar: ctx.soFar.saved,
        expectedIncome: b.restIncome,
        expectedExpenses: b.restExpenses,
        plannedSavings: b.restSavings,
        loanRepayments: projection[0].oneOff,
        /// Dinheiro livre previsto para o fim do mês
        estimatedBalance: projection[0].free,
        projectedIncome,
        projectedSpending,
        plannedSpending,
        /// Quanto deve sobrar este mês (receitas − despesas)
        estimatedLeftover: round2(projectedIncome - projectedSpending),
        /// Quanto deve ficar poupado este mês
        estimatedSavings: round2(ctx.soFar.saved + b.restSavings),
      },
      /// Quanto dá para poupar se o que sobra das despesas for todo para poupança
      savingsPotential: { perMonth, in3Months: round2(perMonth * 3), in6Months: round2(perMonth * 6), in12Months: round2(perMonth * 12) },
      goals,
      loans: { toPay: ctx.loansToPay.filter((l) => l.month <= 2), toReceive: ctx.loansToReceive.filter((l) => l.month <= 2) },
      risks: risks.slice(0, 6),
      projection: projection.map((m, i) => ({ month: key(i), free: m.free, income: m.income, expenses: m.expenses, savings: m.savings })),
    };
  }
}

