import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ExchangeService } from '../exchange/exchange.service';
import { LocksService } from '../billing/locks.service';
import { GoalsService } from '../goals/goals.service';
import { PlansService } from '../plans/plans.service';
import { BudgetsService } from '../budgets/budgets.service';
import { ApiException } from '../common/errors/api.exception';
import { addDays, daysBetween, financialMonth, fromDbDate, todayIn } from '../common/utils/dates';
import { num, numOrNull, round2 } from '../common/utils/money';
import { Category, ItemOffer, Prisma } from '../generated/prisma/client';
import { ItemKind, PLAN_TYPES } from '../plans/plans.dto';
import { AcceptItemDto, OfferKind, SendItemDto } from './item-offers.dto';

/// As cópias que viajam. Nunca levam dinheiro guardado, movimentos, contas
/// nem valores reais — só o "molde" para a outra pessoa usar à maneira dela.
interface GoalPayload {
  sourceId: string;
  name: string;
  targetAmount: number;
  icon: string;
  color: string;
  /// Dias do início ao fim (null = sem data para chegar)
  days: number | null;
  steps: Array<{ title: string; amount: number | null; offsetDays: number | null }>;
}
interface PlanPayload {
  sourceId: string;
  name: string;
  type: string;
  description: string | null;
  icon: string;
  color: string;
  budget: number | null;
  items: Array<{ title: string; notes: string | null; quantity: number; unitPrice: number | null; estimatedAmount: number | null; kind: string; categoryKey: string | null }>;
}
interface BudgetPayload {
  sourceId: string;
  name: string;
  amount: number;
  period: 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  /// Vazio = todas as despesas
  categories: Array<{ key: string | null; name: string | null; icon: string; color: string }>;
}
type Payload = GoalPayload | PlanPayload | BudgetPayload;

const person = { select: { id: true, name: true, username: true, avatarUrl: true } } as const;
const include = { from: person, to: person } satisfies Prisma.ItemOfferInclude;
type OfferFull = Prisma.ItemOfferGetPayload<{ include: typeof include }>;

/// Quantos envios por responder uma pessoa pode ter (sem spam).
const MAX_PENDING_SENT = 30;

/// Enviar a outra pessoa um objetivo, um plano ou um limite de gastos como
/// modelo. Quem recebe vê a cópia e, se aceitar, fica com ela na sua conta
/// (com as suas datas, o seu mês e as suas categorias).
@Injectable()
export class ItemOffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly exchange: ExchangeService,
    private readonly locks: LocksService,
    private readonly goals: GoalsService,
    private readonly plans: PlansService,
    private readonly budgets: BudgetsService,
  ) {}

  private payloadOf<T extends Payload>(offer: ItemOffer): T {
    return offer.payload as unknown as T;
  }

  /// A categoria de quem recebe que corresponde (pela chave das de base ou pelo nome).
  private matchCategory(c: { key: string | null; name: string | null }, mine: Category[]): Category | null {
    if (c.key) return mine.find((m) => m.key === c.key) ?? null;
    const name = (c.name ?? '').trim().toLowerCase();
    return name ? (mine.find((m) => !m.key && (m.name ?? '').trim().toLowerCase() === name) ?? null) : null;
  }

  /// Um resumo do que vai no envio, igual para os três tipos.
  private summary(offer: ItemOffer) {
    if (offer.kind === 'GOAL') {
      const p = this.payloadOf<GoalPayload>(offer);
      return { icon: p.icon, color: p.color, amount: p.targetAmount, days: p.days, count: p.steps.length };
    }
    if (offer.kind === 'PLAN') {
      const p = this.payloadOf<PlanPayload>(offer);
      const estimated = round2(p.items.filter((i) => i.kind !== 'REVENUE' && i.kind !== 'RESERVE').reduce((acc, i) => acc + (i.estimatedAmount ?? 0), 0));
      return { icon: p.icon, color: p.color, amount: p.budget ?? (estimated > 0 ? estimated : null), days: null, count: p.items.length, planType: p.type };
    }
    const p = this.payloadOf<BudgetPayload>(offer);
    return { icon: 'payments', color: '#2D4BE0', amount: p.amount, days: null, count: p.categories.length, period: p.period };
  }

  private dto(offer: OfferFull, viewerId: string) {
    return {
      id: offer.id,
      kind: offer.kind as OfferKind,
      status: offer.status,
      title: offer.title,
      note: offer.note,
      currency: offer.currency,
      from: offer.from,
      to: offer.to,
      /// Fui eu que enviei
      mine: offer.fromUserId === viewerId,
      ...this.summary(offer),
      createdItemId: offer.toUserId === viewerId ? offer.createdItemId : null,
      createdAt: offer.createdAt,
      respondedAt: offer.respondedAt,
    };
  }

  private async target(userId: string, dto: { userId?: string; username?: string }) {
    const user = await this.prisma.user.findFirst({
      where: { deletionRequestedAt: null, ...(dto.userId ? { id: dto.userId } : { username: (dto.username as string).replace(/^@/, '') }) },
      select: { id: true },
    });
    if (!user) throw ApiException.notFound('USER_NOT_FOUND');
    if (user.id === userId) throw ApiException.badRequest('OFFER_SELF');
    return user;
  }

  /// Tira a "fotografia" do meu item (só o molde).
  private async snapshot(userId: string, kind: OfferKind, itemId: string): Promise<{ title: string; currency: string; payload: Payload }> {
    if (kind === 'GOAL') {
      const goal = await this.prisma.goal.findFirst({ where: { id: itemId, userId }, include: { steps: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } } });
      if (!goal) throw ApiException.notFound('GOAL_NOT_FOUND');
      await this.locks.assertUnlocked(userId, 'goals', goal.id);
      const start = goal.startDate ? fromDbDate(goal.startDate) : goal.createdAt.toISOString().slice(0, 10);
      const end = goal.targetDate ? fromDbDate(goal.targetDate) : null;
      const payload: GoalPayload = {
        sourceId: goal.id,
        name: goal.name,
        targetAmount: num(goal.targetAmount),
        icon: goal.icon,
        color: goal.color,
        days: end && end > start ? daysBetween(start, end) : null,
        steps: goal.steps.map((st) => ({ title: st.title, amount: numOrNull(st.amount), offsetDays: st.dueDate ? Math.max(0, daysBetween(start, fromDbDate(st.dueDate))) : null })),
      };
      return { title: goal.name, currency: goal.currency, payload };
    }
    if (kind === 'PLAN') {
      const plan = await this.prisma.plan.findFirst({ where: { id: itemId, userId }, include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } } });
      if (!plan) throw ApiException.notFound('PLAN_NOT_FOUND');
      await this.locks.assertUnlocked(userId, 'plans', plan.id);
      const payload: PlanPayload = {
        sourceId: plan.id,
        name: plan.name,
        type: plan.type,
        description: plan.description,
        icon: plan.icon,
        color: plan.color,
        budget: numOrNull(plan.budget),
        // Vai o planeado; o que se gastou de facto e o que já está feito é de quem envia.
        items: plan.items.map((i) => ({ title: i.title, notes: i.notes, quantity: i.quantity, unitPrice: numOrNull(i.unitPrice), estimatedAmount: numOrNull(i.estimatedAmount), kind: i.kind, categoryKey: i.categoryKey })),
      };
      return { title: plan.name, currency: plan.currency, payload };
    }
    const budget = await this.prisma.budget.findFirst({ where: { id: itemId, userId } });
    if (!budget) throw ApiException.notFound('BUDGET_NOT_FOUND');
    await this.locks.assertUnlocked(userId, 'budgets', budget.id);
    const categories = budget.categoryIds.length ? await this.prisma.category.findMany({ where: { userId, id: { in: budget.categoryIds } } }) : [];
    const payload: BudgetPayload = {
      sourceId: budget.id,
      name: budget.name,
      amount: num(budget.amount),
      period: budget.period,
      categories: categories.map((c) => ({ key: c.key, name: c.name, icon: c.icon, color: c.color })),
    };
    return { title: budget.name, currency: budget.currency, payload };
  }

  /// Envia um objetivo, plano ou limite meu a outra pessoa. Voltar a enviar o
  /// mesmo à mesma pessoa atualiza o envio que ainda estava por responder.
  async send(userId: string, dto: SendItemDto) {
    const target = await this.target(userId, dto);
    const snap = await this.snapshot(userId, dto.kind, dto.itemId);
    const existing = await this.prisma.itemOffer.findFirst({
      where: { fromUserId: userId, toUserId: target.id, kind: dto.kind, status: 'PENDING', payload: { path: ['sourceId'], equals: dto.itemId } },
    });
    if (!existing) {
      const pending = await this.prisma.itemOffer.count({ where: { fromUserId: userId, status: 'PENDING' } });
      if (pending >= MAX_PENDING_SENT) throw ApiException.badRequest('OFFER_LIMIT', { max: MAX_PENDING_SENT });
    }
    const data = { title: snap.title, note: dto.note ?? null, currency: snap.currency, payload: snap.payload as unknown as Prisma.InputJsonValue };
    const offer = existing
      ? await this.prisma.itemOffer.update({ where: { id: existing.id }, data: { ...data, createdAt: new Date() }, include })
      : await this.prisma.itemOffer.create({ data: { ...data, fromUserId: userId, toUserId: target.id, kind: dto.kind }, include });
    const info = { offerId: offer.id, kind: offer.kind, title: offer.title, from: offer.from.name, fromId: userId };
    // Voltar a enviar não repete o aviso enquanto o primeiro estiver por ler.
    const waiting = existing ? await this.prisma.notification.count({ where: { userId: target.id, type: 'item_offer', readAt: null, data: { path: ['offerId'], equals: offer.id } } }) : 0;
    if (!waiting) await this.notifications.notify(target.id, 'item_offer', info);
    return this.dto(offer, userId);
  }

  /// `received` = o que me enviaram · `sent` = o que enviei.
  async list(userId: string) {
    const [received, sent] = await Promise.all([
      this.prisma.itemOffer.findMany({ where: { toUserId: userId, status: { not: 'CANCELLED' } }, include, orderBy: { createdAt: 'desc' }, take: 40 }),
      this.prisma.itemOffer.findMany({ where: { fromUserId: userId, status: { not: 'CANCELLED' } }, include, orderBy: { createdAt: 'desc' }, take: 40 }),
    ]);
    return {
      received: received.map((o) => this.dto(o, userId)),
      sent: sent.map((o) => this.dto(o, userId)),
      pendingCount: received.filter((o) => o.status === 'PENDING').length,
    };
  }

  private async mine(userId: string, id: string): Promise<OfferFull> {
    const offer = await this.prisma.itemOffer.findFirst({ where: { id, OR: [{ toUserId: userId }, { fromUserId: userId }] }, include });
    if (!offer) throw ApiException.notFound('OFFER_NOT_FOUND');
    return offer;
  }

  /// O envio com tudo o que lá vai — e, para quem o recebeu, o que precisa
  /// de escolher para o aceitar (datas, mês) e o que corresponde na sua conta.
  async get(userId: string, id: string) {
    const offer = await this.mine(userId, id);
    const base = this.dto(offer, userId);
    const receiver = await this.prisma.user.findUnique({ where: { id: offer.toUserId }, select: { currency: true, timezone: true, monthStartDay: true } });
    const today = todayIn(receiver?.timezone ?? 'UTC');
    if (offer.kind === 'GOAL') {
      const p = this.payloadOf<GoalPayload>(offer);
      return {
        ...base,
        goal: {
          name: p.name,
          targetAmount: p.targetAmount,
          days: p.days,
          steps: p.steps,
          /// Datas propostas a quem recebe: começa hoje e dura o mesmo tempo
          suggestedStart: today,
          suggestedEnd: p.days ? addDays(today, p.days) : null,
        },
      };
    }
    if (offer.kind === 'PLAN') {
      const p = this.payloadOf<PlanPayload>(offer);
      const months = [financialMonth(today, receiver?.monthStartDay ?? 1)];
      while (months.length < 12) months.push(financialMonth(addDays(months[months.length - 1].end, 1), receiver?.monthStartDay ?? 1));
      return {
        ...base,
        plan: { name: p.name, type: p.type, description: p.description, budget: p.budget, items: p.items },
        /// Os meses a que quem recebe pode ligar o plano (ou a nenhum)
        months: months.map((m, i) => ({ key: m.key, start: m.start, end: m.end, isCurrent: i === 0 })),
      };
    }
    const p = this.payloadOf<BudgetPayload>(offer);
    const mine = await this.prisma.category.findMany({ where: { userId: offer.toUserId, type: 'EXPENSE', archivedAt: null } });
    return {
      ...base,
      budget: {
        name: p.name,
        amount: p.amount,
        period: p.period,
        /// Cada categoria do limite e se quem recebe tem uma igual (as que não tem ficam de fora)
        categories: p.categories.map((c) => {
          const match = this.matchCategory(c, mine);
          return { key: match?.key ?? c.key, name: match?.name ?? c.name, icon: match?.icon ?? c.icon, color: match?.color ?? c.color, matched: !!match };
        }),
      },
    };
  }

  /// Um valor do envio na moeda de quem recebe (se as moedas forem diferentes).
  private convert(value: number | null, from: string, to: string): number | null {
    if (value === null) return null;
    if (from === to) return value;
    const converted = this.exchange.convert(value, from, to);
    return converted === null ? value : round2(converted);
  }

  /// Aceitar: o item passa a existir na minha conta (conta para os limites do
  /// meu plano como qualquer outro que eu crie).
  async accept(userId: string, id: string, dto: AcceptItemDto) {
    const offer = await this.prisma.itemOffer.findFirst({ where: { id, toUserId: userId }, include });
    if (!offer) throw ApiException.notFound('OFFER_NOT_FOUND');
    if (offer.status !== 'PENDING') throw ApiException.badRequest('OFFER_CLOSED');
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, currency: true, timezone: true } });
    const currency = me?.currency ?? offer.currency;
    const today = todayIn(me?.timezone ?? 'UTC');
    const amount = (value: number | null) => this.convert(value, offer.currency, currency);
    let createdItemId: string;

    if (offer.kind === 'GOAL') {
      const p = this.payloadOf<GoalPayload>(offer);
      const start = dto.startDate ?? today;
      const end = dto.targetDate !== undefined ? dto.targetDate : p.days ? addDays(start, p.days) : null;
      if (end && end < start) throw ApiException.badRequest('DATE_RANGE_INVALID');
      const goal = await this.goals.create(userId, {
        name: dto.name ?? p.name,
        targetAmount: amount(p.targetAmount) ?? p.targetAmount,
        startDate: start,
        targetDate: end,
        icon: p.icon,
        color: p.color,
        steps: p.steps.map((st) => {
          const due = st.offsetDays !== null ? addDays(start, st.offsetDays) : null;
          return { title: st.title, amount: amount(st.amount), dueDate: due && (!end || due <= end) ? due : null };
        }),
      });
      createdItemId = goal.id;
    } else if (offer.kind === 'PLAN') {
      const p = this.payloadOf<PlanPayload>(offer);
      const type = (PLAN_TYPES as readonly string[]).includes(p.type) ? (p.type as (typeof PLAN_TYPES)[number]) : 'OTHER';
      const plan = await this.plans.create(userId, {
        name: dto.name ?? p.name,
        type,
        description: p.description,
        icon: p.icon,
        color: p.color,
        budget: amount(p.budget),
        periodKey: dto.periodKey ?? null,
        items: p.items.map((i) => ({
          title: i.title,
          notes: i.notes,
          quantity: i.quantity,
          unitPrice: amount(i.unitPrice),
          estimatedAmount: amount(i.estimatedAmount),
          kind: i.kind as ItemKind,
          categoryKey: i.categoryKey,
          isDone: false,
        })),
      });
      createdItemId = plan.id;
    } else {
      const p = this.payloadOf<BudgetPayload>(offer);
      const mine = await this.prisma.category.findMany({ where: { userId, type: 'EXPENSE', archivedAt: null } });
      const categoryIds = [...new Set(p.categories.map((c) => this.matchCategory(c, mine)?.id).filter((x): x is string => !!x))];
      // Um limite de certas categorias não pode virar um limite de "todas as despesas".
      if (p.categories.length && !categoryIds.length) throw ApiException.badRequest('OFFER_NO_CATEGORY');
      const budget = await this.budgets.create(userId, { name: dto.name ?? p.name, amount: amount(p.amount) ?? p.amount, period: p.period, categoryIds });
      createdItemId = budget.id;
    }

    await this.prisma.itemOffer.update({ where: { id }, data: { status: 'ACCEPTED', createdItemId, respondedAt: new Date() } });
    const info = { offerId: id, kind: offer.kind, title: offer.title, from: me?.name ?? '', fromId: userId };
    await this.notifications.notify(offer.fromUserId, 'item_offer_accepted', info);
    return { offer: this.dto({ ...offer, status: 'ACCEPTED', createdItemId }, userId), createdItemId };
  }

  async decline(userId: string, id: string) {
    const offer = await this.prisma.itemOffer.findFirst({ where: { id, toUserId: userId }, include });
    if (!offer) throw ApiException.notFound('OFFER_NOT_FOUND');
    if (offer.status !== 'PENDING') throw ApiException.badRequest('OFFER_CLOSED');
    await this.prisma.itemOffer.update({ where: { id }, data: { status: 'DECLINED', respondedAt: new Date() } });
    const info = { offerId: id, kind: offer.kind, title: offer.title, from: offer.to.name, fromId: userId };
    await this.notifications.notify(offer.fromUserId, 'item_offer_declined', info);
    return { declined: true };
  }

  /// Quem enviou desiste (ou tira da lista um envio já respondido).
  async remove(userId: string, id: string) {
    const offer = await this.prisma.itemOffer.findFirst({ where: { id, fromUserId: userId } });
    if (!offer) throw ApiException.notFound('OFFER_NOT_FOUND');
    await this.prisma.itemOffer.update({ where: { id }, data: { status: 'CANCELLED', respondedAt: offer.respondedAt ?? new Date() } });
    return { deleted: true };
  }
}
