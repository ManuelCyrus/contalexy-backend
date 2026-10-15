import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MonthlyPlansService } from '../monthly-plans/monthly-plans.service';
import { ApiException } from '../common/errors/api.exception';
import { addDays, DateOnly, todayIn, toDbDate, fromDbDate } from '../common/utils/dates';
import { formatMoney, money, num, numOrNull, round2 } from '../common/utils/money';

export type DailyStatus = 'OK' | 'WARNING' | 'REACHED' | 'EXCEEDED';

/// Como está o dia: abaixo de 80% do limite está bem; depois avisa; ao chegar
/// ao limite fica "atingido"; acima dele, "ultrapassado". Com limite 0 (dia
/// sem gastos) qualquer despesa ultrapassa.
export function dailyStatus(limit: number, spent: number): DailyStatus {
  if (spent > limit) return 'EXCEEDED';
  if (limit <= 0) return 'OK';
  if (spent >= limit) return 'REACHED';
  return spent >= limit * 0.8 ? 'WARNING' : 'OK';
}

/// Até onde se deve ter avisado, dado o estado (0 = nada, 80 = quase, 100 = chegou).
export function alertLevelFor(status: DailyStatus): number {
  return status === 'EXCEEDED' || status === 'REACHED' ? 100 : status === 'WARNING' ? 80 : 0;
}

/// Limite de gastos por dia: "hoje podes gastar X, faltam Y".
///
/// Há um limite de todos os dias (na conta) e, se a pessoa quiser, um limite
/// só para hoje. Contam as despesas do dia, menos as fixas (renda, mensalidades
/// registadas pelas despesas fixas): o limite é para o que se decide no dia.
@Injectable()
export class DailyLimitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exchange: ExchangeService,
    private readonly notifications: NotificationsService,
    private readonly monthlyPlans: MonthlyPlansService,
  ) {}

  private async settings(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true, timezone: true, dailyLimit: true } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    return { currency: user.currency, today: todayIn(user.timezone), defaultLimit: numOrNull(user.dailyLimit) };
  }

  /// Quanto se gastou em cada dia do intervalo (na moeda principal), sem as despesas fixas.
  private async spentByDay(userId: string, from: DateOnly, to: DateOnly, currency: string): Promise<Map<DateOnly, number>> {
    const rows = await this.prisma.transaction.groupBy({
      by: ['date', 'currency'],
      where: { userId, type: 'EXPENSE', excludeFromReports: false, recurringRuleId: null, date: { gte: toDbDate(from), lte: toDbDate(to) } },
      _sum: { amount: true },
    });
    const out = new Map<DateOnly, number>();
    for (const row of rows) {
      const day = fromDbDate(row.date);
      out.set(day, round2((out.get(day) ?? 0) + (this.exchange.convert(num(row._sum.amount), row.currency, currency) ?? 0)));
    }
    return out;
  }

  private state(date: DateOnly, limit: number | null, spent: number) {
    return {
      date,
      /// null = sem limite neste dia
      limit,
      spent,
      /// Quanto ainda dá para gastar (negativo = já passou)
      left: limit === null ? null : round2(limit - spent),
      percent: limit === null || limit <= 0 ? null : round2((spent / limit) * 100),
      status: limit === null ? null : dailyStatus(limit, spent),
    };
  }

  /// O dia de hoje. `week` junta os últimos 7 dias; `suggest`, o que o plano
  /// do mês deixa gastar por dia (para quem ainda não escolheu um limite).
  async get(userId: string, opts: { week?: boolean; suggest?: boolean } = {}) {
    const s = await this.settings(userId);
    const from = opts.week ? addDays(s.today, -6) : s.today;
    const [days, spent] = await Promise.all([
      this.prisma.dailyLimitDay.findMany({ where: { userId, date: { gte: toDbDate(from), lte: toDbDate(s.today) } } }),
      this.spentByDay(userId, from, s.today, s.currency),
    ]);
    const override = new Map(days.filter((d) => d.amount !== null).map((d) => [fromDbDate(d.date), num(d.amount)]));
    const limitOf = (day: DateOnly) => override.get(day) ?? s.defaultLimit;
    let suggestion: number | null = null;
    if (opts.suggest) {
      const plan = await this.monthlyPlans.current(userId, { suggestion: false }).catch(() => null);
      const allowance = plan?.plan?.dailyAllowance ?? null;
      suggestion = allowance !== null && allowance > 0 ? Math.floor(allowance) : null;
    }
    return {
      ...this.state(s.today, limitOf(s.today), spent.get(s.today) ?? 0),
      currency: s.currency,
      /// O limite de todos os dias (null = não há)
      defaultLimit: s.defaultLimit,
      /// Hoje tem um limite próprio, diferente do de todos os dias
      onlyToday: override.has(s.today),
      ...(opts.week
        ? { week: Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((day) => this.state(day, limitOf(day), spent.get(day) ?? 0)) }
        : {}),
      ...(opts.suggest ? { suggestion } : {}),
    };
  }

  /// Define o limite: o de todos os dias ou, com `onlyToday`, só o de hoje.
  /// `amount` null tira-o (no "só hoje", volta a valer o de todos os dias).
  async set(userId: string, dto: { amount: number | null; onlyToday?: boolean }) {
    const s = await this.settings(userId);
    const key = { userId_date: { userId, date: toDbDate(s.today) } };
    if (dto.onlyToday) {
      const amount = dto.amount === null ? null : money(dto.amount);
      // Mudar o limite do dia volta a pôr os avisos a zeros (avisa pelo limite novo).
      await this.prisma.dailyLimitDay.upsert({ where: key, create: { userId, date: toDbDate(s.today), amount }, update: { amount, alertLevel: 0 } });
    } else {
      await this.prisma.user.update({ where: { id: userId }, data: { dailyLimit: dto.amount === null ? null : money(dto.amount) } });
      await this.prisma.dailyLimitDay.updateMany({ where: { userId, date: toDbDate(s.today) }, data: { alertLevel: 0 } });
    }
    // Já gasto para lá do limite novo: fica registado, sem aviso (a pessoa acabou de o ver).
    const now = await this.get(userId, { week: true });
    if (now.status) {
      const level = alertLevelFor(now.status);
      if (level > 0) await this.prisma.dailyLimitDay.upsert({ where: key, create: { userId, date: toDbDate(s.today), alertLevel: level }, update: { alertLevel: level } });
    }
    return now;
  }

  /// Depois de uma despesa de hoje: avisa quando se chega aos 80% do limite e
  /// quando se chega ao limite (cada aviso uma vez por dia).
  async checkAlerts(userId: string, date: DateOnly) {
    const s = await this.settings(userId);
    if (date !== s.today) return;
    const now = await this.get(userId);
    if (now.limit === null || now.status === null) return;
    const level = alertLevelFor(now.status);
    if (level === 0) return;
    const key = { userId_date: { userId, date: toDbDate(s.today) } };
    const day = await this.prisma.dailyLimitDay.findUnique({ where: key });
    if ((day?.alertLevel ?? 0) >= level) return;
    await this.prisma.dailyLimitDay.upsert({ where: key, create: { userId, date: toDbDate(s.today), alertLevel: level }, update: { alertLevel: level } });
    const data = { date: s.today, limit: now.limit, spent: now.spent, left: now.left ?? 0, currency: s.currency };
    const type = now.status === 'EXCEEDED' ? 'daily_limit_exceeded' : now.status === 'REACHED' ? 'daily_limit_reached' : 'daily_limit_warning';
    await this.notifications.notify(userId, type, data, (ctx) => ({
      limit: formatMoney(data.limit, data.currency, ctx.lang, ctx.country),
      spent: formatMoney(data.spent, data.currency, ctx.lang, ctx.country),
      left: formatMoney(Math.abs(data.left), data.currency, ctx.lang, ctx.country),
    }));
  }
}
