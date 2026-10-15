import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AttachmentsService, toAttachmentDto } from '../storage/attachments.service';
import { ExchangeService } from '../exchange/exchange.service';
import { TransactionsService } from '../transactions/transactions.service';
import { SpacesService } from './spaces.service';
import { ApiException } from '../common/errors/api.exception';
import { fromDbDate, todayIn, toDbDate } from '../common/utils/dates';
import { formatMoney, money, num, round2 } from '../common/utils/money';
import { Prisma } from '../generated/prisma/client';
import { computeBalances, computeShares, FORMER_MEMBER, simplifyDebts } from './split';
import { ExpenseDto, SettlementDto, UpdateExpenseDto } from './spaces.dto';

const userSelect = { select: { id: true, name: true, username: true, avatarUrl: true } } as const;

const expenseInclude = {
  paidBy: userSelect,
  createdBy: userSelect,
  shares: { include: { user: userSelect } },
  attachments: { select: { id: true, kind: true, mimeType: true, size: true, createdAt: true } },
} satisfies Prisma.SpaceExpenseInclude;
type ExpenseWithRelations = Prisma.SpaceExpenseGetPayload<{ include: typeof expenseInclude }>;

/// Despesas partilhadas de um Space: quem pagou, como se divide, quem
/// deve a quem, e os acertos ("o Rui pagou-me 20 €").
@Injectable()
export class SpaceExpensesService {
  private readonly logger = new Logger(SpaceExpensesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpacesService,
    private readonly notifications: NotificationsService,
    private readonly attachments: AttachmentsService,
    private readonly exchange: ExchangeService,
    private readonly transactions: TransactionsService,
  ) {}

  private expenseDto(e: ExpenseWithRelations, userId: string) {
    const mine = e.shares.find((s) => s.userId === userId);
    const amount = num(e.amount);
    const myShare = mine ? num(mine.amount) : 0;
    return {
      id: e.id,
      title: e.title,
      amount,
      currency: e.currency,
      date: fromDbDate(e.date),
      categoryKey: e.categoryKey,
      splitMethod: e.splitMethod,
      note: e.note,
      paidBy: e.paidBy,
      createdBy: e.createdBy,
      shares: e.shares.map((s) => ({ userId: s.userId, user: s.user, amount: num(s.amount), weight: s.weight ? Number(s.weight) : null })),
      attachments: e.attachments.map(toAttachmentDto),
      myShare,
      /// Paga com o fundo comum (não cria dívidas: sai do que foi depositado)
      fromPot: e.fromPot,
      /// O que esta despesa muda no meu saldo (+ emprestei / − devo)
      myImpact: e.fromPot ? 0 : round2((e.paidById === userId ? amount : 0) - myShare),
      /// Fui eu que registei ou paguei
      mine: e.createdById === userId || e.paidById === userId,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  }

  async list(userId: string, spaceId: string, limit = 30, offset = 0) {
    await this.spaces.membership(userId, spaceId);
    const take = Math.min(Math.max(limit, 1), 100);
    const rows = await this.prisma.spaceExpense.findMany({
      where: { spaceId },
      include: expenseInclude,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      skip: offset,
      take: take + 1,
    });
    return { data: rows.slice(0, take).map((e) => this.expenseDto(e, userId)), meta: { nextOffset: rows.length > take ? offset + take : null } };
  }

  async get(userId: string, spaceId: string, expenseId: string) {
    await this.spaces.membership(userId, spaceId);
    const e = await this.prisma.spaceExpense.findFirst({ where: { id: expenseId, spaceId }, include: expenseInclude });
    if (!e) throw ApiException.notFound('EXPENSE_NOT_FOUND');
    return this.expenseDto(e, userId);
  }

  private async memberIds(spaceId: string) {
    // Por ordem de entrada: os cêntimos que sobram de uma divisão vão sempre para os mesmos.
    return (await this.prisma.spaceMember.findMany({ where: { spaceId }, select: { userId: true }, orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }] })).map((m) => m.userId);
  }

  /// O que há no fundo comum para gastar (sem o que está guardado para metas).
  private async potFree(spaceId: string) {
    return (await this.spaces.pot(spaceId)).free;
  }

  private async sharesFor(spaceId: string, method: ExpenseDto['splitMethod'], total: Prisma.Decimal, participants?: ExpenseDto['participants']) {
    const members = await this.memberIds(spaceId);
    const list = participants?.length ? participants : members.map((userId) => ({ userId, value: null }));
    if (list.some((p) => !members.includes(p.userId))) throw ApiException.badRequest('SPLIT_MEMBER_INVALID');
    return computeShares(method, total, list);
  }

  async create(userId: string, spaceId: string, dto: ExpenseDto) {
    const me = await this.spaces.membership(userId, spaceId);
    if (!this.spaces.can(me).addExpense) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    const members = await this.memberIds(spaceId);
    // Paga com o fundo comum: ninguém "pagou" — sai do que o grupo depositou.
    const fromPot = dto.fromPot === true;
    const paidById = fromPot ? null : (dto.paidById ?? userId);
    if (paidById && !members.includes(paidById)) throw ApiException.badRequest('SPLIT_MEMBER_INVALID');
    const total = money(dto.amount);
    const shares = await this.sharesFor(spaceId, dto.splitMethod, total, dto.participants);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, timezone: true, language: true, country: true } });
    const date = dto.date ?? todayIn(user?.timezone ?? 'UTC');
    if (fromPot) {
      const available = await this.potFree(spaceId);
      if (num(total) > available + 0.005) throw ApiException.badRequest('SPACE_POT_INSUFFICIENT', { amount: formatMoney(available, me.space.currency, user?.language, user?.country) });
    }

    const expense = await this.prisma.spaceExpense.create({
      data: {
        spaceId,
        createdById: userId,
        paidById,
        title: dto.title,
        amount: total,
        currency: me.space.currency,
        date: toDbDate(date),
        categoryKey: dto.categoryKey ?? null,
        splitMethod: dto.splitMethod,
        note: dto.note ?? null,
        fromPot,
        shares: { create: shares.map((s) => ({ userId: s.userId, amount: s.amount, weight: s.weight })) },
      },
    });
    if (dto.attachmentIds?.length) await this.attachments.linkToSpaceExpense(userId, expense.id, dto.attachmentIds);

    // A minha parte também nas minhas despesas pessoais (opcional).
    const myShare = shares.find((s) => s.userId === userId);
    // (Numa despesa do fundo não: o que saiu da minha conta foi o depósito.)
    if (!fromPot && dto.addToMyExpenses && myShare && myShare.amount.greaterThan(0)) {
      const account = await this.prisma.account.findFirst({ where: { id: dto.addToMyExpenses.accountId, userId }, select: { currency: true } });
      if (!account) throw ApiException.notFound('ACCOUNT_NOT_FOUND');
      const value = this.exchange.convert(num(myShare.amount), me.space.currency, account.currency);
      if (value !== null && value > 0) {
        let categoryId = dto.addToMyExpenses.categoryId ?? null;
        if (!categoryId && dto.categoryKey) {
          categoryId = (await this.prisma.category.findFirst({ where: { userId, key: dto.categoryKey, type: 'EXPENSE' }, select: { id: true } }))?.id ?? null;
        }
        await this.transactions.create(
          userId,
          { type: 'EXPENSE', amount: value, accountId: dto.addToMyExpenses.accountId, categoryId, date, description: `${dto.title} · ${me.space.name}` },
          { spaceExpenseId: expense.id },
        );
      }
    }

    // Avisa quem entrou na divisão (menos quem registou).
    for (const share of shares) {
      if (share.userId === userId) continue;
      const data = { spaceId, expenseId: expense.id, space: me.space.name, from: user?.name ?? '', title: dto.title, amount: num(total), share: num(share.amount), currency: me.space.currency };
      // Paga com o fundo: o aviso diz isso mesmo (não ficou ninguém a dever).
      await this.notifications.notify(share.userId, fromPot ? 'space_pot_expense' : 'space_expense', data, (ctx) => ({
        ...data,
        amount: formatMoney(data.amount, data.currency, ctx.lang, ctx.country),
        share: formatMoney(data.share, data.currency, ctx.lang, ctx.country),
      }));
    }
    return this.get(userId, spaceId, expense.id);
  }

  private async editable(userId: string, spaceId: string, expenseId: string) {
    const me = await this.spaces.membership(userId, spaceId);
    const expense = await this.prisma.spaceExpense.findFirst({ where: { id: expenseId, spaceId } });
    if (!expense) throw ApiException.notFound('EXPENSE_NOT_FOUND');
    // Um admin pode sempre; quem registou ou pagou, se os privilégios do Space deixarem.
    const own = expense.createdById === userId || (!expense.fromPot && expense.paidById === userId);
    const can = this.spaces.can(me);
    if (!can.editAny && !(own && can.editOwn)) throw ApiException.forbidden(own ? 'SPACE_ADMIN_REQUIRED' : undefined);
    return { me, expense };
  }

  async update(userId: string, spaceId: string, expenseId: string, dto: UpdateExpenseDto) {
    const { expense } = await this.editable(userId, spaceId, expenseId);
    const members = await this.memberIds(spaceId);
    if (dto.paidById && !members.includes(dto.paidById)) throw ApiException.badRequest('SPLIT_MEMBER_INVALID');
    const total = dto.amount !== undefined ? money(dto.amount) : expense.amount;
    // Uma despesa do fundo não pode crescer para além do que lá está.
    if (expense.fromPot && num(total) > num(expense.amount) + 0.005) {
      const available = round2((await this.potFree(spaceId)) + num(expense.amount));
      if (num(total) > available + 0.005) {
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { language: true, country: true } });
        throw ApiException.badRequest('SPACE_POT_INSUFFICIENT', { amount: formatMoney(available, expense.currency, user?.language, user?.country) });
      }
    }
    const resplit = dto.amount !== undefined || dto.splitMethod !== undefined || dto.participants !== undefined;
    let shares: Awaited<ReturnType<SpaceExpensesService['sharesFor']>> | null = null;
    if (resplit) {
      let participants = dto.participants;
      if (!participants) {
        // Mantém as mesmas pessoas (e os mesmos pesos, se fizer sentido).
        const current = await this.prisma.spaceExpenseShare.findMany({ where: { expenseId } });
        const method = dto.splitMethod ?? expense.splitMethod;
        participants = current
          .filter((s): s is typeof s & { userId: string } => !!s.userId && members.includes(s.userId))
          .map((s) => ({ userId: s.userId, value: method === 'EQUAL' ? null : method === 'EXACT' ? null : s.weight ? Number(s.weight) : null }));
        if (method === 'EXACT') throw ApiException.badRequest('SPLIT_INVALID', { total: total.toFixed(2) });
      }
      shares = await this.sharesFor(spaceId, dto.splitMethod ?? expense.splitMethod, total, participants);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.spaceExpense.update({
        where: { id: expenseId },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.amount !== undefined ? { amount: total } : {}),
          ...(dto.date !== undefined ? { date: toDbDate(dto.date) } : {}),
          // Numa despesa do fundo ninguém "pagou": fica como está.
          ...(dto.paidById !== undefined && !expense.fromPot ? { paidById: dto.paidById } : {}),
          ...(dto.splitMethod !== undefined ? { splitMethod: dto.splitMethod } : {}),
          ...(dto.categoryKey !== undefined ? { categoryKey: dto.categoryKey } : {}),
          ...(dto.note !== undefined ? { note: dto.note } : {}),
        },
      });
      if (shares) {
        await tx.spaceExpenseShare.deleteMany({ where: { expenseId } });
        await tx.spaceExpenseShare.createMany({ data: shares.map((s) => ({ expenseId, userId: s.userId, amount: s.amount, weight: s.weight })) });
      }
    });
    if (dto.attachmentIds?.length) await this.attachments.linkToSpaceExpense(userId, expenseId, dto.attachmentIds);
    // Fica no histórico o que mudou no dinheiro (título e valor).
    const before = num(expense.amount);
    const after = num(total);
    if (Math.abs(after - before) >= 0.005 || (dto.title !== undefined && dto.title !== expense.title) || resplit) {
      await this.spaces.log(spaceId, userId, 'expense_updated', {
        expenseId,
        title: dto.title ?? expense.title,
        ...(dto.title !== undefined && dto.title !== expense.title ? { oldTitle: expense.title } : {}),
        amount: after,
        ...(Math.abs(after - before) >= 0.005 ? { oldAmount: before } : {}),
        currency: expense.currency,
      });
    }
    return this.get(userId, spaceId, expenseId);
  }

  async remove(userId: string, spaceId: string, expenseId: string) {
    const { me, expense } = await this.editable(userId, spaceId, expenseId);
    const [files, shares, actor] = await Promise.all([
      this.prisma.attachment.findMany({ where: { spaceExpenseId: expenseId }, select: { id: true, storageKey: true } }),
      this.prisma.spaceExpenseShare.findMany({ where: { expenseId }, select: { userId: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);
    await this.prisma.spaceExpense.delete({ where: { id: expenseId } });
    await this.prisma.attachment.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
    await this.attachments.removeFiles(files.map((f) => f.storageKey));
    // Quem apagou fica registado — e quem entrava na despesa é avisado.
    const data = { spaceId, space: me.space.name, from: actor?.name ?? '', title: expense.title, amount: num(expense.amount), currency: expense.currency };
    await this.spaces.log(spaceId, userId, 'expense_deleted', { title: expense.title, amount: data.amount, currency: expense.currency, date: fromDbDate(expense.date) });
    const involved = new Set([expense.paidById, expense.createdById, ...shares.map((s) => s.userId)].filter((id): id is string => !!id && id !== userId));
    for (const target of involved) {
      await this.notifications.notify(target, 'space_expense_deleted', data, (ctx) => ({ ...data, amount: formatMoney(data.amount, data.currency, ctx.lang, ctx.country) }));
    }
    return { deleted: true };
  }

  // ----------------------------------------------------------------
  // Saldos e acertos
  // ----------------------------------------------------------------

  async balances(userId: string, spaceId: string) {
    const me = await this.spaces.membership(userId, spaceId);
    const [members, expenses, settlements] = await Promise.all([
      this.prisma.spaceMember.findMany({ where: { spaceId }, include: { user: userSelect } }),
      // As despesas pagas com o fundo não criam dívidas entre as pessoas.
      this.prisma.spaceExpense.findMany({ where: { spaceId, fromPot: false }, select: { paidById: true, amount: true, shares: { select: { userId: true, amount: true } } } }),
      this.prisma.spaceSettlement.findMany({ where: { spaceId }, select: { fromUserId: true, toUserId: true, amount: true } }),
    ]);
    const balances = computeBalances(expenses, settlements, members.map((m) => m.userId));
    const ids = balances.map((b) => b.userId).filter((id) => id !== FORMER_MEMBER);
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, username: true, avatarUrl: true } });
    const userMap = new Map(users.map((u) => [u.id, u]));
    const memberIds = new Set(members.map((m) => m.userId));
    const person = (id: string) => ({ userId: id === FORMER_MEMBER ? null : id, user: userMap.get(id) ?? null, isMember: memberIds.has(id), isMe: id === userId });
    return {
      currency: me.space.currency,
      balances: balances
        .filter((b) => memberIds.has(b.userId) || Math.abs(b.net) >= 0.01)
        .map((b) => ({ ...person(b.userId), paid: b.paid, owed: b.owed, net: b.net }))
        .sort((a, b) => b.net - a.net),
      /// O caminho mais curto para ficar tudo acertado
      suggested: simplifyDebts(balances).map((t) => ({ from: person(t.from), to: person(t.to), amount: t.amount })),
      myBalance: round2(balances.find((b) => b.userId === userId)?.net ?? 0),
    };
  }

  /// Lembrar alguém que me deve dinheiro neste Space (pelos acertos
  /// sugeridos). Um lembrete por dia a cada pessoa.
  async remind(userId: string, spaceId: string, targetId: string) {
    const info = await this.balances(userId, spaceId);
    const debt = info.suggested.find((t) => t.from.userId === targetId && t.to.userId === userId);
    if (!debt) throw ApiException.badRequest('SPACE_NOTHING_OWED');
    const recent = await this.prisma.notification.findFirst({
      where: {
        userId: targetId,
        type: 'space_reminder',
        createdAt: { gt: new Date(Date.now() - 20 * 3600_000) },
        AND: [{ data: { path: ['spaceId'], equals: spaceId } }, { data: { path: ['fromId'], equals: userId } }],
      },
      select: { id: true },
    });
    if (recent) throw ApiException.conflict('REMINDER_SENT_TODAY');
    const [me, space] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
      this.prisma.space.findUnique({ where: { id: spaceId }, select: { name: true } }),
    ]);
    const from = me?.name ?? '';
    const name = space?.name ?? '';
    await this.notifications.notify(
      targetId,
      'space_reminder',
      { spaceId, space: name, from, fromId: userId, amount: debt.amount, currency: info.currency },
      (ctx) => ({ from, space: name, amount: formatMoney(debt.amount, info.currency, ctx.lang, ctx.country) }),
    );
    return { sent: true };
  }

  async settle(userId: string, spaceId: string, dto: SettlementDto) {
    const me = await this.spaces.membership(userId, spaceId);
    if (!this.spaces.can(me).addExpense) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    const fromUserId = dto.fromUserId ?? userId;
    const members = await this.memberIds(spaceId);
    if (fromUserId === dto.toUserId || !members.includes(fromUserId) || !members.includes(dto.toUserId)) throw ApiException.badRequest('SETTLEMENT_INVALID');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, timezone: true } });
    const settlement = await this.prisma.spaceSettlement.create({
      data: {
        spaceId,
        fromUserId,
        toUserId: dto.toUserId,
        amount: money(dto.amount),
        currency: me.space.currency,
        date: toDbDate(dto.date ?? todayIn(user?.timezone ?? 'UTC')),
        note: dto.note ?? null,
        createdById: userId,
      },
    });
    for (const target of [fromUserId, dto.toUserId]) {
      if (target === userId) continue;
      const data = { spaceId, settlementId: settlement.id, space: me.space.name, from: user?.name ?? '', amount: dto.amount, currency: me.space.currency };
      await this.notifications.notify(target, 'space_settlement', data, (ctx) => ({ ...data, amount: formatMoney(data.amount, data.currency, ctx.lang, ctx.country) }));
    }
    return this.balances(userId, spaceId);
  }

  async removeSettlement(userId: string, spaceId: string, settlementId: string) {
    const me = await this.spaces.membership(userId, spaceId);
    const settlement = await this.prisma.spaceSettlement.findFirst({ where: { id: settlementId, spaceId } });
    if (!settlement) throw ApiException.notFound('SETTLEMENT_NOT_FOUND');
    if (settlement.createdById !== userId && !this.spaces.can(me).editAny) throw ApiException.forbidden();
    await this.prisma.spaceSettlement.delete({ where: { id: settlementId } });
    await this.spaces.log(spaceId, userId, 'settlement_deleted', { amount: num(settlement.amount), currency: settlement.currency, date: fromDbDate(settlement.date) });
    return this.balances(userId, spaceId);
  }

  /// Atividade recente (despesas, acertos e quem entrou), mais recente primeiro.
  async activity(userId: string, spaceId: string, limit = 40) {
    await this.spaces.membership(userId, spaceId);
    const take = Math.min(Math.max(limit, 1), 100);
    const [expenses, settlements, joins, logs] = await Promise.all([
      this.prisma.spaceExpense.findMany({ where: { spaceId }, include: expenseInclude, orderBy: { createdAt: 'desc' }, take }),
      this.prisma.spaceSettlement.findMany({ where: { spaceId }, include: { fromUser: userSelect, toUser: userSelect }, orderBy: { createdAt: 'desc' }, take }),
      this.prisma.spaceMember.findMany({ where: { spaceId }, include: { user: userSelect }, orderBy: { joinedAt: 'desc' }, take }),
      // O que alguém mudou ou apagou (despesas, acertos, membros, papéis)
      this.prisma.spaceActivity.findMany({ where: { spaceId }, orderBy: { createdAt: 'desc' }, take }),
    ]);
    // O que entrou e saiu do fundo comum
    const deposits = await this.prisma.spaceDeposit.findMany({ where: { spaceId }, include: { user: userSelect, goal: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, take });
    const actorIds = [...new Set(logs.map((l) => l.actorId).filter((id): id is string => !!id))];
    const actors = new Map((actorIds.length ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, ...userSelect }) : []).map((u) => [u.id, u]));
    const items = [
      ...deposits.map((d) => ({
        kind: 'deposit' as const,
        at: d.createdAt,
        deposit: { id: d.id, user: d.user, amount: num(d.amount), currency: d.currency, date: fromDbDate(d.date), note: d.note, goal: d.goal },
      })),
      ...logs.map((l) => ({
        kind: 'log' as const,
        at: l.createdAt,
        log: { id: l.id, type: l.type, actor: (l.actorId && actors.get(l.actorId)) || null, actorName: l.actorName, data: l.data as Record<string, unknown> },
      })),
      ...expenses.map((e) => ({ kind: 'expense' as const, at: e.createdAt, expense: this.expenseDto(e, userId) })),
      ...settlements.map((s) => ({
        kind: 'settlement' as const,
        at: s.createdAt,
        settlement: { id: s.id, from: s.fromUser, to: s.toUser, amount: num(s.amount), currency: s.currency, date: fromDbDate(s.date), note: s.note, createdById: s.createdById },
      })),
      ...joins.map((m) => ({ kind: 'joined' as const, at: m.joinedAt, member: { user: m.user, role: m.role } })),
    ];
    return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, take);
  }
}
