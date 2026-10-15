import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ExchangeService } from '../exchange/exchange.service';
import { TransactionsService } from '../transactions/transactions.service';
import { SpacesService } from './spaces.service';
import { ApiException } from '../common/errors/api.exception';
import { endOfMonth, fromDbDate, fromDbDateOrNull, isMonthKey, todayIn, toDbDate } from '../common/utils/dates';
import { formatMoney, money, num, round2 } from '../common/utils/money';
import { Language, resolveLanguage } from '../common/i18n/messages';
import { Prisma, SpaceGoal } from '../generated/prisma/client';
import { FORMER_DEPOSITOR } from './pot';
import { DepositDto, SpaceGoalDto, SpacePlanDto, UpdateSpaceGoalDto, WithdrawDto } from './spaces.dto';

/// Metas por Space (as arquivadas não contam).
export const SPACE_GOALS_MAX = 20;

const userSelect = { select: { id: true, name: true, username: true, avatarUrl: true } } as const;
type Person = { id: string; name: string; username: string | null; avatarUrl: string | null };

const depositInclude = { user: userSelect, goal: { select: { id: true, name: true } } } satisfies Prisma.SpaceDepositInclude;
type DepositWithRelations = Prisma.SpaceDepositGetPayload<{ include: typeof depositInclude }>;

/// Como fica escrito o movimento na conta pessoal de quem depositou/levantou.
const MOVEMENT_TEXT: Record<Language, { deposit: string; withdrawal: string }> = {
  pt: { deposit: 'Depósito no fundo', withdrawal: 'Levantamento do fundo' },
  en: { deposit: 'Deposit to the shared fund', withdrawal: 'Withdrawal from the shared fund' },
  fr: { deposit: 'Dépôt dans la cagnotte', withdrawal: 'Retrait de la cagnotte' },
  de: { deposit: 'Einzahlung in die Gemeinschaftskasse', withdrawal: 'Auszahlung aus der Gemeinschaftskasse' },
};

interface MoneyData {
  amount?: number;
  currency?: string;
  [key: string]: unknown;
}

/// O plano em grupo de um Space: um fundo comum onde cada pessoa põe
/// dinheiro, metas que o grupo junta em conjunto, e quanto se quer gastar
/// em cada coisa. As despesas "pagas com o fundo" saem daqui (e não criam
/// dívidas entre as pessoas).
@Injectable()
export class SpaceFundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpacesService,
    private readonly notifications: NotificationsService,
    private readonly exchange: ExchangeService,
    private readonly transactions: TransactionsService,
  ) {}

  private async actor(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, timezone: true, language: true, country: true } });
    return { name: u?.name ?? '', today: todayIn(u?.timezone ?? 'UTC'), lang: resolveLanguage(u?.language), country: u?.country ?? undefined };
  }

  /// Avisa os outros membros (os valores vão formatados na língua de cada um).
  private async tellOthers(spaceId: string, exceptId: string, type: string, data: MoneyData) {
    const members = await this.prisma.spaceMember.findMany({ where: { spaceId, userId: { not: exceptId } }, select: { userId: true } });
    const { amount, currency } = data;
    await Promise.all(
      members.map((m) =>
        this.notifications.notify(m.userId, type, data, (ctx) => ({
          ...data,
          ...(typeof amount === 'number' && currency ? { amount: formatMoney(amount, currency, ctx.lang, ctx.country) } : {}),
        })),
      ),
    );
  }

  private depositDto(d: DepositWithRelations, userId: string, admin: boolean) {
    const amount = num(d.amount);
    return {
      id: d.id,
      userId: d.userId,
      user: d.user,
      /// Positivo = pôs no fundo; negativo = tirou
      amount,
      kind: amount < 0 ? ('withdrawal' as const) : ('deposit' as const),
      currency: d.currency,
      date: fromDbDate(d.date),
      note: d.note,
      goal: d.goal,
      mine: d.userId === userId,
      canRemove: d.userId === userId || admin,
      /// Só quem depositou sabe se ficou registado na sua conta pessoal
      inMyAccount: d.userId === userId && !!d.transactionId,
      createdAt: d.createdAt,
    };
  }

  // ----------------------------------------------------------------
  // O fundo
  // ----------------------------------------------------------------

  /// Tudo sobre o fundo: o que lá está, o que é de cada um, as metas e os
  /// últimos depósitos.
  async fund(userId: string, spaceId: string) {
    const me = await this.spaces.membership(userId, spaceId);
    const members = await this.prisma.spaceMember.findMany({ where: { spaceId }, include: { user: userSelect }, orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }] });
    const memberIds = new Set(members.map((m) => m.userId));
    const [pot, goals, byGoalUser, recent, depositsCount] = await Promise.all([
      this.spaces.pot(spaceId, [...memberIds]),
      this.prisma.spaceGoal.findMany({ where: { spaceId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.spaceDeposit.groupBy({ by: ['goalId', 'userId'], where: { spaceId, goalId: { not: null } }, _sum: { amount: true } }),
      this.prisma.spaceDeposit.findMany({ where: { spaceId }, include: depositInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 20 }),
      this.prisma.spaceDeposit.count({ where: { spaceId } }),
    ]);

    // Quem já não está no Space mas ainda aparece (pôs dinheiro, criou uma meta).
    const outsiders = new Set<string>();
    for (const id of [...pot.members.map((m) => m.userId), ...byGoalUser.map((g) => g.userId), ...goals.map((g) => g.createdById)]) {
      if (id && id !== FORMER_DEPOSITOR && !memberIds.has(id)) outsiders.add(id);
    }
    const extra = outsiders.size ? await this.prisma.user.findMany({ where: { id: { in: [...outsiders] } }, ...userSelect }) : [];
    const users = new Map<string, Person>();
    for (const m of members) users.set(m.userId, m.user);
    for (const u of extra) users.set(u.id, u);
    const person = (id: string | null) => ({ userId: id, user: (id ? users.get(id) : null) ?? null, isMember: !!id && memberIds.has(id), isMe: id === userId });

    const admin = this.spaces.isAdmin(me.role);
    const can = this.spaces.can(me);
    const mine = pot.members.find((m) => m.userId === userId);
    const myStake = mine?.stake ?? 0;

    return {
      currency: me.space.currency,
      /// O que está no fundo agora
      balance: pot.balance,
      /// Guardado para metas / livre para gastar ou levantar
      earmarked: pot.earmarked,
      free: pot.free,
      deposited: pot.deposited,
      withdrawn: pot.withdrawn,
      /// Despesas pagas com o fundo
      spent: pot.spent,
      my: {
        deposited: mine?.deposited ?? 0,
        withdrawn: mine?.withdrawn ?? 0,
        /// A minha parte do que o grupo gastou do fundo
        share: mine?.share ?? 0,
        /// O que ainda é meu no fundo (negativo = gastei mais do que pus)
        stake: myStake,
        /// O máximo que posso levantar agora
        canWithdraw: round2(Math.max(0, Math.min(myStake, pot.free))),
      },
      members: pot.members
        .filter((m) => memberIds.has(m.userId) || m.deposited > 0 || Math.abs(m.stake) >= 0.01)
        .map((m) => ({ ...person(m.userId === FORMER_DEPOSITOR ? null : m.userId), deposited: m.deposited, withdrawn: m.withdrawn, share: m.share, stake: m.stake }))
        .sort((a, b) => b.deposited - a.deposited),
      goals: goals.map((g) => {
        const target = num(g.targetAmount);
        const contributors = byGoalUser
          .filter((c) => c.goalId === g.id)
          .map((c) => ({ ...person(c.userId), amount: num(c._sum.amount) }))
          .filter((c) => Math.abs(c.amount) >= 0.005)
          .sort((a, b) => b.amount - a.amount);
        const saved = round2(contributors.reduce((acc, c) => acc + c.amount, 0));
        return {
          id: g.id,
          name: g.name,
          icon: g.icon,
          color: g.color,
          targetAmount: target,
          targetDate: fromDbDateOrNull(g.targetDate),
          /// ACTIVE = a juntar · COMPLETED = chegou ao valor · ARCHIVED = fechada (o dinheiro voltou ao fundo)
          status: g.status,
          saved,
          remaining: round2(Math.max(0, target - saved)),
          pct: target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0,
          myContribution: contributors.find((c) => c.isMe)?.amount ?? 0,
          contributors,
          createdBy: g.createdById ? (users.get(g.createdById) ?? null) : null,
          canEdit: can.editAny || (g.createdById === userId && can.goals),
          completedAt: g.completedAt,
          createdAt: g.createdAt,
        };
      }),
      /// Os últimos movimentos do fundo (a lista completa está em /deposits)
      deposits: recent.map((d) => this.depositDto(d, userId, admin)),
      depositsCount,
      can: { addGoal: can.goals, payFromFund: can.fund, deposit: can.fund, manage: admin },
    };
  }

  async deposits(userId: string, spaceId: string, limit = 30, offset = 0) {
    const me = await this.spaces.membership(userId, spaceId);
    const take = Math.min(Math.max(limit, 1), 100);
    const rows = await this.prisma.spaceDeposit.findMany({
      where: { spaceId },
      include: depositInclude,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      skip: Math.max(offset, 0),
      take: take + 1,
    });
    const admin = this.spaces.isAdmin(me.role);
    return { data: rows.slice(0, take).map((d) => this.depositDto(d, userId, admin)), meta: { nextOffset: rows.length > take ? offset + take : null } };
  }

  /// O depósito (ou levantamento) também na conta pessoal de quem o fez.
  /// Devolve o id do movimento criado.
  private async accountMovement(
    userId: string,
    kind: 'deposit' | 'withdrawal',
    amount: number,
    space: { name: string; currency: string },
    accountId: string,
    categoryId: string | null | undefined,
    date: string,
    lang: Language,
  ): Promise<string> {
    const account = await this.prisma.account.findFirst({ where: { id: accountId, userId }, select: { currency: true } });
    if (!account) throw ApiException.notFound('ACCOUNT_NOT_FOUND');
    const value = this.exchange.convert(amount, space.currency, account.currency);
    if (value === null || value <= 0) throw ApiException.badRequest('SPACE_ACCOUNT_CURRENCY');
    const description = `${MOVEMENT_TEXT[lang][kind]} · ${space.name}`.slice(0, 140);
    const created =
      kind === 'deposit'
        ? // Pôr dinheiro no fundo é dinheiro que sai do meu bolso: conta como despesa.
          await this.transactions.create(userId, { type: 'EXPENSE', amount: value, accountId, categoryId: categoryId ?? undefined, date, description })
        : // Tirar do fundo é receber de volta o que era meu: entra na conta, mas não é rendimento.
          await this.transactions.create(userId, { type: 'INCOME', amount: value, accountId, categoryId: null, date, description, excludeFromReports: true });
    return created.id;
  }

  /// Pôr dinheiro no fundo (para todos gastarem, ou para uma meta).
  async deposit(userId: string, spaceId: string, dto: DepositDto) {
    const me = await this.spaces.membership(userId, spaceId);
    if (!this.spaces.can(me).fund) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    const actor = await this.actor(userId);
    const date = dto.date ?? actor.today;
    let goal: SpaceGoal | null = null;
    if (dto.goalId) {
      goal = await this.prisma.spaceGoal.findFirst({ where: { id: dto.goalId, spaceId } });
      if (!goal) throw ApiException.notFound('SPACE_GOAL_NOT_FOUND');
      if (goal.status === 'ARCHIVED') throw ApiException.badRequest('GOAL_NOT_ACTIVE');
    }
    const transactionId = dto.accountId ? await this.accountMovement(userId, 'deposit', dto.amount, me.space, dto.accountId, dto.categoryId, date, actor.lang) : null;
    let depositId: string;
    try {
      const created = await this.prisma.spaceDeposit.create({
        data: { spaceId, userId, amount: money(dto.amount), currency: me.space.currency, goalId: goal?.id ?? null, date: toDbDate(date), note: dto.note ?? null, transactionId },
        select: { id: true },
      });
      depositId = created.id;
    } catch (err) {
      // Sem depósito, o movimento na conta pessoal também não fica.
      if (transactionId) await this.prisma.transaction.deleteMany({ where: { id: transactionId, userId } }).catch(() => undefined);
      throw err;
    }

    const data = { spaceId, depositId, space: me.space.name, from: actor.name, amount: dto.amount, currency: me.space.currency };
    if (goal) {
      await this.tellOthers(spaceId, userId, 'space_deposit_goal', { ...data, goalId: goal.id, goal: goal.name });
      if (await this.syncGoal(goal.id)) {
        await this.tellOthers(spaceId, userId, 'space_goal_reached', { spaceId, goalId: goal.id, space: me.space.name, goal: goal.name, amount: num(goal.targetAmount), currency: me.space.currency });
        return { ...(await this.fund(userId, spaceId)), reachedGoalId: goal.id as string | null };
      }
    } else {
      await this.tellOthers(spaceId, userId, 'space_deposit', data);
    }
    return { ...(await this.fund(userId, spaceId)), reachedGoalId: null as string | null };
  }

  /// Tirar do fundo a minha parte: nunca mais do que o que ainda é meu, nem
  /// do que está guardado para metas.
  async withdraw(userId: string, spaceId: string, dto: WithdrawDto) {
    const me = await this.spaces.membership(userId, spaceId);
    if (!this.spaces.can(me).fund) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    const actor = await this.actor(userId);
    const pot = await this.spaces.pot(spaceId);
    const stake = pot.members.find((m) => m.userId === userId)?.stake ?? 0;
    const max = round2(Math.max(0, Math.min(stake, pot.free)));
    if (dto.amount > max + 0.005) throw ApiException.badRequest('SPACE_WITHDRAW_TOO_HIGH', { max: formatMoney(max, me.space.currency, actor.lang, actor.country) });
    const date = dto.date ?? actor.today;
    const transactionId = dto.accountId ? await this.accountMovement(userId, 'withdrawal', dto.amount, me.space, dto.accountId, null, date, actor.lang) : null;
    try {
      await this.prisma.spaceDeposit.create({
        data: { spaceId, userId, amount: money(dto.amount).negated(), currency: me.space.currency, date: toDbDate(date), note: dto.note ?? null, transactionId },
      });
    } catch (err) {
      if (transactionId) await this.prisma.transaction.deleteMany({ where: { id: transactionId, userId } }).catch(() => undefined);
      throw err;
    }
    await this.tellOthers(spaceId, userId, 'space_withdrawal', { spaceId, space: me.space.name, from: actor.name, amount: dto.amount, currency: me.space.currency });
    return this.fund(userId, spaceId);
  }

  /// Anular um depósito ou levantamento: quem o fez, ou um admin (fica no
  /// histórico quem anulou). Um depósito já gasto pelo grupo não se anula.
  async removeDeposit(userId: string, spaceId: string, depositId: string) {
    const me = await this.spaces.membership(userId, spaceId);
    const deposit = await this.prisma.spaceDeposit.findFirst({ where: { id: depositId, spaceId }, include: { user: { select: { name: true } }, goal: { select: { status: true } } } });
    if (!deposit) throw ApiException.notFound('SPACE_DEPOSIT_NOT_FOUND');
    const own = deposit.userId === userId;
    if (!own && !this.spaces.can(me).editAny) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    const actor = await this.actor(userId);
    const amount = num(deposit.amount);
    // Dinheiro guardado numa meta sai da meta; o resto tem de estar livre no fundo.
    const reserved = !!deposit.goal && deposit.goal.status !== 'ARCHIVED';
    if (amount > 0 && !reserved) {
      const free = (await this.spaces.pot(spaceId)).free;
      if (amount > free + 0.005) throw ApiException.badRequest('SPACE_POT_INSUFFICIENT', { amount: formatMoney(free, me.space.currency, actor.lang, actor.country) });
    }
    await this.prisma.$transaction(async (tx) => {
      // Só se apaga o movimento de quem está a anular (nunca o da conta de outra pessoa).
      if (deposit.transactionId && own) await tx.transaction.deleteMany({ where: { id: deposit.transactionId, userId } });
      await tx.spaceDeposit.delete({ where: { id: depositId } });
    });
    if (deposit.goalId) await this.syncGoal(deposit.goalId);
    const data = { amount: Math.abs(amount), currency: deposit.currency, date: fromDbDate(deposit.date) };
    await this.spaces.log(spaceId, userId, amount < 0 ? 'withdrawal_deleted' : 'deposit_deleted', { ...data, userId: deposit.userId, name: deposit.user?.name ?? '' });
    if (!own && deposit.userId) {
      const told = { spaceId, space: me.space.name, from: actor.name, amount: data.amount, currency: data.currency };
      await this.notifications.notify(deposit.userId, 'space_deposit_removed', told, (ctx) => ({ ...told, amount: formatMoney(told.amount, told.currency, ctx.lang, ctx.country) }));
    }
    return this.fund(userId, spaceId);
  }

  // ----------------------------------------------------------------
  // Metas do grupo
  // ----------------------------------------------------------------

  /// Depois de mexer no dinheiro (ou no valor) de uma meta: chegou lá?
  /// Deixou de chegar? Devolve true quando acabou de ser alcançada.
  private async syncGoal(goalId: string): Promise<boolean> {
    const goal = await this.prisma.spaceGoal.findUnique({ where: { id: goalId } });
    if (!goal || goal.status === 'ARCHIVED') return false;
    const total = await this.prisma.spaceDeposit.aggregate({ where: { goalId }, _sum: { amount: true } });
    const reached = num(total._sum.amount) + 0.005 >= num(goal.targetAmount);
    if (reached && goal.status === 'ACTIVE') {
      await this.prisma.spaceGoal.update({ where: { id: goalId }, data: { status: 'COMPLETED', completedAt: new Date() } });
      return true;
    }
    if (!reached && goal.status === 'COMPLETED') await this.prisma.spaceGoal.update({ where: { id: goalId }, data: { status: 'ACTIVE', completedAt: null } });
    return false;
  }

  private async editableGoal(userId: string, spaceId: string, goalId: string) {
    const me = await this.spaces.membership(userId, spaceId);
    const goal = await this.prisma.spaceGoal.findFirst({ where: { id: goalId, spaceId } });
    if (!goal) throw ApiException.notFound('SPACE_GOAL_NOT_FOUND');
    // Um admin pode sempre; quem a criou, se os privilégios do Space deixarem.
    const own = goal.createdById === userId;
    const can = this.spaces.can(me);
    if (!can.editAny && !(own && can.goals)) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    return { me, goal };
  }

  async createGoal(userId: string, spaceId: string, dto: SpaceGoalDto) {
    const me = await this.spaces.membership(userId, spaceId);
    if (!this.spaces.can(me).goals) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    const open = await this.prisma.spaceGoal.count({ where: { spaceId, status: { not: 'ARCHIVED' } } });
    if (open >= SPACE_GOALS_MAX) throw ApiException.badRequest('SPACE_GOALS_LIMIT', { max: SPACE_GOALS_MAX });
    const goal = await this.prisma.spaceGoal.create({
      data: {
        spaceId,
        name: dto.name,
        targetAmount: money(dto.targetAmount),
        targetDate: dto.targetDate ? toDbDate(dto.targetDate) : null,
        ...(dto.icon ? { icon: dto.icon } : {}),
        ...(dto.color ? { color: dto.color } : {}),
        createdById: userId,
      },
    });
    const actor = await this.actor(userId);
    await this.tellOthers(spaceId, userId, 'space_goal_created', { spaceId, goalId: goal.id, space: me.space.name, from: actor.name, goal: goal.name, amount: dto.targetAmount, currency: me.space.currency });
    return this.fund(userId, spaceId);
  }

  async updateGoal(userId: string, spaceId: string, goalId: string, dto: UpdateSpaceGoalDto) {
    const { me, goal } = await this.editableGoal(userId, spaceId, goalId);
    const data: Prisma.SpaceGoalUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.targetAmount !== undefined ? { targetAmount: money(dto.targetAmount) } : {}),
      ...(dto.targetDate !== undefined ? { targetDate: dto.targetDate ? toDbDate(dto.targetDate) : null } : {}),
      ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
      ...(dto.color !== undefined ? { color: dto.color } : {}),
    };
    if (dto.status === 'ARCHIVED' && goal.status !== 'ARCHIVED') {
      // "Usar o dinheiro": a meta fecha e o que lá estava volta a ficar livre no fundo.
      data.status = 'ARCHIVED';
    } else if (dto.status === 'ACTIVE' && goal.status === 'ARCHIVED') {
      // Reabrir volta a guardar o dinheiro — só se ele ainda lá estiver.
      const [saved, pot, actor] = await Promise.all([
        this.prisma.spaceDeposit.aggregate({ where: { goalId }, _sum: { amount: true } }),
        this.spaces.pot(spaceId),
        this.actor(userId),
      ]);
      if (num(saved._sum.amount) > pot.free + 0.005) {
        throw ApiException.badRequest('SPACE_POT_INSUFFICIENT', { amount: formatMoney(pot.free, me.space.currency, actor.lang, actor.country) });
      }
      data.status = 'ACTIVE';
      data.completedAt = null;
    }
    await this.prisma.spaceGoal.update({ where: { id: goalId }, data });
    await this.syncGoal(goalId);
    return this.fund(userId, spaceId);
  }

  /// Apagar uma meta: o dinheiro que lá estava fica no fundo, livre.
  async removeGoal(userId: string, spaceId: string, goalId: string) {
    const { me, goal } = await this.editableGoal(userId, spaceId, goalId);
    const saved = await this.prisma.spaceDeposit.aggregate({ where: { goalId }, _sum: { amount: true } });
    await this.prisma.spaceGoal.delete({ where: { id: goalId } });
    await this.spaces.log(spaceId, userId, 'goal_deleted', { name: goal.name, amount: num(saved._sum.amount), currency: me.space.currency });
    return this.fund(userId, spaceId);
  }

  // ----------------------------------------------------------------
  // O plano do grupo: quanto se quer gastar em quê
  // ----------------------------------------------------------------

  /// `month` ("2026-10") compara com as despesas desse mês; sem ele, com
  /// todas (uma viagem, um projeto).
  async plan(userId: string, spaceId: string, month?: string) {
    const me = await this.spaces.membership(userId, spaceId);
    const key = isMonthKey(month) ? month : null;
    const range = key ? { gte: toDbDate(`${key}-01`), lte: toDbDate(endOfMonth(`${key}-01`)) } : null;
    const [lines, byCategory, membersCount] = await Promise.all([
      this.prisma.spacePlanLine.findMany({ where: { spaceId }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
      this.prisma.spaceExpense.groupBy({ by: ['categoryKey'], where: { spaceId, ...(range ? { date: range } : {}) }, _sum: { amount: true } }),
      this.prisma.spaceMember.count({ where: { spaceId } }),
    ]);
    const spentBy = new Map<string, number>();
    for (const c of byCategory) spentBy.set(c.categoryKey ?? '', round2((spentBy.get(c.categoryKey ?? '') ?? 0) + num(c._sum.amount)));
    const planned = round2(lines.reduce((acc, l) => acc + num(l.amount), 0));
    const spent = round2([...spentBy.values()].reduce((acc, v) => acc + v, 0));
    const inPlan = new Set(lines.map((l) => l.categoryKey).filter((k): k is string => !!k));
    return {
      currency: me.space.currency,
      month: key,
      /// O que o grupo quer gastar, o que já gastou e o que sobra
      planned,
      spent,
      remaining: round2(planned - spent),
      /// Quanto cabe a cada pessoa, se for a meias
      perPerson: membersCount > 0 ? round2(planned / membersCount) : planned,
      membersCount,
      lines: lines.map((l) => {
        const amount = num(l.amount);
        // Só as linhas com categoria se comparam com as despesas; as outras são estimativas.
        const used = l.categoryKey ? (spentBy.get(l.categoryKey) ?? 0) : null;
        return {
          id: l.id,
          categoryKey: l.categoryKey,
          title: l.title,
          amount,
          spent: used,
          remaining: used === null ? null : round2(amount - used),
          pct: used === null || amount <= 0 ? null : Math.round((used / amount) * 100),
        };
      }),
      /// O que se gastou em categorias que não estão no plano
      unplanned: [...spentBy.entries()]
        .filter(([k, v]) => !inPlan.has(k) && v > 0)
        .map(([k, v]) => ({ categoryKey: k || null, spent: v }))
        .sort((a, b) => b.spent - a.spent),
      can: { edit: this.spaces.can(me).plan },
    };
  }

  /// Guarda o plano inteiro (substitui as linhas que lá estavam).
  async savePlan(userId: string, spaceId: string, dto: SpacePlanDto, month?: string) {
    const me = await this.spaces.membership(userId, spaceId);
    if (!this.spaces.can(me).plan) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    const keys = dto.lines.map((l) => l.categoryKey).filter((k): k is string => !!k);
    if (new Set(keys).size !== keys.length) throw ApiException.badRequest('SPACE_PLAN_DUPLICATE');
    await this.prisma.$transaction([
      this.prisma.spacePlanLine.deleteMany({ where: { spaceId } }),
      this.prisma.spacePlanLine.createMany({
        data: dto.lines.map((l, i) => ({
          spaceId,
          categoryKey: l.categoryKey || null,
          // Uma linha com categoria não precisa de nome próprio.
          title: l.categoryKey ? null : (l.title ?? null),
          amount: money(l.amount),
          sortOrder: i,
        })),
      }),
    ]);
    await this.spaces.log(spaceId, userId, 'plan_updated', { amount: round2(dto.lines.reduce((acc, l) => acc + l.amount, 0)), currency: me.space.currency });
    return this.plan(userId, spaceId, month);
  }
}
