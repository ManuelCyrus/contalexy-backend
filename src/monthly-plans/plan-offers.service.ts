import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MonthlyPlansService } from './monthly-plans.service';
import { ApiException } from '../common/errors/api.exception';
import { addDays, financialMonth, financialMonthByKey, todayIn } from '../common/utils/dates';
import { money, num, round2 } from '../common/utils/money';
import { Category, MonthlyPlanOffer, Prisma } from '../generated/prisma/client';
import { AcceptPlanOfferDto, ProposePlanDto, SendPlanDto } from './plan-offers.dto';

/// Uma linha do plano que viaja de uma pessoa para outra. As categorias vão
/// pelo que as identifica em qualquer conta: a chave (as de base) ou o nome.
interface OfferLine {
  kind: 'CATEGORY' | 'CUSTOM';
  key: string | null;
  name: string | null;
  icon: string | null;
  color: string | null;
  amount: number;
}

const person = { select: { id: true, name: true, username: true, avatarUrl: true } } as const;
const include = { from: person, to: person } satisfies Prisma.MonthlyPlanOfferInclude;
type OfferFull = Prisma.MonthlyPlanOfferGetPayload<{ include: typeof include }>;

/// Quantas propostas por responder uma pessoa pode ter enviadas (sem spam).
const MAX_PENDING_SENT = 20;

const monthName = (key: string, lang: string) => {
  try {
    return new Intl.DateTimeFormat([lang, 'en'], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}-15T12:00:00Z`));
  } catch {
    return key;
  }
};

/// Enviar um plano do mês a outra pessoa: o meu plano como modelo, ou uma
/// proposta de quem acompanha os gastos de alguém. Quem recebe vê o plano,
/// e se aceitar ele passa a ser o seu plano do mês (com as suas categorias).
@Injectable()
export class PlanOffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: MonthlyPlansService,
    private readonly notifications: NotificationsService,
  ) {}

  private linesOf(offer: MonthlyPlanOffer): OfferLine[] {
    return Array.isArray(offer.lines) ? (offer.lines as unknown as OfferLine[]) : [];
  }

  /// A categoria de quem vê que corresponde a uma linha (pela chave ou pelo nome).
  private match(line: OfferLine, categories: Category[]): Category | null {
    if (line.kind !== 'CATEGORY') return null;
    if (line.key) return categories.find((c) => c.key === line.key) ?? null;
    const name = (line.name ?? '').trim().toLowerCase();
    return name ? (categories.find((c) => !c.key && (c.name ?? '').trim().toLowerCase() === name) ?? null) : null;
  }

  private dto(offer: OfferFull, viewerId: string, categories?: Category[]) {
    const lines = this.linesOf(offer);
    return {
      id: offer.id,
      status: offer.status,
      periodKey: offer.periodKey,
      note: offer.note,
      currency: offer.currency,
      /// null = quem enviou preferiu não mostrar o rendimento
      plannedIncome: offer.plannedIncome === null ? null : num(offer.plannedIncome),
      plannedSavings: num(offer.plannedSavings),
      plannedExpenses: round2(lines.reduce((acc, l) => acc + l.amount, 0)),
      linesCount: lines.length,
      from: offer.from,
      to: offer.to,
      /// Fui eu que enviei
      mine: offer.fromUserId === viewerId,
      /// Proposta de quem acompanha os meus gastos (em vez do plano de outra pessoa)
      proposal: offer.accessId !== null,
      appliedKey: offer.appliedKey,
      createdAt: offer.createdAt,
      respondedAt: offer.respondedAt,
      ...(categories
        ? {
            lines: lines.map((l) => {
              const mine = this.match(l, categories);
              return {
                kind: l.kind,
                name: l.name,
                amount: l.amount,
                /// A categoria como a app a mostra (a minha, se a tiver; senão a de quem enviou)
                category:
                  l.kind === 'CATEGORY'
                    ? { id: mine?.id ?? '', key: mine?.key ?? l.key, name: mine?.name ?? l.name, type: 'EXPENSE', icon: mine?.icon ?? l.icon ?? 'category', color: mine?.color ?? l.color ?? '#64748B', parentId: null }
                    : null,
                /// false = não tenho esta categoria: entra no meu plano como linha livre
                matched: l.kind === 'CATEGORY' ? !!mine : true,
              };
            }),
          }
        : {}),
    };
  }

  private async target(userId: string, dto: { userId?: string; username?: string }) {
    const user = await this.prisma.user.findFirst({
      where: { deletionRequestedAt: null, ...(dto.userId ? { id: dto.userId } : { username: (dto.username as string).replace(/^@/, '') }) },
      select: { id: true },
    });
    if (!user) throw ApiException.notFound('USER_NOT_FOUND');
    if (user.id === userId) throw ApiException.badRequest('PLAN_OFFER_SELF');
    return user;
  }

  private async assertRoom(userId: string) {
    const pending = await this.prisma.monthlyPlanOffer.count({ where: { fromUserId: userId, status: 'PENDING' } });
    if (pending >= MAX_PENDING_SENT) throw ApiException.badRequest('PLAN_OFFER_LIMIT', { max: MAX_PENDING_SENT });
  }

  private async notifyOffer(offer: OfferFull) {
    const data = { offerId: offer.id, from: offer.from.name, fromId: offer.fromUserId, periodKey: offer.periodKey, proposal: offer.accessId !== null };
    await this.notifications.notify(offer.toUserId, 'plan_offer', data, (ctx) => ({ ...data, month: monthName(offer.periodKey, ctx.lang) }));
  }

  /// Envia o meu plano de um mês a outra pessoa. Os objetivos são meus, por
  /// isso o dinheiro que lhes destino segue como "poupança".
  async send(userId: string, dto: SendPlanDto) {
    const target = await this.target(userId, dto);
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true } });
    const plan = await this.prisma.monthlyPlan.findUnique({
      where: { userId_periodKey: { userId, periodKey: dto.periodKey } },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!plan) throw ApiException.notFound('MONTHLY_PLAN_NOT_FOUND');
    const categories = new Map((await this.prisma.category.findMany({ where: { userId } })).map((c) => [c.id, c]));
    const lines: OfferLine[] = [];
    let savings = num(plan.plannedSavings);
    for (const l of plan.lines) {
      const amount = num(l.amount);
      if (l.goalId) {
        savings += amount;
      } else if (l.categoryId) {
        const c = categories.get(l.categoryId);
        if (c) lines.push({ kind: 'CATEGORY', key: c.key, name: c.name, icon: c.icon, color: c.color, amount });
      } else if (l.name) {
        lines.push({ kind: 'CUSTOM', key: null, name: l.name, icon: null, color: null, amount });
      }
    }
    if (!lines.length) throw ApiException.badRequest('PLAN_OFFER_EMPTY');
    const data = {
      note: dto.note ?? null,
      plannedIncome: dto.includeIncome ? plan.plannedIncome : null,
      plannedSavings: money(round2(savings)),
      currency: me?.currency ?? 'EUR',
      lines: lines as unknown as Prisma.InputJsonValue,
    };
    // Voltar a enviar o mesmo mês à mesma pessoa atualiza o pedido que ainda estava por responder.
    const existing = await this.prisma.monthlyPlanOffer.findFirst({ where: { fromUserId: userId, toUserId: target.id, periodKey: dto.periodKey, status: 'PENDING', accessId: null } });
    if (!existing) await this.assertRoom(userId);
    const offer = existing
      ? await this.prisma.monthlyPlanOffer.update({ where: { id: existing.id }, data: { ...data, createdAt: new Date() }, include })
      : await this.prisma.monthlyPlanOffer.create({ data: { ...data, fromUserId: userId, toUserId: target.id, periodKey: dto.periodKey }, include });
    await this.notifyOffer(offer);
    return this.dto(offer, userId);
  }

  /// Quem acompanha os gastos de alguém (`accessId`) propõe-lhe um plano
  /// para o mês, feito com as categorias dessa pessoa.
  async propose(userId: string, accessId: string, dto: ProposePlanDto) {
    const access = await this.prisma.sharedAccess.findFirst({ where: { id: accessId, viewerId: userId } });
    if (!access) throw ApiException.notFound('SHARE_NOT_FOUND');
    if (access.status !== 'ACTIVE') throw ApiException.forbidden('SHARE_NOT_ACTIVE');
    const owner = await this.prisma.user.findUnique({ where: { id: access.ownerId }, select: { currency: true, timezone: true, monthStartDay: true } });
    if (!owner) throw ApiException.notFound('SHARE_NOT_FOUND');
    // O mês é o de quem recebe: o atual, se não se disser outro (nunca um que já acabou).
    const current = financialMonth(todayIn(owner.timezone), owner.monthStartDay);
    const periodKey = dto.periodKey ?? current.key;
    if (financialMonthByKey(periodKey, owner.monthStartDay).end < current.start) throw ApiException.badRequest('MONTHLY_PLAN_CLOSED');

    const ids = [...new Set(dto.lines.map((l) => l.categoryId).filter((x): x is string => !!x))];
    const categories = new Map((ids.length ? await this.prisma.category.findMany({ where: { userId: access.ownerId, id: { in: ids }, type: 'EXPENSE' } }) : []).map((c) => [c.id, c]));
    if (categories.size !== ids.length) throw ApiException.notFound('CATEGORY_NOT_FOUND');
    const lines: OfferLine[] = dto.lines
      .filter((l) => l.amount > 0)
      .map((l) => {
        const c = l.categoryId ? categories.get(l.categoryId) : undefined;
        return c
          ? { kind: 'CATEGORY' as const, key: c.key, name: c.name, icon: c.icon, color: c.color, amount: round2(l.amount) }
          : { kind: 'CUSTOM' as const, key: null, name: l.name ?? '', icon: null, color: null, amount: round2(l.amount) };
      });
    if (!lines.length) throw ApiException.badRequest('PLAN_OFFER_EMPTY');
    const data = { note: dto.note ?? null, plannedIncome: null, plannedSavings: money(dto.plannedSavings), currency: owner.currency, lines: lines as unknown as Prisma.InputJsonValue };
    const existing = await this.prisma.monthlyPlanOffer.findFirst({ where: { fromUserId: userId, toUserId: access.ownerId, periodKey, status: 'PENDING', accessId } });
    if (!existing) await this.assertRoom(userId);
    const offer = existing
      ? await this.prisma.monthlyPlanOffer.update({ where: { id: existing.id }, data: { ...data, createdAt: new Date() }, include })
      : await this.prisma.monthlyPlanOffer.create({ data: { ...data, fromUserId: userId, toUserId: access.ownerId, periodKey, accessId }, include });
    await this.notifyOffer(offer);
    return this.dto(offer, userId);
  }

  /// `received` = planos que me enviaram · `sent` = os que enviei.
  async list(userId: string) {
    const [received, sent] = await Promise.all([
      this.prisma.monthlyPlanOffer.findMany({ where: { toUserId: userId, status: { not: 'CANCELLED' } }, include, orderBy: { createdAt: 'desc' }, take: 30 }),
      this.prisma.monthlyPlanOffer.findMany({ where: { fromUserId: userId, status: { not: 'CANCELLED' } }, include, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    return {
      received: received.map((o) => this.dto(o, userId)),
      sent: sent.map((o) => this.dto(o, userId)),
      pendingCount: received.filter((o) => o.status === 'PENDING').length,
    };
  }

  private async mine(userId: string, id: string): Promise<OfferFull> {
    const offer = await this.prisma.monthlyPlanOffer.findFirst({ where: { id, OR: [{ toUserId: userId }, { fromUserId: userId }] }, include });
    if (!offer) throw ApiException.notFound('PLAN_OFFER_NOT_FOUND');
    return offer;
  }

  /// O plano com as linhas — e, para quem o recebeu, os meses onde o pode
  /// usar (com aviso se já tiver um plano nesse mês).
  async get(userId: string, id: string) {
    const offer = await this.mine(userId, id);
    // As linhas mostram-se com as categorias de quem recebe.
    const categories = await this.prisma.category.findMany({ where: { userId: offer.toUserId, type: 'EXPENSE', archivedAt: null } });
    const base = this.dto(offer, userId, categories);
    if (offer.toUserId !== userId) return { ...base, months: [] };
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { timezone: true, monthStartDay: true } });
    // Usa-se no mês que se quiser: este ou qualquer um dos 11 seguintes.
    const months = [financialMonth(todayIn(me?.timezone ?? 'UTC'), me?.monthStartDay ?? 1)];
    while (months.length < 12) months.push(financialMonth(addDays(months[months.length - 1].end, 1), me?.monthStartDay ?? 1));
    const existing = new Set((await this.prisma.monthlyPlan.findMany({ where: { userId, periodKey: { in: months.map((m) => m.key) } }, select: { periodKey: true } })).map((p) => p.periodKey));
    return {
      ...base,
      months: months.map((p, i) => ({ key: p.key, start: p.start, end: p.end, isCurrent: i === 0, hasPlan: existing.has(p.key) })),
    };
  }

  /// Passo a usar o plano: fica como o meu plano desse mês (substitui o que
  /// lá estava). O rendimento é o meu — o de quem enviou só serve se eu
  /// ainda não tiver nenhum e ele o tiver mostrado.
  async accept(userId: string, id: string, dto: AcceptPlanOfferDto) {
    const offer = await this.prisma.monthlyPlanOffer.findFirst({ where: { id, toUserId: userId }, include });
    if (!offer) throw ApiException.notFound('PLAN_OFFER_NOT_FOUND');
    if (offer.status !== 'PENDING') throw ApiException.badRequest('PLAN_OFFER_CLOSED');
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, timezone: true, monthStartDay: true } });
    const key = dto.periodKey ?? financialMonth(todayIn(me?.timezone ?? 'UTC'), me?.monthStartDay ?? 1).key;

    const categories = await this.prisma.category.findMany({ where: { userId, type: 'EXPENSE', archivedAt: null } });
    const byCategory = new Map<string, number>();
    const custom = new Map<string, number>();
    for (const l of this.linesOf(offer)) {
      const c = this.match(l, categories);
      if (c) byCategory.set(c.id, round2((byCategory.get(c.id) ?? 0) + l.amount));
      else {
        const name = (l.name ?? l.key ?? '').trim().slice(0, 60);
        // Uma linha sem nome nem categoria não tem como entrar no plano.
        if (!name) continue;
        custom.set(name, round2((custom.get(name) ?? 0) + l.amount));
      }
    }
    const before = await this.plans.get(userId, key);
    const plannedIncome = before.plan?.plannedIncome ?? (offer.plannedIncome !== null ? num(offer.plannedIncome) : (before.suggestion?.plannedIncome ?? 0));
    const plan = await this.plans.save(userId, key, {
      plannedIncome,
      plannedSavings: num(offer.plannedSavings),
      note: before.plan?.note ?? null,
      lines: [
        ...[...byCategory.entries()].map(([categoryId, amount]) => ({ categoryId, amount })),
        ...[...custom.entries()].map(([name, amount]) => ({ name, amount })),
      ],
    });
    await this.prisma.monthlyPlanOffer.update({ where: { id }, data: { status: 'ACCEPTED', appliedKey: key, respondedAt: new Date() } });
    const data = { offerId: id, from: me?.name ?? '', periodKey: key };
    await this.notifications.notify(offer.fromUserId, 'plan_offer_accepted', data, (ctx) => ({ ...data, month: monthName(key, ctx.lang) }));
    return { offer: this.dto({ ...offer, status: 'ACCEPTED', appliedKey: key }, userId), plan };
  }

  async decline(userId: string, id: string) {
    const offer = await this.prisma.monthlyPlanOffer.findFirst({ where: { id, toUserId: userId }, include });
    if (!offer) throw ApiException.notFound('PLAN_OFFER_NOT_FOUND');
    if (offer.status !== 'PENDING') throw ApiException.badRequest('PLAN_OFFER_CLOSED');
    await this.prisma.monthlyPlanOffer.update({ where: { id }, data: { status: 'DECLINED', respondedAt: new Date() } });
    const data = { offerId: id, from: offer.to.name, periodKey: offer.periodKey };
    await this.notifications.notify(offer.fromUserId, 'plan_offer_declined', data, (ctx) => ({ ...data, month: monthName(offer.periodKey, ctx.lang) }));
    return { declined: true };
  }

  /// Quem enviou desiste (ou tira da lista um pedido já respondido).
  async remove(userId: string, id: string) {
    const offer = await this.prisma.monthlyPlanOffer.findFirst({ where: { id, fromUserId: userId } });
    if (!offer) throw ApiException.notFound('PLAN_OFFER_NOT_FOUND');
    await this.prisma.monthlyPlanOffer.update({ where: { id }, data: { status: 'CANCELLED', respondedAt: offer.respondedAt ?? new Date() } });
    return { deleted: true };
  }
}
