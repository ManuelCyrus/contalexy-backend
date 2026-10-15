import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { LocksService } from '../billing/locks.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApiException } from '../common/errors/api.exception';
import { addDays, daysBetween, fromDbDate, fromDbDateOrNull, todayIn, toDbDate } from '../common/utils/dates';
import { formatMoney, money, num, round2 } from '../common/utils/money';
import { Goal, GoalContribution, GoalStep } from '../generated/prisma/client';
import { ContributionDto, CreateGoalDto, GOAL_STEPS_MAX, GoalStepDto, UpdateGoalDto, UpdateGoalStepDto } from './goals.dto';
import { isCurrency } from '../meta/countries.data';

type GoalWithContributions = Goal & { contributions: GoalContribution[]; steps?: GoalStep[] };

/// O que se carrega com um objetivo: o que lá se pôs e os objetivos específicos.
const goalInclude = { contributions: true, steps: true } as const;

/// Objetivos de poupança: quanto falta, quanto pôr por mês para chegar a
/// tempo e, ao ritmo atual, quando lá chegas.
@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
    private readonly locks: LocksService,
  ) {}

  private async today(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { timezone: true, currency: true } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    return { today: todayIn(user.timezone), currency: user.currency };
  }

  toDto(goal: GoalWithContributions, today: string, withContributions = false) {
    const saved = round2(goal.contributions.reduce((acc, c) => acc + num(c.amount), 0));
    const target = num(goal.targetAmount);
    const remaining = round2(Math.max(0, target - saved));
    const progress = target > 0 ? Math.min(100, round2((saved / target) * 100)) : 0;
    const targetDate = fromDbDateOrNull(goal.targetDate);
    const startDate = fromDbDateOrNull(goal.startDate);
    // O caminho conta-se do dia de início (ou, sem ele, do dia em que o objetivo foi criado).
    const from = startDate ?? goal.createdAt.toISOString().slice(0, 10);
    const notStarted = startDate !== null && startDate > today;

    // Quanto pôr por mês para chegar à data (a contar do início, se ainda não começou).
    let monthlyNeeded: number | null = null;
    let monthsLeft: number | null = null;
    if (targetDate && remaining > 0) {
      const days = daysBetween(notStarted ? from : today, targetDate);
      monthsLeft = Math.max(1, Math.ceil(days / 30.4375));
      monthlyNeeded = days <= 0 ? remaining : round2(remaining / monthsLeft);
    }

    // Onde se devia estar hoje, se o dinheiro entrasse por igual do início ao fim.
    let timePercent: number | null = null;
    let expectedSaved: number | null = null;
    let daysLeft: number | null = null;
    if (targetDate) {
      const total = Math.max(1, daysBetween(from, targetDate));
      const elapsed = Math.min(total, Math.max(0, daysBetween(from, today)));
      timePercent = round2((elapsed / total) * 100);
      expectedSaved = round2((target * elapsed) / total);
      daysLeft = Math.max(0, daysBetween(today, targetDate));
    }

    // Objetivos específicos: feitos, por fazer e os que o dinheiro guardado já cobre (pela ordem).
    const steps = [...(goal.steps ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime());
    let running = 0;
    const stepDtos = steps.map((st) => {
      const amount = st.amount === null ? null : num(st.amount);
      if (amount !== null) running = round2(running + amount);
      return {
        id: st.id,
        title: st.title,
        amount,
        dueDate: fromDbDateOrNull(st.dueDate),
        done: st.doneAt !== null,
        doneAt: st.doneAt,
        /// O que já está guardado chega para este passo (e para os anteriores)
        covered: amount !== null && saved >= running,
        /// Passou da data e ainda não está feito
        overdue: st.doneAt === null && st.dueDate !== null && fromDbDate(st.dueDate) < today,
        sortOrder: st.sortOrder,
      };
    });

    // Ritmo dos últimos 90 dias → data prevista.
    const since = addDays(today, -90);
    const recent = goal.contributions.filter((c) => fromDbDate(c.date) >= since).reduce((acc, c) => acc + num(c.amount), 0);
    const monthlyPace = round2(Math.max(0, recent) / 3);
    let projectedDate: string | null = null;
    if (remaining > 0 && monthlyPace > 0) projectedDate = addDays(today, Math.ceil((remaining / monthlyPace) * 30.4375));
    // Ainda não começou: não há ritmo para avaliar.
    const onTrack = remaining <= 0 ? true : notStarted ? null : targetDate ? (projectedDate !== null && projectedDate <= targetDate) : null;

    return {
      id: goal.id,
      name: goal.name,
      targetAmount: target,
      currency: goal.currency,
      startDate,
      targetDate,
      /// O início ainda está para vir
      notStarted,
      /// Dias até à data-alvo, quanto do tempo já passou (%) e quanto devia estar guardado hoje
      daysLeft,
      timePercent,
      expectedSaved,
      icon: goal.icon,
      color: goal.color,
      accountId: goal.accountId,
      status: goal.status,
      completedAt: goal.completedAt,
      pinned: goal.pinnedAt !== null,
      saved,
      remaining,
      progress,
      monthsLeft,
      monthlyNeeded,
      monthlyPace,
      projectedDate,
      onTrack,
      stepsTotal: stepDtos.length,
      stepsDone: stepDtos.filter((st) => st.done).length,
      /// Fechado: criado com um plano pago que a pessoa já não tem (ver LocksService)
      locked: false,
      createdAt: goal.createdAt,
      ...(withContributions
        ? {
            steps: stepDtos,
            /// Quanto somam os objetivos específicos com valor (para comparar com o alvo)
            stepsAmount: running,
            contributions: [...goal.contributions]
              .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt.getTime() - a.createdAt.getTime()))
              .map((c) => ({ id: c.id, amount: num(c.amount), date: fromDbDate(c.date), note: c.note, planned: c.depositId !== null, createdAt: c.createdAt })),
          }
        : {}),
    };
  }

  /// A amostra de um objetivo fechado: o nome, o valor a que se quer chegar
  /// e quanto já ia (em %) — o resto fica por ver até a pessoa voltar ao plano.
  private teaser(goal: GoalWithContributions, today: string) {
    const real = this.toDto(goal, today);
    return {
      ...this.toDto({ ...goal, contributions: [], steps: [], startDate: null, targetDate: null, accountId: null, pinnedAt: null }, today),
      progress: Math.round(real.progress),
      locked: true,
    };
  }

  /// Por omissão, os objetivos fechados ficam de fora (o Início, as contas do
  /// simulador, quem acompanha os gastos… não os veem). Com `teasers`, vêm
  /// como amostra — é o que a lista da app pede.
  async list(userId: string, includeArchived = false, opts: { teasers?: boolean } = {}) {
    const { today } = await this.today(userId);
    const [goals, locked] = await Promise.all([
      this.prisma.goal.findMany({
        where: { userId, ...(includeArchived ? {} : { status: { not: 'ARCHIVED' } }) },
        include: goalInclude,
        orderBy: [{ status: 'asc' }, { targetDate: 'asc' }, { createdAt: 'asc' }],
      }),
      this.locks.lockedIds(userId, 'goals'),
    ]);
    // Os fixados primeiro (dentro dos ativos); os fechados no fim.
    goals.sort(
      (a, b) =>
        Number(locked.has(a.id)) - Number(locked.has(b.id)) ||
        Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') ||
        (b.pinnedAt?.getTime() ?? 0) - (a.pinnedAt?.getTime() ?? 0),
    );
    const out: Array<ReturnType<GoalsService['toDto']>> = [];
    for (const g of goals) {
      if (!locked.has(g.id)) out.push(this.toDto(g, today));
      else if (opts.teasers) out.push(this.teaser(g, today));
    }
    return out;
  }

  private async ownedOrThrow(userId: string, id: string) {
    const goal = await this.prisma.goal.findFirst({ where: { id, userId }, include: goalInclude });
    if (!goal) throw ApiException.notFound('GOAL_NOT_FOUND');
    return goal;
  }

  async get(userId: string, id: string) {
    const { today } = await this.today(userId);
    return this.toDto(await this.ownedOrThrow(userId, id), today, true);
  }

  private async assertAccount(userId: string, accountId?: string | null) {
    if (!accountId) return;
    const account = await this.prisma.account.findFirst({ where: { id: accountId, userId }, select: { id: true } });
    if (!account) throw ApiException.notFound('ACCOUNT_NOT_FOUND');
  }

  async create(userId: string, dto: CreateGoalDto) {
    await this.entitlements.assertLimit(userId, 'goals', await this.prisma.goal.count({ where: { userId, status: 'ACTIVE' } }));
    await this.assertAccount(userId, dto.accountId);
    const { today, currency } = await this.today(userId);
    if (dto.currency && !isCurrency(dto.currency)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'currency', message: 'unknown' }]);
    if (dto.startDate && dto.targetDate && dto.targetDate < dto.startDate) throw ApiException.badRequest('DATE_RANGE_INVALID');
    const end = dto.targetDate ?? null;
    if (end && dto.steps?.some((st) => !!st.dueDate && st.dueDate > end)) throw ApiException.badRequest('GOAL_STEP_AFTER_END');
    const goal = await this.prisma.goal.create({
      data: {
        userId,
        name: dto.name,
        targetAmount: money(dto.targetAmount),
        currency: dto.currency ?? currency,
        startDate: dto.startDate ? toDbDate(dto.startDate) : null,
        targetDate: dto.targetDate ? toDbDate(dto.targetDate) : null,
        ...(dto.steps?.length
          ? { steps: { create: dto.steps.map((st, index) => ({ title: st.title, amount: st.amount != null ? money(st.amount) : null, dueDate: st.dueDate ? toDbDate(st.dueDate) : null, doneAt: st.done ? new Date() : null, sortOrder: index })) } }
          : {}),
        icon: dto.icon ?? 'flag',
        color: dto.color ?? '#12B886',
        accountId: dto.accountId ?? null,
        pinnedAt: dto.pinned ? new Date() : null,
        ...(dto.initialAmount ? { contributions: { create: { userId, amount: money(dto.initialAmount), date: toDbDate(today) } } } : {}),
      },
      include: goalInclude,
    });
    return this.toDto(await this.checkCompleted(goal, today), today, true);
  }

  async update(userId: string, id: string, dto: UpdateGoalDto) {
    const goal = await this.ownedOrThrow(userId, id);
    await this.assertAccount(userId, dto.accountId);
    if (dto.status === 'ACTIVE' && goal.status !== 'ACTIVE') {
      await this.entitlements.assertLimit(userId, 'goals', await this.prisma.goal.count({ where: { userId, status: 'ACTIVE' } }));
    }
    const { today } = await this.today(userId);
    const start = dto.startDate !== undefined ? dto.startDate : fromDbDateOrNull(goal.startDate);
    const end = dto.targetDate !== undefined ? dto.targetDate : fromDbDateOrNull(goal.targetDate);
    if (start && end && end < start) throw ApiException.badRequest('DATE_RANGE_INVALID');
    await this.prisma.goal.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.targetAmount !== undefined ? { targetAmount: money(dto.targetAmount) } : {}),
        ...(dto.startDate !== undefined ? { startDate: dto.startDate ? toDbDate(dto.startDate) : null } : {}),
        ...(dto.targetDate !== undefined ? { targetDate: dto.targetDate ? toDbDate(dto.targetDate) : null } : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.accountId !== undefined ? { accountId: dto.accountId } : {}),
        ...(dto.status !== undefined ? { status: dto.status, completedAt: dto.status === 'COMPLETED' ? (goal.completedAt ?? new Date()) : null } : {}),
        ...(dto.pinned !== undefined ? { pinnedAt: dto.pinned ? (goal.pinnedAt ?? new Date()) : null } : {}),
      },
    });
    // Encurtar o objetivo puxa para o novo fim os objetivos específicos que ficavam depois dele.
    if (dto.targetDate) await this.prisma.goalStep.updateMany({ where: { goalId: id, dueDate: { gt: toDbDate(dto.targetDate) } }, data: { dueDate: toDbDate(dto.targetDate) } });
    const updated = await this.ownedOrThrow(userId, id);
    return this.toDto(dto.status ? updated : await this.checkCompleted(updated, today), today, true);
  }

  async remove(userId: string, id: string) {
    await this.ownedOrThrow(userId, id);
    await this.prisma.goal.delete({ where: { id } });
    return { deleted: true };
  }

  // ------------------------------------------------------------------
  // Objetivos específicos (as partes do caminho)
  // ------------------------------------------------------------------

  async addStep(userId: string, id: string, dto: GoalStepDto) {
    const goal = await this.ownedOrThrow(userId, id);
    const steps = goal.steps ?? [];
    if (steps.length >= GOAL_STEPS_MAX) throw ApiException.badRequest('GOAL_STEPS_LIMIT', { max: GOAL_STEPS_MAX });
    if (dto.dueDate && goal.targetDate && dto.dueDate > fromDbDate(goal.targetDate)) throw ApiException.badRequest('GOAL_STEP_AFTER_END');
    const last = steps.reduce((max, st) => Math.max(max, st.sortOrder), -1);
    await this.prisma.goalStep.create({
      data: { goalId: id, title: dto.title, amount: dto.amount != null ? money(dto.amount) : null, dueDate: dto.dueDate ? toDbDate(dto.dueDate) : null, doneAt: dto.done ? new Date() : null, sortOrder: last + 1 },
    });
    return this.get(userId, id);
  }

  async updateStep(userId: string, id: string, stepId: string, dto: UpdateGoalStepDto) {
    const goal = await this.ownedOrThrow(userId, id);
    const step = (goal.steps ?? []).find((st) => st.id === stepId);
    if (!step) throw ApiException.notFound('GOAL_STEP_NOT_FOUND');
    if (dto.dueDate && goal.targetDate && dto.dueDate > fromDbDate(goal.targetDate)) throw ApiException.badRequest('GOAL_STEP_AFTER_END');
    await this.prisma.goalStep.update({
      where: { id: stepId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.amount !== undefined ? { amount: dto.amount === null ? null : money(dto.amount) } : {}),
        ...(dto.dueDate !== undefined ? { dueDate: dto.dueDate ? toDbDate(dto.dueDate) : null } : {}),
        ...(dto.done !== undefined ? { doneAt: dto.done ? (step.doneAt ?? new Date()) : null } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
    return this.get(userId, id);
  }

  async removeStep(userId: string, id: string, stepId: string) {
    await this.ownedOrThrow(userId, id);
    const result = await this.prisma.goalStep.deleteMany({ where: { id: stepId, goalId: id } });
    if (!result.count) throw ApiException.notFound('GOAL_STEP_NOT_FOUND');
    return this.get(userId, id);
  }

  /// `extra.depositId`: a entrada veio de um depósito planeado.
  async contribute(userId: string, id: string, dto: ContributionDto, extra: { depositId?: string } = {}) {
    const goal = await this.ownedOrThrow(userId, id);
    const { today } = await this.today(userId);
    const before = this.toDto(goal, today).progress;
    await this.prisma.goalContribution.create({
      data: { goalId: goal.id, userId, amount: money(dto.amount), date: toDbDate(dto.date ?? today), note: dto.note ?? null, depositId: extra.depositId ?? null },
    });
    const updated = await this.ownedOrThrow(userId, id);
    const result = this.toDto(await this.checkCompleted(updated, today), today, true);
    // "Falta pouco": avisa uma vez, no momento em que passa dos 90%.
    if (before < 90 && result.progress >= 90 && result.remaining > 0) {
      const data = { goalId: goal.id, name: goal.name, remaining: result.remaining, currency: goal.currency, percent: Math.round(result.progress) };
      await this.notifications.notify(userId, 'goal_almost', data, (ctx) => ({ ...data, remaining: formatMoney(data.remaining, data.currency, ctx.lang, ctx.country) }));
    }
    return result;
  }

  async removeContribution(userId: string, id: string, contributionId: string) {
    const goal = await this.ownedOrThrow(userId, id);
    const result = await this.prisma.goalContribution.deleteMany({ where: { id: contributionId, goalId: goal.id } });
    if (!result.count) throw ApiException.notFound('CONTRIBUTION_NOT_FOUND');
    const { today } = await this.today(userId);
    const updated = await this.ownedOrThrow(userId, id);
    // Voltou a ficar abaixo do alvo → volta a ativo.
    const dto = this.toDto(updated, today);
    if (updated.status === 'COMPLETED' && dto.remaining > 0) {
      await this.prisma.goal.update({ where: { id }, data: { status: 'ACTIVE', completedAt: null } });
    }
    return this.toDto(await this.ownedOrThrow(userId, id), today, true);
  }

  /// Chegou ao alvo → concluído + parabéns (uma vez).
  private async checkCompleted(goal: GoalWithContributions, today: string): Promise<GoalWithContributions> {
    if (goal.status !== 'ACTIVE') return goal;
    const dto = this.toDto(goal, today);
    if (dto.remaining > 0) return goal;
    await this.prisma.goal.update({ where: { id: goal.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    const data = { goalId: goal.id, name: goal.name, amount: dto.targetAmount, currency: goal.currency };
    await this.notifications.notify(goal.userId, 'goal_completed', data, (ctx) => ({ ...data, amount: formatMoney(data.amount, data.currency, ctx.lang, ctx.country) }));
    return { ...goal, status: 'COMPLETED', completedAt: new Date() };
  }
}
