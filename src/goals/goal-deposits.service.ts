import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LocksService } from '../billing/locks.service';
import { ApiException } from '../common/errors/api.exception';
import { env, isTrue } from '../config/env';
import { addDays, daysBetween, fromDbDate, fromDbDateOrNull, localHour, todayIn, toDbDate } from '../common/utils/dates';
import { formatMoney, money, num, round2 } from '../common/utils/money';
import { GoalDeposit, Prisma } from '../generated/prisma/client';
import { GoalsService } from './goals.service';
import { ConfirmDepositDto, DepositDto, UpdateDepositDto } from './goals.dto';
import { depositDates, DepositSchedule, nextDepositDate, plannedPerMonth, projectedByPlan } from './deposits';

/// Quantos depósitos planeados cabem num objetivo.
const MAX_PER_GOAL = 24;
/// Um depósito automático com mais dias de atraso do que isto já não se
/// regista sozinho (evita "despejar" meses de depósitos de uma vez).
const AUTO_GRACE_DAYS = 3;

const goalInfo = { select: { id: true, name: true, currency: true, icon: true, color: true, status: true } } satisfies Prisma.GoalDefaultArgs;
type DepositWithGoal = Prisma.GoalDepositGetPayload<{ include: { goal: typeof goalInfo } }>;

/// Depósitos planeados num objetivo: "no dia 28 vou pôr 100" ou "todos os
/// dias 28 passo a pôr 100". No dia, a app lembra — ou regista sozinha, se a
/// pessoa assim escolheu. Tudo aparece no calendário.
@Injectable()
export class GoalDepositsService {
  private readonly logger = new Logger(GoalDepositsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly goals: GoalsService,
    private readonly notifications: NotificationsService,
    private readonly locks: LocksService,
  ) {}

  private async today(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    return todayIn(user.timezone);
  }

  private schedule(d: GoalDeposit): DepositSchedule {
    return { amount: num(d.amount), frequency: d.frequency, startDate: fromDbDate(d.startDate), nextDate: fromDbDate(d.nextDate), endDate: fromDbDateOrNull(d.endDate) };
  }

  toDto(d: GoalDeposit, today: string) {
    const next = fromDbDate(d.nextDate);
    return {
      id: d.id,
      goalId: d.goalId,
      amount: num(d.amount),
      frequency: d.frequency,
      startDate: fromDbDate(d.startDate),
      nextDate: next,
      endDate: fromDbDateOrNull(d.endDate),
      autoApply: d.autoApply,
      note: d.note,
      isActive: d.isActive,
      /// O dia já chegou (ou passou) e ainda está por tratar
      due: d.isActive && next <= today,
      overdue: d.isActive && next < today,
      daysUntil: daysBetween(today, next),
    };
  }

  private async goalOrThrow(userId: string, goalId: string) {
    const goal = await this.prisma.goal.findFirst({ where: { id: goalId, userId }, select: { id: true, status: true, currency: true, name: true } });
    if (!goal) throw ApiException.notFound('GOAL_NOT_FOUND');
    return goal;
  }

  private async depositOrThrow(userId: string, goalId: string, depositId: string) {
    const deposit = await this.prisma.goalDeposit.findFirst({ where: { id: depositId, goalId, userId } });
    if (!deposit) throw ApiException.notFound('GOAL_DEPOSIT_NOT_FOUND');
    return deposit;
  }

  /// O que se junta ao detalhe de um objetivo: os depósitos planeados,
  /// quanto somam por mês e quando se chega lá só com eles.
  async summary(userId: string, goalId: string, remaining: number) {
    const today = await this.today(userId);
    const rows = await this.prisma.goalDeposit.findMany({ where: { goalId, userId }, orderBy: [{ isActive: 'desc' }, { nextDate: 'asc' }] });
    const active = rows.filter((d) => d.isActive).map((d) => this.schedule(d));
    return {
      deposits: rows.map((d) => this.toDto(d, today)),
      plannedMonthly: plannedPerMonth(active),
      plannedDate: active.length ? projectedByPlan(remaining, active, today) : null,
    };
  }

  /// O objetivo completo (com os depósitos planeados) — a resposta de todas as rotas daqui.
  async detail(userId: string, goalId: string) {
    const goal = await this.goals.get(userId, goalId);
    return { ...goal, ...(await this.summary(userId, goalId, goal.remaining)) };
  }

  async create(userId: string, goalId: string, dto: DepositDto) {
    const goal = await this.goalOrThrow(userId, goalId);
    if (goal.status !== 'ACTIVE') throw ApiException.badRequest('GOAL_NOT_ACTIVE');
    const today = await this.today(userId);
    if (dto.date < today) throw ApiException.badRequest('DEPOSIT_DATE_PAST');
    if (dto.endDate && dto.endDate < dto.date) throw ApiException.badRequest('DATE_RANGE_INVALID');
    const count = await this.prisma.goalDeposit.count({ where: { goalId, isActive: true } });
    if (count >= MAX_PER_GOAL) throw ApiException.badRequest('GOAL_DEPOSITS_LIMIT', { max: MAX_PER_GOAL });
    await this.prisma.goalDeposit.create({
      data: {
        goalId,
        userId,
        amount: money(dto.amount),
        frequency: dto.frequency ?? 'ONCE',
        startDate: toDbDate(dto.date),
        nextDate: toDbDate(dto.date),
        endDate: dto.frequency && dto.frequency !== 'ONCE' && dto.endDate ? toDbDate(dto.endDate) : null,
        autoApply: dto.autoApply ?? false,
        note: dto.note ?? null,
      },
    });
    return this.detail(userId, goalId);
  }

  async update(userId: string, goalId: string, depositId: string, dto: UpdateDepositDto) {
    const deposit = await this.depositOrThrow(userId, goalId, depositId);
    const today = await this.today(userId);
    const frequency = dto.frequency ?? deposit.frequency;
    // Mudar o dia ou a frequência recomeça a contagem a partir do dia novo.
    const reschedule = dto.date !== undefined || (dto.frequency !== undefined && dto.frequency !== deposit.frequency);
    const start = dto.date ?? fromDbDate(deposit.nextDate);
    if (dto.date !== undefined && dto.date < today) throw ApiException.badRequest('DEPOSIT_DATE_PAST');
    const end = frequency === 'ONCE' ? null : dto.endDate !== undefined ? dto.endDate : fromDbDateOrNull(deposit.endDate);
    if (end && end < start) throw ApiException.badRequest('DATE_RANGE_INVALID');
    await this.prisma.goalDeposit.update({
      where: { id: deposit.id },
      data: {
        ...(dto.amount !== undefined ? { amount: money(dto.amount) } : {}),
        frequency,
        endDate: end ? toDbDate(end) : null,
        ...(reschedule ? { startDate: toDbDate(start), nextDate: toDbDate(start), lastReminderFor: null } : {}),
        ...(dto.autoApply !== undefined ? { autoApply: dto.autoApply } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    return this.detail(userId, goalId);
  }

  async remove(userId: string, goalId: string, depositId: string) {
    const deposit = await this.depositOrThrow(userId, goalId, depositId);
    await this.prisma.goalDeposit.delete({ where: { id: deposit.id } });
    return this.detail(userId, goalId);
  }

  /// Passa para a ocorrência seguinte — ou fecha o plano, se era a última.
  private async advance(deposit: GoalDeposit, after: string) {
    const next = nextDepositDate(this.schedule(deposit), after);
    return this.prisma.goalDeposit.update({
      where: { id: deposit.id },
      data: next ? { nextDate: toDbDate(next), lastReminderFor: null } : { isActive: false },
    });
  }

  /// "Depositei": regista a entrada no objetivo e avança.
  async confirm(userId: string, goalId: string, depositId: string, dto: ConfirmDepositDto) {
    const deposit = await this.depositOrThrow(userId, goalId, depositId);
    if (!deposit.isActive) throw ApiException.badRequest('GOAL_DEPOSIT_CLOSED');
    const goal = await this.goalOrThrow(userId, goalId);
    if (goal.status !== 'ACTIVE') throw ApiException.badRequest('GOAL_NOT_ACTIVE');
    const today = await this.today(userId);
    const occurrence = fromDbDate(deposit.nextDate);
    await this.goals.contribute(
      userId,
      goalId,
      { amount: dto.amount ?? num(deposit.amount), date: dto.date ?? (occurrence <= today ? occurrence : today), note: deposit.note },
      { depositId: deposit.id },
    );
    await this.advance(deposit, occurrence);
    return this.detail(userId, goalId);
  }

  /// "Desta vez não": avança sem registar nada.
  async skip(userId: string, goalId: string, depositId: string) {
    const deposit = await this.depositOrThrow(userId, goalId, depositId);
    if (!deposit.isActive) throw ApiException.badRequest('GOAL_DEPOSIT_CLOSED');
    await this.advance(deposit, fromDbDate(deposit.nextDate));
    return this.detail(userId, goalId);
  }

  /// As datas dos depósitos planeados (de objetivos ativos) até `to` — para o
  /// calendário e para "o que aí vem". As que já passaram contam como em atraso.
  async occurrences(userId: string, to: string) {
    const today = await this.today(userId);
    // Os depósitos de objetivos fechados (sem o plano pago) ficam parados.
    const locked = await this.locks.lockedIds(userId, 'goals');
    const rows: DepositWithGoal[] = await this.prisma.goalDeposit.findMany({
      where: { userId, isActive: true, nextDate: { lte: toDbDate(to) }, goal: { status: 'ACTIVE' }, ...(locked.size ? { goalId: { notIn: [...locked] } } : {}) },
      include: { goal: goalInfo },
    });
    const items: Array<{
      depositId: string;
      goalId: string;
      name: string;
      icon: string;
      color: string;
      date: string;
      amount: number;
      currency: string;
      frequency: string;
      autoApply: boolean;
      overdue: boolean;
      daysUntil: number;
    }> = [];
    for (const d of rows) {
      for (const date of depositDates(this.schedule(d), to, 60)) {
        items.push({
          depositId: d.id,
          goalId: d.goalId,
          name: d.goal.name,
          icon: d.goal.icon,
          color: d.goal.color,
          date,
          amount: num(d.amount),
          currency: d.goal.currency,
          frequency: d.frequency,
          autoApply: d.autoApply,
          overdue: date < today,
          daysUntil: daysBetween(today, date),
        });
      }
    }
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { today, items };
  }

  async upcoming(userId: string, days = 30) {
    const today = await this.today(userId);
    const { items } = await this.occurrences(userId, addDays(today, Math.min(Math.max(days, 1), 366)));
    return { today, items, total: round2(items.reduce((acc, i) => acc + i.amount, 0)) };
  }

  // ----------------------------------------------------------------
  // De hora a hora: registar os automáticos e lembrar os outros
  // ----------------------------------------------------------------

  @Cron('20 * * * *')
  async hourlyJob() {
    if (!isTrue(env().JOBS_ENABLED)) return;
    await this.runDue();
    await this.sendReminders();
  }

  private dueQuery(now: Date, autoApply: boolean) {
    // Margem de um dia (fusos): cada pessoa confirma o seu "hoje".
    return this.prisma.goalDeposit.findMany({
      where: { isActive: true, autoApply, nextDate: { lte: toDbDate(addDays(fromDbDate(now), 1)) }, goal: { status: 'ACTIVE' } },
      include: { goal: { select: { id: true, name: true, currency: true, status: true, user: { select: { timezone: true } } } } },
      take: 2000,
    });
  }

  /// Depósitos automáticos em dia: entram sozinhos no objetivo.
  async runDue(now = new Date()) {
    let created = 0;
    const isLocked = this.locks.checker('goals');
    for (const first of await this.dueQuery(now, true)) {
      // Objetivo fechado: nada entra sozinho até a pessoa voltar ao plano.
      if (await isLocked(first.userId, first.goalId)) continue;
      const today = todayIn(first.goal.user.timezone, now);
      let current: GoalDeposit = first;
      for (let guard = 0; guard < 12 && current.isActive && fromDbDate(current.nextDate) <= today; guard++) {
        const date = fromDbDate(current.nextDate);
        if (daysBetween(date, today) <= AUTO_GRACE_DAYS) {
          try {
            const goal = await this.goals.contribute(first.userId, first.goalId, { amount: num(current.amount), date, note: current.note }, { depositId: current.id });
            created++;
            const data = { goalId: first.goalId, depositId: current.id, name: first.goal.name, amount: num(current.amount), currency: first.goal.currency, date };
            await this.notifications.notify(first.userId, 'goal_deposit_done', data, (ctx) => ({ ...data, amount: formatMoney(data.amount, data.currency, ctx.lang, ctx.country) }));
            current = await this.advance(current, date);
            // Chegou ao alvo: o resto do plano já não é preciso.
            if (goal.status !== 'ACTIVE') break;
            continue;
          } catch (err) {
            this.logger.warn(`Depósito planeado ${current.id}: não foi possível registar (${(err as Error).message}).`);
            break;
          }
        }
        current = await this.advance(current, date);
      }
    }
    if (created) this.logger.log(`Depósitos planeados: ${created} registado(s).`);
    return created;
  }

  /// Os que não são automáticos: lembra no dia (uma vez por data, de dia).
  async sendReminders(now = new Date()) {
    let sent = 0;
    const isLocked = this.locks.checker('goals');
    for (const d of await this.dueQuery(now, false)) {
      if (await isLocked(d.userId, d.goalId)) continue;
      const timezone = d.goal.user.timezone;
      const today = todayIn(timezone, now);
      const next = fromDbDate(d.nextDate);
      if (next > today) continue;
      const hour = localHour(timezone, now);
      if (hour < 9 || hour > 20) continue;
      if (d.lastReminderFor && fromDbDate(d.lastReminderFor) === next) continue;
      const data = { goalId: d.goalId, depositId: d.id, name: d.goal.name, amount: num(d.amount), currency: d.goal.currency, date: next };
      await this.notifications.notify(d.userId, 'goal_deposit_due', data, (ctx) => ({ ...data, amount: formatMoney(data.amount, data.currency, ctx.lang, ctx.country) }));
      await this.prisma.goalDeposit.update({ where: { id: d.id }, data: { lastReminderFor: d.nextDate } });
      sent++;
    }
    return sent;
  }
}
