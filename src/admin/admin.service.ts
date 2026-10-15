import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ACCESS_STATUSES, EntitlementsService } from '../billing/entitlements.service';
import { SubscriptionsService } from '../billing/subscriptions.service';
import { ExchangeService } from '../exchange/exchange.service';
import { AiBudgetService } from '../ai/ai-budget.service';
import { ApiException } from '../common/errors/api.exception';
import { adminAreasOf, isAdminUser } from '../common/utils/admin';
import { round2 } from '../common/utils/money';
import { env } from '../config/env';
import { Prisma, RevenueEvent, Subscription } from '../generated/prisma/client';

/// De onde vem o plano de cada pessoa:
/// paid = pagou na loja (é o ÚNICO que conta para a receita) · trial = período
/// grátis da loja · promo = código promocional · grant = oferta (atribuído
/// pela administração ou pelo RevenueCat) · test = compras de teste (sandbox)
export type PremiumKind = 'paid' | 'trial' | 'promo' | 'grant' | 'test';
const KIND_ORDER: PremiumKind[] = ['paid', 'trial', 'promo', 'grant', 'test'];

export function premiumKind(sub: Pick<Subscription, 'provider' | 'status' | 'isPaid' | 'isSandbox'>): PremiumKind {
  if (sub.provider === 'PROMO') return 'promo';
  if (sub.provider === 'GRANT') return 'grant';
  if (sub.provider !== 'REVENUECAT' || sub.isSandbox) return 'test';
  if (sub.status === 'TRIAL') return 'trial';
  return sub.isPaid ? 'paid' : 'grant';
}

const monthKeyOf = (date: Date) => date.toISOString().slice(0, 7);
const monthStartUtc = (date: Date, offset = 0) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));

/// Um produto é anual? (pelo nome do produto ou pela duração da assinatura)
export function isYearly(productId: string | null, start?: Date | null, end?: Date | null): boolean {
  if (productId && /(year|annual|anual|12m)/i.test(productId)) return true;
  return !!start && !!end && end.getTime() - start.getTime() > 200 * 86_400_000;
}

export interface Totals {
  gross: number;
  refunds: number;
  net: number;
  proceeds: number;
  payments: number;
  refundCount: number;
}

/// Área de administração: quem tem Premium e porquê (pago, código,
/// oferta), a receita a sério (só pagamentos), códigos promocionais,
/// utilizadores e o custo da IA.
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly exchange: ExchangeService,
    private readonly budget: AiBudgetService,
  ) {}

  /// A melhor assinatura válida de cada pessoa (o plano que tem agora) e de onde vem.
  private async premiumUsers() {
    const now = new Date();
    const subs = await this.prisma.subscription.findMany({
      where: { status: { in: [...ACCESS_STATUSES] }, OR: [{ expirationDate: null }, { expirationDate: { gt: now } }] },
    });
    const ranks = new Map((await this.entitlements.listPlans()).map((p) => [p.code, p.rank]));
    const best = new Map<string, { sub: Subscription; kind: PremiumKind; rank: number }>();
    for (const sub of subs) {
      const rank = ranks.get(sub.plan) ?? -1;
      if (rank <= 0) continue;
      const kind = premiumKind(sub);
      const current = best.get(sub.userId);
      if (!current || rank > current.rank || (rank === current.rank && KIND_ORDER.indexOf(kind) < KIND_ORDER.indexOf(current.kind))) {
        best.set(sub.userId, { sub, kind, rank });
      }
    }
    return best;
  }

  /// O que chega à conta depois da comissão da loja e dos impostos (estimativa).
  private proceedsOf(e: Pick<RevenueEvent, 'amountUsd' | 'commissionRate' | 'taxRate'>): number {
    const commission = e.commissionRate !== null ? Number(e.commissionRate) : env().STORE_COMMISSION_DEFAULT;
    const tax = e.taxRate !== null ? Number(e.taxRate) : 0;
    return Number(e.amountUsd) * Math.max(0, 1 - commission - tax);
  }

  private emptyTotals(): Totals {
    return { gross: 0, refunds: 0, net: 0, proceeds: 0, payments: 0, refundCount: 0 };
  }

  private addTo(t: Totals, e: RevenueEvent) {
    const usd = Number(e.amountUsd);
    if (usd >= 0) {
      t.gross += usd;
      t.payments += 1;
    } else {
      t.refunds += usd;
      t.refundCount += 1;
    }
    t.net += usd;
    t.proceeds += this.proceedsOf(e);
  }

  private rounded<T extends Totals>(t: T): T {
    return { ...t, gross: round2(t.gross), refunds: round2(t.refunds), net: round2(t.net), proceeds: round2(t.proceeds) };
  }

  /// A moeda do administrador, para mostrar os totais (que estão em USD) também nela.
  private async display(adminId: string) {
    const admin = await this.prisma.user.findUnique({ where: { id: adminId }, select: { currency: true } });
    const currency = admin?.currency ?? 'USD';
    return { currency, usdRate: this.exchange.rate('USD', currency) };
  }

  async overview(adminId: string) {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const [total, new7d, new30d, active7d, active30d, premium, events, ai, display, promoCodes] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: ago(7) } } }),
      this.prisma.user.count({ where: { createdAt: { gte: ago(30) } } }),
      this.prisma.user.count({ where: { lastActiveAt: { gte: ago(7) } } }),
      this.prisma.user.count({ where: { lastActiveAt: { gte: ago(30) } } }),
      this.premiumUsers(),
      this.prisma.revenueEvent.findMany({ where: { isSandbox: false, occurredAt: { gte: monthStartUtc(now, -1) } } }),
      this.budget.state(),
      this.display(adminId),
      this.prisma.promoCode.count({ where: { isActive: true } }),
    ]);
    const counts: Record<PremiumKind, number> = { paid: 0, trial: 0, promo: 0, grant: 0, test: 0 };
    const byPlan: Record<string, Record<PremiumKind, number>> = {};
    for (const { sub, kind } of premium.values()) {
      counts[kind] += 1;
      byPlan[sub.plan] ??= { paid: 0, trial: 0, promo: 0, grant: 0, test: 0 };
      byPlan[sub.plan][kind] += 1;
    }
    const thisMonth = this.emptyTotals();
    const lastMonth = this.emptyTotals();
    const currentKey = monthKeyOf(now);
    for (const e of events) this.addTo(monthKeyOf(e.occurredAt) === currentKey ? thisMonth : lastMonth, e);
    const allTime = await this.prisma.revenueEvent.aggregate({ where: { isSandbox: false }, _sum: { amountUsd: true } });
    return {
      generatedAt: now,
      users: { total, new7d, new30d, active7d, active30d },
      premium: {
        /// Toda a gente com um plano pago ativo, seja qual for a origem
        total: premium.size,
        /// Só estes pagaram — os outros não entram na receita
        paying: counts.paid,
        trial: counts.trial,
        promo: counts.promo,
        granted: counts.grant,
        test: counts.test,
        notPaying: premium.size - counts.paid,
        byPlan,
      },
      revenue: {
        currency: 'USD',
        thisMonth: this.rounded(thisMonth),
        lastMonth: this.rounded(lastMonth),
        allTimeNet: round2(Number(allTime._sum.amountUsd ?? 0)),
        mrr: await this.mrr(premium),
      },
      promoCodes: { active: promoCodes },
      ai,
      display,
    };
  }

  /// Receita mensal recorrente (estimativa): o último pagamento de cada
  /// assinatura paga e a renovar, posto ao mês.
  private async mrr(premium: Awaited<ReturnType<AdminService['premiumUsers']>>): Promise<number> {
    const paying = [...premium.values()].filter((p) => p.kind === 'paid' && p.sub.status === 'ACTIVE' && p.sub.autoRenew);
    if (!paying.length) return 0;
    const events = await this.prisma.revenueEvent.findMany({
      where: { isSandbox: false, amountUsd: { gt: 0 }, userId: { in: paying.map((p) => p.sub.userId) } },
      orderBy: { occurredAt: 'desc' },
      select: { userId: true, productId: true, amountUsd: true },
    });
    let total = 0;
    for (const { sub } of paying) {
      const last = events.find((e) => e.userId === sub.userId && e.productId === sub.productId) ?? events.find((e) => e.userId === sub.userId);
      if (!last) continue;
      total += Number(last.amountUsd) / (isYearly(sub.productId, sub.startDate, sub.expirationDate) ? 12 : 1);
    }
    return round2(total);
  }

  /// Receita por mês — só pagamentos reais comunicados pela loja. Códigos
  /// promocionais e ofertas nunca aparecem aqui.
  async revenue(adminId: string, months = 12, includeSandbox = false) {
    const n = Math.min(Math.max(months, 1), 36);
    const now = new Date();
    const from = monthStartUtc(now, -(n - 1));
    const events = await this.prisma.revenueEvent.findMany({
      where: { occurredAt: { gte: from }, ...(includeSandbox ? {} : { isSandbox: false }) },
      orderBy: { occurredAt: 'asc' },
      take: 200_000,
    });
    type MonthRow = Totals & { month: string; newSubscriptions: number; renewals: number; payers: Set<string> };
    const byMonth = new Map<string, MonthRow>();
    for (let i = 0; i < n; i++) {
      const key = monthKeyOf(monthStartUtc(from, i));
      byMonth.set(key, { month: key, ...this.emptyTotals(), newSubscriptions: 0, renewals: 0, payers: new Set() });
    }
    const totals = this.emptyTotals();
    const byPlan = new Map<string, number>();
    const byPlatform = new Map<string, number>();
    const byCurrency = new Map<string, { amount: number; count: number }>();
    for (const e of events) {
      const row = byMonth.get(monthKeyOf(e.occurredAt));
      if (!row) continue;
      this.addTo(row, e);
      this.addTo(totals, e);
      if (e.type === 'INITIAL_PURCHASE') row.newSubscriptions += 1;
      if (e.type === 'RENEWAL') row.renewals += 1;
      if (Number(e.amountUsd) > 0 && e.userId) row.payers.add(e.userId);
      byPlan.set(e.plan ?? '-', (byPlan.get(e.plan ?? '-') ?? 0) + Number(e.amountUsd));
      byPlatform.set(e.platform, (byPlatform.get(e.platform) ?? 0) + Number(e.amountUsd));
      const c = byCurrency.get(e.currency) ?? { amount: 0, count: 0 };
      c.amount += Number(e.amount);
      c.count += 1;
      byCurrency.set(e.currency, c);
    }
    const allTime = await this.prisma.revenueEvent.aggregate({ where: includeSandbox ? {} : { isSandbox: false }, _sum: { amountUsd: true }, _count: { _all: true } });
    const entries = (map: Map<string, number>) => [...map.entries()].map(([key, net]) => ({ key, net: round2(net) })).sort((a, b) => b.net - a.net);
    return {
      currency: 'USD',
      includeSandbox,
      /// Comissão assumida quando a loja não a comunica
      defaultCommission: env().STORE_COMMISSION_DEFAULT,
      months: [...byMonth.values()].map(({ payers, ...row }) => ({ ...this.rounded(row), payers: payers.size })),
      totals: this.rounded(totals),
      allTime: { net: round2(Number(allTime._sum.amountUsd ?? 0)), events: allTime._count._all },
      byPlan: entries(byPlan),
      byPlatform: entries(byPlatform),
      byCurrency: [...byCurrency.entries()].map(([currency, v]) => ({ currency, amount: round2(v.amount), count: v.count })).sort((a, b) => b.count - a.count),
      mrr: await this.mrr(await this.premiumUsers()),
      display: await this.display(adminId),
    };
  }

  /// Os últimos pagamentos e reembolsos (para conferir com a loja).
  async payments(limit = 50, includeSandbox = false) {
    const events = await this.prisma.revenueEvent.findMany({
      where: includeSandbox ? {} : { isSandbox: false },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(events.map((e) => e.userId).filter((x): x is string => !!x))] } },
      select: { id: true, name: true, email: true, username: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return events.map((e) => ({
      id: e.id,
      type: e.type,
      plan: e.plan,
      productId: e.productId,
      platform: e.platform,
      amount: Number(e.amount),
      currency: e.currency,
      amountUsd: Number(e.amountUsd),
      proceedsUsd: round2(this.proceedsOf(e)),
      isSandbox: e.isSandbox,
      occurredAt: e.occurredAt,
      user: e.userId ? (byId.get(e.userId) ?? null) : null,
    }));
  }

  /// Quem tem um plano pago e porquê. `kind` filtra: paid | trial | promo | grant | test.
  async subscribers(query: { kind?: string; q?: string; limit?: number; offset?: number; country?: string; platform?: string; plan?: string; from?: string; to?: string }) {
    const premium = await this.premiumUsers();
    const ids = [...premium.keys()];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, ...(query.country ? { country: query.country.toUpperCase() } : {}) },
      select: { id: true, name: true, username: true, email: true, country: true, createdAt: true, signupPlatform: true },
    });
    const codeIds = [...new Set([...premium.values()].map((p) => p.sub.promoCodeId).filter((x): x is string => !!x))];
    const granterIds = [...new Set([...premium.values()].map((p) => p.sub.grantedById).filter((x): x is string => !!x))];
    const [codes, granters] = await Promise.all([
      codeIds.length ? this.prisma.promoCode.findMany({ where: { id: { in: codeIds } }, select: { id: true, code: true } }) : Promise.resolve([]),
      granterIds.length ? this.prisma.user.findMany({ where: { id: { in: granterIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ]);
    const codeOf = new Map(codes.map((c) => [c.id, c.code]));
    const granterOf = new Map(granters.map((g) => [g.id, g.name]));
    const q = query.q?.trim().toLowerCase();
    let items = users
      .map((user) => {
        const { sub, kind } = premium.get(user.id) as { sub: Subscription; kind: PremiumKind };
        return {
          user,
          plan: sub.plan,
          kind,
          /// Só os "paid" entram no relatório de receita
          countsAsRevenue: kind === 'paid',
          status: sub.status,
          platform: sub.platform,
          productId: sub.productId,
          startDate: sub.startDate,
          expirationDate: sub.expirationDate,
          autoRenew: sub.autoRenew,
          /// SUBSCRIPTION (renova sozinha) | ONE_TIME (paga uma vez, acaba na data)
          billing: sub.kind,
          promoCode: sub.promoCodeId ? (codeOf.get(sub.promoCodeId) ?? null) : null,
          grantedBy: sub.grantedById ? (granterOf.get(sub.grantedById) ?? null) : null,
          note: sub.note,
        };
      })
      .filter((i) => (!query.kind || query.kind === 'all' ? true : query.kind === 'free' ? i.kind !== 'paid' : i.kind === query.kind))
      .filter((i) => (!query.platform || query.platform === 'all' ? true : i.platform === query.platform.toUpperCase()))
      .filter((i) => (!query.plan || query.plan === 'all' ? true : i.plan === query.plan.toUpperCase()))
      .filter((i) => (!query.from ? true : i.startDate >= new Date(query.from)))
      .filter((i) => (!query.to ? true : i.startDate <= new Date(`${query.to}T23:59:59.999Z`)))
      .filter((i) => (!q ? true : [i.user.name, i.user.email, i.user.username].some((v) => v.toLowerCase().includes(q))));
    items = items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.startDate.getTime() - a.startDate.getTime());
    const offset = Math.max(query.offset ?? 0, 0);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    return { total: items.length, items: items.slice(offset, offset + limit) };
  }

  async users(query: { q?: string; limit?: number; offset?: number; country?: string; language?: string; plan?: string; signup?: string; platform?: string; from?: string; to?: string; active?: string }) {
    const q = query.q?.trim();
    const premiumAll = await this.premiumUsers();
    const planIds = (plan: string) => [...premiumAll.entries()].filter(([, p]) => p.sub.plan === plan).map(([id]) => id);
    const where: Prisma.UserWhereInput = {
      ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }, { username: { contains: q.replace(/^@/, ''), mode: 'insensitive' } }] } : {}),
      ...(query.country ? { country: query.country.toUpperCase() } : {}),
      ...(query.language ? { language: query.language.toLowerCase() } : {}),
      ...(query.platform ? { signupPlatform: query.platform.toLowerCase() } : {}),
      // google = entrou com o Google; password = registou-se com email
      ...(query.signup === 'google' ? { googleId: { not: null } } : query.signup === 'password' ? { googleId: null } : {}),
      ...(query.from ? { createdAt: { gte: new Date(query.from) } } : {}),
      ...(query.to ? { createdAt: { lte: new Date(`${query.to}T23:59:59.999Z`) } } : {}),
      ...(query.active === '7d' ? { lastActiveAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } : query.active === '30d' ? { lastActiveAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } : {}),
      ...(query.plan === 'FREE' ? { id: { notIn: [...premiumAll.keys()] } } : query.plan && query.plan !== 'all' ? { id: { in: planIds(query.plan.toUpperCase()) } } : {}),
    };
    const offset = Math.max(query.offset ?? 0, 0);
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const [total, users, premium] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: { id: true, name: true, username: true, email: true, country: true, currency: true, language: true, role: true, adminAreas: true, aiCredits: true, birthDate: true, createdAt: true, lastActiveAt: true, googleId: true, signupPlatform: true, signupCampaign: true },
      }),
      Promise.resolve(premiumAll),
    ]);
    return {
      total,
      items: users.map((u) => {
        const p = premium.get(u.id);
        const { googleId, ...rest } = u;
        return { ...rest, birthDate: u.birthDate ? u.birthDate.toISOString().slice(0, 10) : null, signup: googleId ? 'google' : 'password', isAdmin: isAdminUser(u), adminAreas: adminAreasOf(u), plan: p?.sub.plan ?? 'FREE', kind: p?.kind ?? null, expirationDate: p?.sub.expirationDate ?? null };
      }),
    };
  }

  /// De onde vêm as pessoas: por país, com registos recentes, ativos, planos
  /// pagos (e quem paga), e como se registaram (Google ou email, telemóvel ou web).
  async countries() {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const [users, premium] = await Promise.all([
      this.prisma.user.findMany({ select: { id: true, country: true, language: true, createdAt: true, lastActiveAt: true, googleId: true, signupPlatform: true, signupCampaign: true } }),
      this.premiumUsers(),
    ]);
    type Row = { country: string; users: number; new30d: number; active30d: number; premium: number; paying: number; byPlan: Record<string, number>; google: number; password: number; platforms: Record<string, number>; languages: Record<string, number> };
    const rows = new Map<string, Row>();
    const bump = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
    const campaigns: Record<string, number> = {};
    for (const u of users) {
      const row = rows.get(u.country) ?? { country: u.country, users: 0, new30d: 0, active30d: 0, premium: 0, paying: 0, byPlan: {}, google: 0, password: 0, platforms: {}, languages: {} };
      row.users += 1;
      if (u.createdAt >= ago(30)) row.new30d += 1;
      if (u.lastActiveAt && u.lastActiveAt >= ago(30)) row.active30d += 1;
      if (u.googleId) row.google += 1;
      else row.password += 1;
      bump(row.platforms, u.signupPlatform ?? 'unknown');
      bump(row.languages, u.language);
      if (u.signupCampaign) bump(campaigns, u.signupCampaign);
      const p = premium.get(u.id);
      if (p) {
        row.premium += 1;
        if (p.kind === 'paid') row.paying += 1;
        bump(row.byPlan, p.sub.plan);
      }
      rows.set(u.country, row);
    }
    return {
      total: users.length,
      countries: [...rows.values()].sort((a, b) => b.users - a.users),
      campaigns: Object.entries(campaigns).map(([campaign, count]) => ({ campaign, count })).sort((a, b) => b.count - a.count),
    };
  }

  /// Dá um plano a alguém sem pagar (fica como "oferta" — fora da receita).
  async grant(adminId: string, userId: string, input: { plan: string; days?: number | null; note?: string | null }) {
    return this.subscriptions.grant(adminId, userId, input.plan, input.days ?? null, input.note);
  }

  /// Tira o plano não pago (oferta, código, testes). O que foi pago na loja fica.
  async revoke(userId: string) {
    if (!(await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw ApiException.notFound('USER_NOT_FOUND');
    return this.subscriptions.revokeFree(userId);
  }

  /// areas vazio = acede a todas as áreas da administração.
  async setRole(adminId: string, userId: string, role: 'USER' | 'ADMIN', areas: string[] = []) {
    // Para ninguém ficar trancado de fora por engano.
    if (userId === adminId && (role !== 'ADMIN' || areas.length > 0)) throw ApiException.badRequest('INVALID_REQUEST');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw ApiException.notFound('USER_NOT_FOUND');
    const updated = await this.prisma.user.update({ where: { id: userId }, data: { role, adminAreas: role === 'ADMIN' ? [...new Set(areas)] : [] }, select: { id: true, role: true, email: true, adminAreas: true } });
    return { id: updated.id, role: updated.role, isAdmin: isAdminUser(updated), adminAreas: adminAreasOf(updated) };
  }

  /// Uso e custo estimado da IA este mês (e o teto global).
  async ai() {
    const since = this.budget.monthStart();
    const [state, byKind, top, daily] = await Promise.all([
      this.budget.state(),
      this.prisma.aiUsage.groupBy({ by: ['kind'], where: { createdAt: { gte: since } }, _count: { _all: true }, _sum: { costUsd: true, inputTokens: true, outputTokens: true } }),
      this.prisma.aiUsage.groupBy({ by: ['userId'], where: { createdAt: { gte: since } }, _count: { _all: true }, _sum: { costUsd: true }, orderBy: { _sum: { costUsd: 'desc' } }, take: 10 }),
      this.prisma.$queryRaw<Array<{ day: string; count: bigint; cost: unknown }>>`
        SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS count, COALESCE(SUM("costUsd"), 0) AS cost
        FROM "AiUsage" WHERE "createdAt" >= ${new Date(Date.now() - 30 * 86_400_000)}
        GROUP BY 1 ORDER BY 1`,
    ]);
    const users = await this.prisma.user.findMany({ where: { id: { in: top.map((t) => t.userId) } }, select: { id: true, name: true, email: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    const premium = await this.premiumUsers();
    const cost = (value: unknown) => Math.round(Number(value ?? 0) * 10000) / 10000;
    return {
      ...state,
      model: env().AI_MODEL,
      modelAdvanced: env().AI_MODEL_ADVANCED,
      configured: !!env().ANTHROPIC_API_KEY,
      requests: byKind.reduce((acc, k) => acc + k._count._all, 0),
      byKind: byKind.map((k) => ({ kind: k.kind, count: k._count._all, costUsd: cost(k._sum.costUsd), inputTokens: k._sum.inputTokens ?? 0, outputTokens: k._sum.outputTokens ?? 0 })).sort((a, b) => b.costUsd - a.costUsd),
      topUsers: top.map((t) => ({ user: byId.get(t.userId) ?? null, count: t._count._all, costUsd: cost(t._sum.costUsd), plan: premium.get(t.userId)?.sub.plan ?? 'FREE' })),
      daily: daily.map((d) => ({ day: d.day, count: Number(d.count), costUsd: cost(d.cost) })),
    };
  }
}
