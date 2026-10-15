import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { BudgetsService } from '../budgets/budgets.service';
import { TransactionsService } from '../transactions/transactions.service';
import { GoalsService } from '../goals/goals.service';
import { lineStatus, MonthlyPlansService } from '../monthly-plans/monthly-plans.service';
import { PlansService } from '../plans/plans.service';
import { RecurringService } from '../recurring/recurring.service';
import { ExchangeService } from '../exchange/exchange.service';
import { toCategoryDto } from '../categories/categories.service';
import { ApiException } from '../common/errors/api.exception';
import { resolveLanguage } from '../common/i18n/messages';
import { addDays, daysBetween, financialMonth, financialMonthByKey, fromDbDate, isMonthKey, minDate, todayIn, toDbDate } from '../common/utils/dates';
import { num, round2 } from '../common/utils/money';
import { Prisma, ShareScope } from '../generated/prisma/client';
import { SECTION_PRESETS, ShareInviteDto, ShareSection, SharedTransactionsQuery, ShareUpdateDto } from './sharing.dto';
import { DailyLimitService } from '../daily-limit/daily-limit.service';
import { HELP_NEEDS_INCOME, helpSections, HelpSection } from './help';

const person = { select: { id: true, name: true, username: true, avatarUrl: true } } as const;
const include = { owner: person, viewer: person } satisfies Prisma.SharedAccessInclude;
type Access = Prisma.SharedAccessGetPayload<{ include: typeof include }>;

const INVITE_MAIL: Record<string, { subject: string; body: string }> = {
  pt: { subject: '{from} quer partilhar os gastos contigo no Contalexy', body: 'Olá!\n\n{from} convidou-te para acompanhares os seus gastos mensais no Contalexy. É só para ver e ajudar a organizar.\n\nCria a tua conta com este email e o convite aparece logo na app.' },
  en: { subject: '{from} wants to share their spending with you on Contalexy', body: 'Hi!\n\n{from} invited you to follow their monthly spending on Contalexy. It is view only, to help them stay organised.\n\nCreate your account with this email and the invitation will be waiting in the app.' },
  fr: { subject: '{from} veut partager ses dépenses avec toi sur Contalexy', body: 'Bonjour !\n\n{from} t’a invité à suivre ses dépenses mensuelles sur Contalexy. C’est en lecture seule, pour l’aider à s’organiser.\n\nCrée ton compte avec cet e-mail et l’invitation t’attendra dans l’app.' },
  de: { subject: '{from} möchte seine Ausgaben mit dir auf Contalexy teilen', body: 'Hallo!\n\n{from} hat dich eingeladen, die monatlichen Ausgaben auf Contalexy mitzuverfolgen. Du kannst nur ansehen und beim Organisieren helfen.\n\nErstelle dein Konto mit dieser E-Mail, dann wartet die Einladung in der App.' },
};

/// Acompanhamento: a pessoa convida alguém de confiança (a mãe, o
/// companheiro…) para VER como tem gasto em cada mês e deixar notas. Só
/// leitura, sem saldos das contas, e quem partilha pode parar quando quiser.
@Injectable()
export class SharingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly budgets: BudgetsService,
    private readonly transactions: TransactionsService,
    private readonly goals: GoalsService,
    private readonly monthlyPlans: MonthlyPlansService,
    private readonly plans: PlansService,
    private readonly recurring: RecurringService,
    private readonly exchange: ExchangeService,
    private readonly daily: DailyLimitService,
  ) {}

  private dto(a: Access, userId: string) {
    const isOwner = a.ownerId === userId;
    // Um convite feito por email só mostra o email até ser aceite: não se
    // revela a quem pertence (nome/username) um email que se experimentou.
    const hidden = isOwner && !!a.email && a.status !== 'ACTIVE';
    return {
      id: a.id,
      status: a.status,
      scope: a.scope,
      /// O que quem acompanha pode ver (income, plan, budgets, goals, transactions, plans, recurring)
      sections: a.sections,
      /// Há categorias que ficam de fora de tudo ("mostrar tudo exceto")
      partial: a.hiddenCategoryIds.length > 0,
      /// Quais são, só quem partilha sabe
      hiddenCategoryIds: isOwner ? a.hiddenCategoryIds : [],
      /// Onde quem acompanha pode ajudar a gerir (goals, budgets, plan, plans, recurring, transactions)
      manage: helpSections(a),
      isOwner,
      /// A outra pessoa (quem vê os meus gastos / de quem eu vejo os gastos)
      person: isOwner ? (hidden ? null : a.viewer) : a.owner,
      /// Convite feito por email (ainda sem conta ou ainda por aceitar)
      email: isOwner && (hidden || !a.viewer) ? a.email : null,
      createdAt: a.createdAt,
      respondedAt: a.respondedAt,
    };
  }

  /// `given` = quem pode ver os meus gastos · `received` = de quem eu vejo.
  async list(userId: string) {
    const [given, received] = await Promise.all([
      this.prisma.sharedAccess.findMany({ where: { ownerId: userId, status: { in: ['PENDING', 'ACTIVE', 'DECLINED'] } }, include, orderBy: { createdAt: 'desc' } }),
      this.prisma.sharedAccess.findMany({ where: { viewerId: userId, status: { in: ['PENDING', 'ACTIVE'] } }, include, orderBy: { createdAt: 'desc' } }),
    ]);
    const limit = await this.entitlements.limit(userId, 'sharedViewers');
    return {
      given: given.map((a) => this.dto(a, userId)),
      received: received.map((a) => this.dto(a, userId)),
      pendingReceived: received.filter((a) => a.status === 'PENDING').length,
      limit,
    };
  }

  async invite(userId: string, dto: ShareInviteDto) {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true, language: true } });
    if (!me) throw ApiException.unauthorized('SESSION_EXPIRED');
    const target = dto.username
      ? await this.prisma.user.findUnique({ where: { username: dto.username.replace(/^@/, '') }, select: { id: true } })
      : await this.prisma.user.findUnique({ where: { email: dto.email as string }, select: { id: true } });
    if (dto.username && !target) throw ApiException.notFound('USER_NOT_FOUND');
    if (target?.id === userId || (!target && dto.email === me.email)) throw ApiException.badRequest('CANNOT_INVITE_SELF');

    const existing = await this.prisma.sharedAccess.findFirst({
      where: { ownerId: userId, ...(target ? { viewerId: target.id } : { viewerId: null, email: dto.email }) },
      include,
    });
    if (existing && (existing.status === 'PENDING' || existing.status === 'ACTIVE')) throw ApiException.conflict('SHARE_ALREADY_EXISTS');

    const active = await this.prisma.sharedAccess.count({ where: { ownerId: userId, status: { in: ['PENDING', 'ACTIVE'] } } });
    await this.entitlements.assertLimit(userId, 'sharedViewers', active);
    const visibility = await this.visibility(userId, dto.sections ?? SECTION_PRESETS[dto.scope], dto.hiddenCategoryIds ?? [], dto.manage ?? []);

    // Um convite recusado/terminado para a mesma pessoa é reaproveitado.
    const access = existing
      ? await this.prisma.sharedAccess.update({ where: { id: existing.id }, data: { status: 'PENDING', ...visibility, respondedAt: null, createdAt: new Date() }, include })
      : await this.prisma.sharedAccess.create({
          data: { ownerId: userId, viewerId: target?.id ?? null, email: dto.username ? null : (dto.email ?? null), ...visibility },
          include,
        });
    if (target) {
      await this.notifications.notify(target.id, 'sharing_invite', { accessId: access.id, from: me.name, fromId: userId });
    } else if (dto.email) {
      const tpl = INVITE_MAIL[resolveLanguage(me.language)] ?? INVITE_MAIL.en;
      await this.mail.send(dto.email, tpl.subject.replace('{from}', me.name), tpl.body.replace('{from}', me.name));
    }
    return this.dto(access, userId);
  }

  private async find(id: string) {
    const access = await this.prisma.sharedAccess.findUnique({ where: { id }, include });
    if (!access) throw ApiException.notFound('SHARE_NOT_FOUND');
    return access;
  }

  /// O acesso, se eu for quem partilha ou quem vê (senão "não encontrado").
  private async mine(userId: string, id: string) {
    const access = await this.find(id);
    if (access.ownerId !== userId && access.viewerId !== userId) throw ApiException.notFound('SHARE_NOT_FOUND');
    return access;
  }

  /// Para ler dados: quem partilha (pré-visualização) ou quem vê, com o convite aceite.
  private async readable(userId: string, id: string) {
    const access = await this.mine(userId, id);
    if (access.ownerId !== userId && access.status !== 'ACTIVE') throw ApiException.forbidden('SHARE_NOT_ACTIVE');
    return access;
  }

  /// O que fica guardado num acesso: as secções (sem repetidos), as categorias
  /// reservadas (só as de despesa de quem partilha), onde pode ajudar a gerir
  /// e o âmbito que lhes corresponde. Ajudar numa área mostra-a; no plano do mês
  /// e nas despesas fixas mostra também o que entra. Com categorias reservadas
  /// não se pode ajudar a gerir.
  private async visibility(ownerId: string, sections: ShareSection[], hiddenCategoryIds: string[], manage: HelpSection[]) {
    const ids = [...new Set(hiddenCategoryIds)];
    const helps = [...new Set(manage)];
    if (ids.length && helps.length) throw ApiException.badRequest('SHARE_HELP_NEEDS_ALL');
    if (ids.length) {
      const found = await this.prisma.category.count({ where: { userId: ownerId, id: { in: ids }, type: 'EXPENSE' } });
      if (found !== ids.length) throw ApiException.notFound('CATEGORY_NOT_FOUND');
    }
    const list = new Set<ShareSection>(sections);
    for (const h of helps) {
      list.add(h);
      if (HELP_NEEDS_INCOME.includes(h)) list.add('income');
    }
    const all = [...list];
    return { sections: all, hiddenCategoryIds: ids, manageSections: helps, scope: (all.includes('transactions') ? 'FULL' : 'SUMMARY') as ShareScope };
  }

  /// Quem partilha muda o que a outra pessoa vê: as secções e as categorias
  /// que ficam de fora. (`scope` sozinho liga/desliga só a lista de movimentos.)
  async update(userId: string, id: string, dto: ShareUpdateDto) {
    const access = await this.find(id);
    if (access.ownerId !== userId) throw ApiException.notFound('SHARE_NOT_FOUND');
    let sections = access.sections as ShareSection[];
    if (dto.sections) sections = dto.sections;
    else if (dto.scope) sections = dto.scope === 'FULL' ? [...sections, 'transactions'] : sections.filter((x) => x !== 'transactions');
    // Deixar de mostrar uma área tira também a ajuda nela.
    const manage = (dto.manage ?? (access.manageSections as HelpSection[])).filter((h) => dto.manage !== undefined || sections.includes(h));
    const visibility = await this.visibility(userId, sections, dto.hiddenCategoryIds ?? access.hiddenCategoryIds, manage);
    const before = helpSections(access);
    const updated = await this.prisma.sharedAccess.update({ where: { id }, data: visibility, include });
    // Passou a poder ajudar em mais alguma área: avisa quem acompanha.
    const added = helpSections(updated).filter((h) => !before.includes(h));
    if (added.length && updated.viewerId && updated.status === 'ACTIVE') {
      await this.notifications.notify(updated.viewerId, 'sharing_help', { accessId: id, from: updated.owner.name, fromId: userId, sections: added.join(',') });
    }
    return this.dto(updated, userId);
  }

  /// Quem partilha deixa de partilhar — ou quem vê deixa de acompanhar.
  async remove(userId: string, id: string) {
    await this.mine(userId, id);
    await this.prisma.sharedAccess.delete({ where: { id } });
    return { deleted: true };
  }

  async accept(userId: string, id: string) {
    const access = await this.find(id);
    if (access.viewerId !== userId) throw ApiException.notFound('SHARE_NOT_FOUND');
    if (access.status !== 'PENDING') throw ApiException.badRequest('INVITATION_CLOSED');
    const updated = await this.prisma.sharedAccess.update({ where: { id }, data: { status: 'ACTIVE', respondedAt: new Date() }, include });
    await this.notifications.notify(access.ownerId, 'sharing_accepted', { accessId: id, from: access.viewer?.name ?? '' });
    return this.dto(updated, userId);
  }

  async decline(userId: string, id: string) {
    const access = await this.find(id);
    if (access.viewerId !== userId) throw ApiException.notFound('SHARE_NOT_FOUND');
    if (access.status !== 'PENDING') throw ApiException.badRequest('INVITATION_CLOSED');
    await this.prisma.sharedAccess.update({ where: { id }, data: { status: 'DECLINED', respondedAt: new Date() } });
    return { declined: true };
  }

  // ------------------------------------------------------------------
  // O que quem acompanha vê
  // ------------------------------------------------------------------

  private async ownerSettings(ownerId: string) {
    const owner = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { currency: true, timezone: true, monthStartDay: true } });
    if (!owner) throw ApiException.notFound('SHARE_NOT_FOUND');
    return { ...owner, today: todayIn(owner.timezone) };
  }

  /// O mês (financeiro, de quem partilha) pedido ou o atual. Nunca o futuro.
  private period(key: string | undefined, s: { today: string; monthStartDay: number }) {
    const current = financialMonth(s.today, s.monthStartDay);
    if (!key) return current;
    if (!isMonthKey(key)) throw ApiException.badRequest('INVALID_REQUEST');
    const period = financialMonthByKey(key, s.monthStartDay);
    return period.start > current.start ? current : period;
  }

  /// O que este acesso deixa ver e as categorias que ficam de fora (com as subcategorias).
  private async rules(access: Access) {
    const sections = new Set(access.sections);
    const expanded = access.hiddenCategoryIds.length ? ((await this.transactions.expandCategories(access.ownerId, access.hiddenCategoryIds)) ?? []) : [];
    const hidden = new Set(expanded.filter((c) => c !== 'none'));
    return { sections, can: (section: ShareSection) => sections.has(section), hidden, hiddenList: [...hidden], isHidden: (categoryId: string | null | undefined) => !!categoryId && hidden.has(categoryId) };
  }

  /// Os gastos de um mês de quem partilha: totais e categorias, e o que a
  /// pessoa escolheu mostrar (plano, limites, objetivos, planos, despesas
  /// fixas). Sem saldos nem nomes de contas, e sem as categorias reservadas.
  async overview(userId: string, id: string, month?: string) {
    const access = await this.readable(userId, id);
    const ownerId = access.ownerId;
    const s = await this.ownerSettings(ownerId);
    const r = await this.rules(access);
    const period = this.period(month, s);
    const isCurrent = s.today >= period.start && s.today <= period.end;
    const to = isCurrent ? s.today : period.end;
    const elapsed = daysBetween(period.start, to) + 1;
    const previous = financialMonth(addDays(period.start, -1), s.monthStartDay);
    const exclude = r.hiddenList.length ? { excludeCategoryIds: r.hiddenList } : {};

    const [summary, before, plan, budgets, goals, plans, fixed, first, today] = await Promise.all([
      this.transactions.summary(ownerId, { from: period.start, to: period.end, ...exclude }),
      // Mesmo número de dias do mês anterior (comparação justa a meio do mês).
      this.transactions.summary(ownerId, { from: previous.start, to: minDate(previous.end, addDays(previous.start, elapsed - 1)), ...exclude }),
      r.can('plan') ? this.monthlyPlans.get(ownerId, period.key, { suggestion: false }) : null,
      r.can('budgets') ? this.budgets.list(ownerId, to) : [],
      r.can('goals') ? this.goals.list(ownerId) : [],
      r.can('plans') ? this.plans.list(ownerId) : [],
      r.can('recurring') ? this.recurring.list(ownerId) : null,
      this.prisma.transaction.findFirst({ where: { userId: ownerId }, orderBy: { date: 'asc' }, select: { date: true } }),
      // O limite do dia conta todas as despesas de hoje: só aparece sem categorias reservadas.
      r.can('budgets') && r.hidden.size === 0 && isCurrent ? this.daily.get(ownerId) : null,
    ]);
    const firstMonth = first ? financialMonth(minDate(fromDbDate(first.date), s.today), s.monthStartDay).key : period.key;
    const showIncome = r.can('income');

    // O plano do mês, só com as linhas que se podem ver (e as contas refeitas por elas).
    let planDto = null;
    if (plan?.plan) {
      const lines = plan.plan.lines.filter((l) => !r.isHidden(l.categoryId) && (l.kind !== 'GOAL' || r.can('goals')));
      const spending = lines.filter((l) => l.kind !== 'GOAL');
      const partial = r.hidden.size > 0;
      planDto = {
        plannedIncome: showIncome ? plan.plan.plannedIncome : null,
        plannedExpenses: partial ? round2(spending.reduce((acc, l) => acc + l.planned, 0)) : plan.plan.plannedExpenses,
        plannedSavings: round2(plan.plan.plannedSavings + plan.plan.plannedGoals),
        saved: plan.actualSaved,
        leftToSpend: partial ? round2(spending.reduce((acc, l) => acc + Math.max(0, l.planned - (l.actual ?? 0)), 0)) : plan.plan.leftToSpend,
        unplannedSpent: partial ? round2(plan.plan.unplanned.filter((u) => !r.isHidden(u.categoryId)).reduce((acc, u) => acc + u.amount, 0)) : plan.plan.unplannedSpent,
        status: lines.some((l) => l.status === 'EXCEEDED') ? 'EXCEEDED' : lines.some((l) => l.status === 'WARNING') ? 'WARNING' : 'OK',
        lines: lines.map((l) => ({ kind: l.kind, category: l.category, goal: l.goal, name: l.name, planned: l.planned, actual: l.actual, percent: l.percent, status: l.status })),
      };
    }

    const fixedItems = (fixed?.items ?? []).filter((i) => i.isActive && i.type !== 'TRANSFER' && (i.type !== 'INCOME' || showIncome) && !r.isHidden(i.category?.id));

    return {
      access: this.dto(access, userId),
      currency: s.currency,
      today: s.today,
      period: { key: period.key, start: period.start, end: period.end, isCurrent, daysLeft: isCurrent ? daysBetween(s.today, period.end) : 0 },
      /// O mês mais antigo com movimentos (para a app saber até onde recuar)
      firstMonth,
      /// O que este acesso mostra, e se há categorias que ficam de fora dos números
      sections: [...r.sections],
      partial: r.hidden.size > 0,
      /// null = quem partilha não mostra o que entra
      income: showIncome ? summary.income : null,
      expenses: summary.expense,
      net: showIncome ? summary.net : null,
      savingsRate: showIncome && summary.income > 0 ? round2(((summary.income - summary.expense) / summary.income) * 100) : null,
      transactionsCount: summary.count,
      previousExpenses: before.expense,
      expenseChange: before.expense > 0 ? round2(((summary.expense - before.expense) / before.expense) * 100) : null,
      averagePerDay: round2(summary.expense / Math.max(1, elapsed)),
      byCategory: summary.expenseByCategory,
      byDay: (summary.byDay ?? []).map((d) => ({ date: d.date, expense: d.expense })),
      plan: planDto,
      // Um limite geral (de todas as despesas) inclui as categorias reservadas: nesse caso não se mostra.
      budgets: budgets
        .filter((b) => b.isActive && !(r.hidden.size > 0 && (b.categoryIds.length === 0 || b.categoryIds.some((c) => r.hidden.has(c)))))
        .map((b) => ({ id: b.id, name: b.name, period: b.period, currency: b.currency, amount: b.available, spent: b.spent, remaining: b.remaining, percent: b.percent, status: b.status, categories: b.categories })),
      goals: goals
        .filter((g) => g.status === 'ACTIVE')
        .map((g) => ({ id: g.id, name: g.name, icon: g.icon, color: g.color, currency: g.currency, targetAmount: g.targetAmount, saved: g.saved, progress: g.progress, startDate: g.startDate, targetDate: g.targetDate, stepsTotal: g.stepsTotal, stepsDone: g.stepsDone })),
      /// Planos (viagem, compras, negócio…), os que estão a decorrer e os já fechados
      plans: plans
        .filter((p) => !r.isHidden(p.categoryId))
        .slice(0, 40)
        .map((p) => ({ id: p.id, name: p.name, type: p.type, status: p.status, icon: p.icon, color: p.color, currency: p.currency, budget: p.budget, estimated: p.estimated, spent: p.spent, itemsTotal: p.itemsTotal, itemsDone: p.itemsDone, progress: p.progress, startDate: p.startDate, endDate: p.endDate, periodKey: p.periodKey })),
      /// Despesas fixas (e receitas, se quem partilha mostrar o que entra)
      recurring: fixedItems.map((i) => ({ id: i.id, type: i.type, description: i.description, amount: i.amount, currency: i.currency, frequency: i.frequency, interval: i.interval, nextDate: i.nextDate, kind: i.kind, category: i.category })),
      recurringMonthly: round2(fixedItems.filter((i) => i.type === 'EXPENSE').reduce((acc, i) => acc + (this.exchange.convert(i.monthlyEquivalent, i.currency, s.currency) ?? 0), 0)),
      /// O limite do dia de hoje (null = sem limite ou sem a secção dos limites)
      dailyLimit: today && today.limit !== null ? { limit: today.limit, spent: today.spent, left: today.left, status: today.status, onlyToday: today.onlyToday } : null,
    };
  }

  /// O que quem ajuda mudou na conta de quem partilha (mais recente primeiro).
  async activity(userId: string, id: string) {
    const access = await this.mine(userId, id);
    const rows = await this.prisma.sharedActivity.findMany({ where: { accessId: id }, orderBy: { createdAt: 'desc' }, take: 60 });
    const actor = access.viewer;
    return rows.map((a) => ({ id: a.id, section: a.section, action: a.action, label: a.label, createdAt: a.createdAt, mine: a.actorId === userId, actor: actor && actor.id === a.actorId ? actor : null }));
  }

  /// Os planos do mês de quem partilha, do mais recente para o mais antigo:
  /// quanto se planeou gastar e quanto se gastou em cada mês.
  async history(userId: string, id: string, limit = 12) {
    const access = await this.readable(userId, id);
    const r = await this.rules(access);
    if (!r.can('plan')) throw ApiException.forbidden('SHARE_SECTION_HIDDEN');
    const s = await this.ownerSettings(access.ownerId);
    const current = financialMonth(s.today, s.monthStartDay);
    const plans = await this.prisma.monthlyPlan.findMany({
      where: { userId: access.ownerId, periodKey: { lte: current.key } },
      include: { lines: true },
      orderBy: { periodKey: 'desc' },
      take: Math.min(Math.max(limit, 1), 36),
    });
    const exclude = r.hiddenList.length ? { excludeCategoryIds: r.hiddenList } : {};
    const items = [];
    for (const p of plans) {
      const period = financialMonthByKey(p.periodKey, s.monthStartDay);
      const summary = await this.transactions.summary(access.ownerId, { from: period.start, to: period.end, ...exclude });
      const planned = round2(p.lines.filter((l) => !l.goalId && !r.isHidden(l.categoryId)).reduce((acc, l) => acc + num(l.amount), 0));
      items.push({
        key: p.periodKey,
        start: period.start,
        end: period.end,
        isCurrent: p.periodKey === current.key,
        plannedExpenses: planned,
        actualExpenses: summary.expense,
        /// Real − planeado: positivo = gastou mais do que planeou
        difference: round2(summary.expense - planned),
        status: lineStatus(planned, summary.expense),
      });
    }
    return { currency: s.currency, items };
  }

  /// A lista de movimentos, quando quem partilha a mostra. Pode filtrar-se
  /// por mês ou intervalo, categoria, tipo, texto e valor.
  async transactionsOf(userId: string, id: string, query: SharedTransactionsQuery) {
    const access = await this.readable(userId, id);
    const r = await this.rules(access);
    if (!r.can('transactions')) throw ApiException.forbidden('SHARE_SCOPE_SUMMARY');
    const s = await this.ownerSettings(access.ownerId);
    // Um intervalo à escolha (nunca para lá de hoje) ou o mês pedido.
    const period = this.period(query.month, s);
    const from = query.from ?? (query.to ? undefined : period.start);
    const to = minDate(query.to ?? (query.from ? s.today : period.end), s.today);
    if (from && to < from) throw ApiException.badRequest('DATE_RANGE_INVALID');
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    if (query.categoryId && r.isHidden(query.categoryId)) return { data: [], meta: { nextOffset: null } };
    const categoryIds = query.categoryId ? ((await this.transactions.expandCategories(access.ownerId, [query.categoryId])) ?? []).filter((c) => c !== 'none') : undefined;
    // Sem o que entra à vista, só se listam despesas.
    const types: Array<'INCOME' | 'EXPENSE'> = query.type ? [query.type] : ['INCOME', 'EXPENSE'];
    const allowed = types.filter((t) => t === 'EXPENSE' || r.can('income'));
    if (!allowed.length) return { data: [], meta: { nextOffset: null } };
    const q = query.q;
    const rows = await this.prisma.transaction.findMany({
      where: {
        userId: access.ownerId,
        excludeFromReports: false,
        type: { in: allowed },
        date: { ...(from ? { gte: toDbDate(from) } : {}), lte: toDbDate(to) },
        ...(query.minAmount !== undefined || query.maxAmount !== undefined
          ? { amount: { ...(query.minAmount !== undefined ? { gte: query.minAmount } : {}), ...(query.maxAmount !== undefined ? { lte: query.maxAmount } : {}) } }
          : {}),
        AND: [
          ...(categoryIds ? [{ categoryId: { in: categoryIds } }] : []),
          ...(r.hiddenList.length ? [{ OR: [{ categoryId: null }, { categoryId: { notIn: r.hiddenList } }] }] : []),
          // Procura-se no que se mostra: a descrição e o comerciante (nunca nas notas).
          ...(q ? [{ OR: [{ description: { contains: q, mode: 'insensitive' as const } }, { merchant: { contains: q, mode: 'insensitive' as const } }] }] : []),
        ],
      },
      include: { category: true },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      skip: offset,
      take: limit + 1,
    });
    // Só o essencial: nada de contas, notas, recibos ou localização.
    const items = rows.slice(0, limit).map((t) => ({
      id: t.id,
      type: t.type,
      amount: num(t.amount),
      currency: t.currency,
      date: fromDbDate(t.date),
      description: t.description,
      merchant: t.merchant,
      category: t.category ? toCategoryDto(t.category) : null,
    }));
    return { data: items, meta: { nextOffset: rows.length > limit ? offset + limit : null } };
  }

  // ------------------------------------------------------------------
  // Notas ("tenta gastar menos em…")
  // ------------------------------------------------------------------

  async notes(userId: string, id: string) {
    const access = await this.readable(userId, id);
    const notes = await this.prisma.sharedNote.findMany({ where: { accessId: id }, orderBy: { createdAt: 'desc' }, take: 100 });
    const names = new Map<string, { id: string; name: string; username: string; avatarUrl: string | null }>();
    names.set(access.owner.id, access.owner);
    if (access.viewer) names.set(access.viewer.id, access.viewer);
    return notes.map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt, mine: n.authorId === userId, author: names.get(n.authorId) ?? null }));
  }

  async addNote(userId: string, id: string, text: string) {
    const access = await this.readable(userId, id);
    if (access.status !== 'ACTIVE') throw ApiException.forbidden('SHARE_NOT_ACTIVE');
    await this.prisma.sharedNote.create({ data: { accessId: id, authorId: userId, text } });
    const isOwner = access.ownerId === userId;
    const other = isOwner ? access.viewerId : access.ownerId;
    const from = isOwner ? access.owner.name : (access.viewer?.name ?? '');
    if (other) await this.notifications.notify(other, 'sharing_note', { accessId: id, from, text: text.length > 120 ? `${text.slice(0, 117)}…` : text });
    return this.notes(userId, id);
  }

  async removeNote(userId: string, id: string, noteId: string) {
    await this.mine(userId, id);
    const result = await this.prisma.sharedNote.deleteMany({ where: { id: noteId, accessId: id, authorId: userId } });
    if (!result.count) throw ApiException.notFound('SHARE_NOTE_NOT_FOUND');
    return this.notes(userId, id);
  }
}
