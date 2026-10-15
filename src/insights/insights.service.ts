import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { RecurringService } from '../recurring/recurring.service';
import { ApiException } from '../common/errors/api.exception';
import { FEATURES } from '../billing/plans.catalog';
import { addDays, addMonths, daysBetween, financialMonth, fromDbDate, maxDate, minDate, Period, todayIn, toDbDate } from '../common/utils/dates';
import { num, round2 } from '../common/utils/money';
import { niceRound } from '../simulator/simulator.math';
import { Category } from '../generated/prisma/client';

/// Categorias em que não faz sentido sugerir "gasta menos".
const ESSENTIAL = new Set(['home', 'health', 'education', 'bills', 'taxes']);
/// Quantas observações vê quem está no plano grátis.
const FREE_ITEMS = 3;

export interface WasteItem {
  id: string;
  /// category_increase | small_frequent | subscriptions | savings_opportunity | uncategorized | category_decrease
  type: string;
  /// warning | neutral | positive
  tone: string;
  params: Record<string, unknown>;
}

interface Row {
  date: string;
  amount: number;
  categoryId: string | null;
  label: string | null;
  /// Despesa de um plano (viagem, negócio…): é planeada, não é "desperdício"
  planned: boolean;
}

const categoryRef = (c: Category | undefined) => (c ? { categoryId: c.id, key: c.key, name: c.name, icon: c.icon, color: c.color } : { categoryId: null, key: null, name: null, icon: null, color: null });

/// Onde o dinheiro se está a perder — contas simples sobre os movimentos
/// (sem IA): categorias a subir, pequenas despesas que se repetem,
/// subscrições e quanto se poupava com um pequeno corte.
@Injectable()
export class InsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exchange: ExchangeService,
    private readonly entitlements: EntitlementsService,
    private readonly recurring: RecurringService,
  ) {}

  async waste(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true, timezone: true, monthStartDay: true } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    const main = user.currency;
    const today = todayIn(user.timezone);
    const period = financialMonth(today, user.monthStartDay);
    const elapsedDays = daysBetween(period.start, today) + 1;
    const previous: Period[] = [];
    let cursor = period;
    for (let i = 0; i < 3; i++) {
      cursor = financialMonth(addDays(cursor.start, -1), user.monthStartDay);
      previous.push(cursor);
    }

    const [transactions, categories, fixed, advanced] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { userId, type: 'EXPENSE', excludeFromReports: false, date: { gte: toDbDate(previous[2].start), lte: toDbDate(today) } },
        select: { date: true, amount: true, currency: true, categoryId: true, description: true, merchant: true, planId: true },
        take: 20000,
      }),
      this.prisma.category.findMany({ where: { userId } }),
      this.recurring.list(userId),
      this.entitlements.hasFeature(userId, FEATURES.insightsAdvanced),
    ]);
    const byId = new Map(categories.map((c) => [c.id, c]));
    /// A categoria-mãe (as subcategorias contam para ela).
    const top = (id: string | null) => {
      if (!id) return null;
      const c = byId.get(id);
      if (!c) return null;
      return c.parentId && byId.has(c.parentId) ? c.parentId : c.id;
    };
    const rows: Row[] = transactions.map((t) => ({
      date: fromDbDate(t.date),
      amount: this.exchange.convert(num(t.amount), t.currency, main) ?? 0,
      categoryId: top(t.categoryId),
      label: (t.merchant ?? t.description ?? '').trim() || null,
      planned: t.planId !== null,
    }));

    const inRange = (r: Row, from: string, to: string) => r.date >= from && r.date <= to;
    const sumBy = (list: Row[]) => {
      const map = new Map<string, number>();
      for (const r of list) map.set(r.categoryId ?? '', (map.get(r.categoryId ?? '') ?? 0) + r.amount);
      return map;
    };
    const current = rows.filter((r) => inRange(r, period.start, today));
    // Para "estás a gastar mais do que o costume" não contam as despesas de planos.
    const currentBy = sumBy(current.filter((r) => !r.planned));
    const currentTotal = current.reduce((acc, r) => acc + r.amount, 0);

    // Meses anteriores com movimentos (os de antes de a pessoa usar a app não
    // contam). A "janela" de cada um vai até ao mesmo dia do mês que hoje.
    const months = previous
      .map((p, i) => {
        const all = rows.filter((r) => inRange(r, p.start, p.end));
        const windowEnd = maxDate(p.start, minDate(p.end, addMonths(today, -(i + 1))));
        const everyday = all.filter((r) => !r.planned);
        return { total: all.reduce((acc, r) => acc + r.amount, 0), full: sumBy(everyday), window: sumBy(everyday.filter((r) => r.date <= windowEnd)) };
      })
      .filter((m) => m.total > 0);
    const n = months.length;
    const monthlyTotal = n ? months.reduce((acc, m) => acc + m.total, 0) / n : 0;
    const average = (key: string, which: 'full' | 'window') => (n ? months.reduce((acc, m) => acc + (m[which].get(key) ?? 0), 0) / n : 0);

    const items: WasteItem[] = [];

    // 1) Categorias em que se está a gastar mais do que o costume (mesmos dias do mês).
    const increases: Array<{ key: string; current: number; reference: number; delta: number; basis: 'same_days' | 'whole_month' }> = [];
    const decreases: Array<{ key: string; current: number; reference: number; delta: number }> = [];
    if (n && elapsedDays >= 5) {
      const minDelta = Math.max(monthlyTotal * 0.02, 0.01);
      for (const [key, value] of currentBy) {
        if (!key) continue;
        const sameDays = average(key, 'window');
        const wholeMonth = average(key, 'full');
        if (sameDays >= monthlyTotal * 0.03) {
          // Comparação justa: o que se costuma ter gasto até este dia do mês.
          if (value >= sameDays * 1.2 && value - sameDays >= minDelta) increases.push({ key, current: value, reference: sameDays, delta: value - sameDays, basis: 'same_days' });
        } else if (wholeMonth > 0 && value >= wholeMonth * 1.2 && value - wholeMonth >= minDelta) {
          // Categoria pequena ou irregular: só conta quando já passou um mês inteiro normal.
          increases.push({ key, current: value, reference: wholeMonth, delta: value - wholeMonth, basis: 'whole_month' });
        }
      }
      if (elapsedDays >= 10) {
        for (const c of categories) {
          if (c.parentId) continue;
          const reference = average(c.id, 'window');
          const value = currentBy.get(c.id) ?? 0;
          if (reference >= monthlyTotal * 0.03 && value <= reference * 0.8) decreases.push({ key: c.id, current: value, reference, delta: reference - value });
        }
      }
    }
    increases.sort((a, b) => b.delta - a.delta);
    decreases.sort((a, b) => b.delta - a.delta);
    for (const inc of increases.slice(0, 3)) {
      items.push({
        id: `increase:${inc.key}`,
        type: 'category_increase',
        tone: 'warning',
        params: {
          ...categoryRef(byId.get(inc.key)),
          percent: Math.round(((inc.current - inc.reference) / inc.reference) * 100),
          current: round2(inc.current),
          usual: round2(inc.reference),
          difference: round2(inc.delta),
          /// same_days = contra o que costuma estar gasto até este dia ·
          /// whole_month = já passou o que costuma gastar num mês inteiro
          basis: inc.basis,
        },
      });
    }

    // 2) Pequenas despesas que se repetem (últimos 30 dias).
    const since = addDays(today, -29);
    const last30 = rows.filter((r) => inRange(r, since, today));
    const last30Total = last30.reduce((acc, r) => acc + r.amount, 0);
    const smallMax = last30Total * 0.02;
    const groups = new Map<string, { label: string | null; categoryId: string | null; count: number; total: number }>();
    for (const r of last30) {
      if (r.amount <= 0 || r.amount > smallMax) continue;
      const key = r.label ? `l:${r.label.toLowerCase()}` : `c:${r.categoryId ?? ''}`;
      const g = groups.get(key) ?? { label: r.label, categoryId: r.categoryId, count: 0, total: 0 };
      g.count += 1;
      g.total += r.amount;
      groups.set(key, g);
    }
    const frequent = [...groups.values()].filter((g) => g.count >= (g.label ? 4 : 8)).sort((a, b) => b.total - a.total);
    for (const g of frequent.slice(0, 2)) {
      items.push({
        id: `small:${g.label ?? g.categoryId ?? 'none'}`,
        type: 'small_frequent',
        tone: 'neutral',
        params: {
          label: g.label,
          ...categoryRef(g.categoryId ? byId.get(g.categoryId) : undefined),
          count: g.count,
          total: round2(g.total),
          average: round2(g.total / g.count),
          yearly: round2(g.total * 12),
        },
      });
    }

    // 3) Subscrições.
    const subs = fixed.items.filter((r) => r.isActive && r.type === 'EXPENSE' && r.kind === 'SUBSCRIPTION');
    const subsMonthly = round2(subs.reduce((acc, r) => acc + (this.exchange.convert(r.monthlyEquivalent, r.currency, main) ?? 0), 0));
    const reference = monthlyTotal || currentTotal;
    if (subs.length) {
      items.push({
        id: 'subscriptions',
        type: 'subscriptions',
        tone: reference > 0 && subsMonthly >= reference * 0.1 ? 'warning' : 'neutral',
        params: { count: subs.length, monthly: subsMonthly, yearly: round2(subsMonthly * 12), percent: reference > 0 ? Math.round((subsMonthly / reference) * 100) : null },
      });
    }

    // 4) "Se cortar X por mês nesta categoria, poupa Y por ano."
    let potentialMonthly = 0;
    const candidates = categories
      .filter((c) => !c.parentId && c.type === 'EXPENSE' && !(c.key && ESSENTIAL.has(c.key)))
      .map((c) => ({ c, monthly: n ? average(c.id, 'full') : (currentBy.get(c.id) ?? 0) }))
      .filter((x) => x.monthly > 0 && x.monthly >= reference * 0.05)
      .sort((a, b) => b.monthly - a.monthly);
    for (const { c, monthly } of candidates.slice(0, 2)) {
      const cut = niceRound(monthly * (c.key === 'food' ? 0.1 : 0.15));
      if (cut <= 0) continue;
      potentialMonthly += cut;
      items.push({
        id: `cut:${c.id}`,
        type: 'savings_opportunity',
        tone: 'positive',
        params: { ...categoryRef(c), monthlyAverage: round2(monthly), cut, yearly: round2(cut * 12) },
      });
    }

    // 5) Muitas despesas sem categoria → as análises ficam piores.
    const uncategorized = current.filter((r) => !r.categoryId);
    const uncategorizedTotal = uncategorized.reduce((acc, r) => acc + r.amount, 0);
    if (uncategorized.length >= 5 && currentTotal > 0 && uncategorizedTotal >= currentTotal * 0.1) {
      items.push({ id: 'uncategorized', type: 'uncategorized', tone: 'neutral', params: { count: uncategorized.length, amount: round2(uncategorizedTotal) } });
    }

    // 6) Uma boa notícia: onde se está a gastar menos do que o costume.
    for (const dec of decreases.slice(0, 1)) {
      items.push({
        id: `decrease:${dec.key}`,
        type: 'category_decrease',
        tone: 'positive',
        params: {
          ...categoryRef(byId.get(dec.key)),
          percent: Math.round(((dec.reference - dec.current) / dec.reference) * 100),
          current: round2(dec.current),
          usual: round2(dec.reference),
          difference: round2(dec.delta),
        },
      });
    }

    const visible = advanced ? items : items.slice(0, FREE_ITEMS);
    return {
      currency: main,
      today,
      period: { key: period.key, start: period.start, end: period.end, elapsedDays },
      /// Em quantos meses anteriores se baseia a comparação (0 = ainda sem histórico)
      basedOnMonths: n,
      spentThisMonth: round2(currentTotal),
      usualMonthly: round2(monthlyTotal),
      advanced,
      total: items.length,
      /// Observações que só aparecem no Premium
      locked: items.length - visible.length,
      items: visible,
      subscriptions: {
        count: subs.length,
        monthly: subsMonthly,
        yearly: round2(subsMonthly * 12),
        items: subs.map((r) => ({ ruleId: r.id, description: r.description, amount: r.amount, currency: r.currency, frequency: r.frequency, interval: r.interval, monthlyEquivalent: r.monthlyEquivalent, nextDate: r.nextDate })),
      },
      /// Quanto se poupava com os cortes sugeridos
      potential: { monthly: round2(potentialMonthly), yearly: round2(potentialMonthly * 12) },
    };
  }
}
