import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { LocksService } from '../billing/locks.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApiException } from '../common/errors/api.exception';
import { FEATURES } from '../billing/plans.catalog';
import { daysBetween, Period, periodContaining, previousPeriod, todayIn, toDbDate } from '../common/utils/dates';
import { formatMoney, money, num, round2 } from '../common/utils/money';
import { Budget } from '../generated/prisma/client';
import { CreateBudgetDto, UpdateBudgetDto } from './budgets.dto';
import { toCategoryDto } from '../categories/categories.service';
import { isCurrency } from '../meta/countries.data';

const DEFAULT_THRESHOLDS = [80, 100];

interface Settings {
  currency: string;
  timezone: string;
  monthStartDay: number;
  weekStartsOn: number;
  /// O plano atual deixa passar o que sobra para o período seguinte?
  canRollover: boolean;
}

/// Orçamentos e limites: "no máximo X por mês em Restaurantes" ou um
/// limite geral para todas as despesas. Avisa a 80% e a 100% (o Premium
/// escolhe os avisos e deixa o que sobra passar para o mês seguinte).
@Injectable()
export class BudgetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exchange: ExchangeService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
    private readonly locks: LocksService,
  ) {}

  private async settings(userId: string): Promise<Settings> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true, timezone: true, monthStartDay: true, weekStartsOn: true } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    // "O que sobra passa para o mês seguinte" é do plano pago: sem ele, deixa de contar.
    return { ...user, canRollover: await this.entitlements.hasFeature(userId, FEATURES.budgetsRollover) };
  }

  private periodOf(budget: Pick<Budget, 'period'>, date: string, s: Settings): Period {
    return periodContaining(budget.period, date, { monthStartDay: s.monthStartDay, weekStartsOn: s.weekStartsOn });
  }

  private async categoryScope(userId: string, categoryIds: string[]): Promise<string[] | null> {
    if (!categoryIds.length) return null;
    const children = await this.prisma.category.findMany({ where: { userId, parentId: { in: categoryIds } }, select: { id: true } });
    return Array.from(new Set([...categoryIds, ...children.map((c) => c.id)]));
  }

  /// Quanto já se gastou no período (na moeda do orçamento).
  async spent(userId: string, budget: Pick<Budget, 'categoryIds' | 'currency'>, period: Period): Promise<number> {
    const scope = await this.categoryScope(userId, budget.categoryIds);
    const rows = await this.prisma.transaction.groupBy({
      by: ['currency'],
      where: {
        userId,
        type: 'EXPENSE',
        excludeFromReports: false,
        date: { gte: toDbDate(period.start), lte: toDbDate(period.end) },
        ...(scope ? { categoryId: { in: scope } } : {}),
      },
      _sum: { amount: true },
    });
    let total = 0;
    for (const row of rows) total += this.exchange.convert(num(row._sum.amount), row.currency, budget.currency) ?? 0;
    return round2(total);
  }

  private async compute(userId: string, budget: Budget, date: string, s: Settings) {
    const today = todayIn(s.timezone);
    const period = this.periodOf(budget, date, s);
    const amount = num(budget.amount);
    let carryOver = 0;
    if (budget.rollover && s.canRollover) {
      const prev = previousPeriod(budget.period, date, { monthStartDay: s.monthStartDay, weekStartsOn: s.weekStartsOn });
      carryOver = Math.max(0, round2(amount - (await this.spent(userId, budget, prev))));
    }
    const available = round2(amount + carryOver);
    const spent = await this.spent(userId, budget, period);
    const remaining = round2(available - spent);
    const percent = available > 0 ? round2((spent / available) * 100) : 0;
    const totalDays = daysBetween(period.start, period.end) + 1;
    const isCurrent = today >= period.start && today <= period.end;
    const daysLeft = isCurrent ? daysBetween(today, period.end) + 1 : today < period.start ? totalDays : 0;
    const elapsed = isCurrent ? daysBetween(period.start, today) + 1 : today > period.end ? totalDays : 0;
    const below = budget.alertThresholds.filter((t) => t < 100);
    const warnAt = below.length ? Math.min(...below) : 80;
    const categories = budget.categoryIds.length ? await this.prisma.category.findMany({ where: { id: { in: budget.categoryIds }, userId } }) : [];
    return {
      id: budget.id,
      name: budget.name,
      amount,
      currency: budget.currency,
      period: budget.period,
      categoryIds: budget.categoryIds,
      categories: categories.map((c) => toCategoryDto(c)),
      alertThresholds: budget.alertThresholds,
      rollover: budget.rollover,
      isActive: budget.isActive,
      periodStart: period.start,
      periodEnd: period.end,
      periodKey: period.key,
      carryOver,
      available,
      spent,
      remaining,
      percent,
      status: percent >= 100 ? 'EXCEEDED' : percent >= warnAt ? 'WARNING' : 'OK',
      daysLeft,
      /// Quanto ainda dá para gastar por dia até ao fim do período
      dailyAllowance: daysLeft > 0 ? round2(Math.max(0, remaining) / daysLeft) : 0,
      /// A este ritmo, quanto se vai gastar no período todo
      projected: elapsed > 0 ? round2((spent / elapsed) * totalDays) : spent,
      /// Fechado: criado com um plano pago que a pessoa já não tem (ver LocksService)
      locked: false,
      createdAt: budget.createdAt,
    };
  }

  /// A amostra de um limite fechado: o nome, o período e o valor do limite —
  /// sem o que já se gastou nem o que falta.
  private teaser(budget: Budget, date: string, s: Settings): Awaited<ReturnType<BudgetsService['compute']>> {
    const period = this.periodOf(budget, date, s);
    const amount = num(budget.amount);
    return {
      id: budget.id,
      name: budget.name,
      amount,
      currency: budget.currency,
      period: budget.period,
      categoryIds: [],
      categories: [],
      alertThresholds: [],
      rollover: false,
      isActive: budget.isActive,
      periodStart: period.start,
      periodEnd: period.end,
      periodKey: period.key,
      carryOver: 0,
      available: amount,
      spent: 0,
      remaining: 0,
      percent: 0,
      status: 'OK',
      daysLeft: 0,
      dailyAllowance: 0,
      projected: 0,
      locked: true,
      createdAt: budget.createdAt,
    };
  }

  /// Por omissão, os limites fechados ficam de fora (Início, quem acompanha os
  /// gastos…). Com `teasers`, vêm como amostra — é o que a lista da app pede.
  async list(userId: string, date?: string, opts: { teasers?: boolean } = {}) {
    const s = await this.settings(userId);
    const day = date ?? todayIn(s.timezone);
    const [budgets, locked] = await Promise.all([
      this.prisma.budget.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      this.locks.lockedIds(userId, 'budgets'),
    ]);
    const items: Array<Awaited<ReturnType<BudgetsService['compute']>>> = [];
    for (const b of budgets) {
      if (!locked.has(b.id)) items.push(await this.compute(userId, b, day, s));
    }
    if (opts.teasers) {
      for (const b of budgets) {
        if (locked.has(b.id)) items.push(this.teaser(b, day, s));
      }
    }
    return items;
  }

  async ownedOrThrow(userId: string, id: string) {
    const budget = await this.prisma.budget.findFirst({ where: { id, userId } });
    if (!budget) throw ApiException.notFound('BUDGET_NOT_FOUND');
    return budget;
  }

  async get(userId: string, id: string, date?: string) {
    const s = await this.settings(userId);
    return this.compute(userId, await this.ownedOrThrow(userId, id), date ?? todayIn(s.timezone), s);
  }

  private async validate(userId: string, dto: UpdateBudgetDto) {
    if (dto.categoryIds?.length) {
      const owned = await this.prisma.category.findMany({ where: { userId, id: { in: dto.categoryIds }, type: 'EXPENSE' }, select: { id: true } });
      if (owned.length !== new Set(dto.categoryIds).size) throw ApiException.notFound('CATEGORY_NOT_FOUND');
    }
    if (dto.alertThresholds && JSON.stringify([...dto.alertThresholds].sort((a, b) => a - b)) !== JSON.stringify(DEFAULT_THRESHOLDS)) {
      await this.entitlements.assertFeature(userId, FEATURES.alertsAdvanced);
    }
    if (dto.rollover) await this.entitlements.assertFeature(userId, FEATURES.budgetsRollover);
    if (dto.currency && !isCurrency(dto.currency)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'currency', message: 'unknown' }]);
  }

  async create(userId: string, dto: CreateBudgetDto) {
    await this.entitlements.assertLimit(userId, 'budgets', await this.prisma.budget.count({ where: { userId, isActive: true } }));
    await this.validate(userId, dto);
    const s = await this.settings(userId);
    const budget = await this.prisma.budget.create({
      data: {
        userId,
        name: dto.name,
        amount: money(dto.amount),
        currency: dto.currency ?? s.currency,
        period: dto.period,
        categoryIds: Array.from(new Set(dto.categoryIds)),
        alertThresholds: (dto.alertThresholds ?? DEFAULT_THRESHOLDS).sort((a, b) => a - b),
        rollover: dto.rollover ?? false,
        isActive: dto.isActive ?? true,
      },
    });
    return this.compute(userId, budget, todayIn(s.timezone), s);
  }

  async update(userId: string, id: string, dto: UpdateBudgetDto) {
    const budget = await this.ownedOrThrow(userId, id);
    await this.validate(userId, dto);
    if (dto.isActive && !budget.isActive) {
      await this.entitlements.assertLimit(userId, 'budgets', await this.prisma.budget.count({ where: { userId, isActive: true } }));
    }
    const updated = await this.prisma.budget.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.amount !== undefined ? { amount: money(dto.amount) } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.period !== undefined ? { period: dto.period } : {}),
        ...(dto.categoryIds !== undefined ? { categoryIds: Array.from(new Set(dto.categoryIds)) } : {}),
        ...(dto.alertThresholds !== undefined ? { alertThresholds: [...dto.alertThresholds].sort((a, b) => a - b) } : {}),
        ...(dto.rollover !== undefined ? { rollover: dto.rollover } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    const s = await this.settings(userId);
    return this.compute(userId, updated, todayIn(s.timezone), s);
  }

  async remove(userId: string, id: string) {
    await this.ownedOrThrow(userId, id);
    await this.prisma.budget.delete({ where: { id } });
    return { deleted: true };
  }

  /// Os últimos N períodos (para o gráfico "como correu").
  async history(userId: string, id: string, periods = 6) {
    const budget = await this.ownedOrThrow(userId, id);
    const s = await this.settings(userId);
    const n = Math.min(Math.max(periods, 1), 24);
    const out: Array<{ key: string; start: string; end: string; amount: number; spent: number }> = [];
    let day = todayIn(s.timezone);
    for (let i = 0; i < n; i++) {
      const period = this.periodOf(budget, day, s);
      out.unshift({ key: period.key, start: period.start, end: period.end, amount: num(budget.amount), spent: await this.spent(userId, budget, period) });
      day = previousPeriod(budget.period, day, { monthStartDay: s.monthStartDay, weekStartsOn: s.weekStartsOn }).end;
    }
    return out;
  }

  /// Depois de uma despesa: avisa quem passou um limiar (uma vez por
  /// período e por limiar; uma só notificação, a do limiar mais alto).
  async checkAlerts(userId: string, date: string) {
    const s = await this.settings(userId);
    const today = todayIn(s.timezone);
    const budgets = await this.prisma.budget.findMany({ where: { userId, isActive: true } });
    // Um limite fechado (sem o plano pago) não avisa.
    const locked = await this.locks.lockedIds(userId, 'budgets');
    for (const budget of budgets) {
      if (locked.has(budget.id)) continue;
      const period = this.periodOf(budget, today, s);
      if (date < period.start || date > period.end) continue;
      const computed = await this.compute(userId, budget, today, s);
      // Sem limiares = a pessoa desligou os avisos deste orçamento.
      const thresholds = budget.alertThresholds.filter((t) => computed.percent >= t);
      if (!thresholds.length) continue;
      const already = await this.prisma.budgetAlert.findMany({ where: { budgetId: budget.id, periodKey: period.key }, select: { threshold: true } });
      const sent = new Set(already.map((a) => a.threshold));
      const fresh = thresholds.filter((t) => !sent.has(t));
      if (!fresh.length) continue;
      await this.prisma.budgetAlert.createMany({
        data: fresh.map((threshold) => ({ budgetId: budget.id, periodKey: period.key, threshold })),
        skipDuplicates: true,
      });
      const exceeded = computed.percent >= 100;
      const data = {
        budgetId: budget.id,
        name: budget.name,
        percent: Math.round(computed.percent),
        spent: computed.spent,
        amount: computed.available,
        currency: budget.currency,
        threshold: Math.max(...fresh),
      };
      await this.notifications.notify(userId, exceeded ? 'budget_exceeded' : 'budget_alert', data, (ctx) => ({
        ...data,
        spent: formatMoney(data.spent, data.currency, ctx.lang, ctx.country),
        amount: formatMoney(data.amount, data.currency, ctx.lang, ctx.country),
      }));
    }
  }
}
