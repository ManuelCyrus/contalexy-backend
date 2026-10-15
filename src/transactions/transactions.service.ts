import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ExchangeService } from '../exchange/exchange.service';
import { RulesService } from '../rules/rules.service';
import { BudgetsService } from '../budgets/budgets.service';
import { MonthlyPlansService } from '../monthly-plans/monthly-plans.service';
import { DailyLimitService } from '../daily-limit/daily-limit.service';
import { AttachmentsService, toAttachmentDto } from '../storage/attachments.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { LocksService } from '../billing/locks.service';
import { ApiException } from '../common/errors/api.exception';
import { categoryName, Language, resolveLanguage } from '../common/i18n/messages';
import { addDays, daysBetween, fromDbDate, todayIn, toDbDate } from '../common/utils/dates';
import { money, num, numOrNull, round2 } from '../common/utils/money';
import { FEATURES } from '../billing/plans.catalog';
import { Prisma, RecurringRule, TransactionType } from '../generated/prisma/client';
import { CreateTransactionDto, ReceiptItem, TransactionFilters, UpdateTransactionDto } from './transactions.dto';
import { buildTransactionWhere, orderFor } from './transaction-filters';
import { toCategoryDto } from '../categories/categories.service';

const accountSelect = { id: true, name: true, color: true, icon: true, type: true, currency: true } as const;

export const txInclude = {
  account: { select: accountSelect },
  toAccount: { select: accountSelect },
  category: true,
  attachments: { select: { id: true, kind: true, mimeType: true, size: true, createdAt: true } },
  plan: { select: { id: true, name: true } },
} satisfies Prisma.TransactionInclude;

export type TxWithRelations = Prisma.TransactionGetPayload<{ include: typeof txInclude }>;

/// Os produtos guardados com um movimento (JSON) → lista com forma certa.
export function receiptItems(value: Prisma.JsonValue | null | undefined): Array<{ name: string; quantity: number | null; price: number | null }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ name: string; quantity: number | null; price: number | null }> = [];
  for (const v of value) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.name !== 'string') continue;
    out.push({ name: v.name, quantity: typeof v.quantity === 'number' ? v.quantity : null, price: typeof v.price === 'number' ? v.price : null });
  }
  return out;
}

/// Produtos de uma fatura → o que se grava: a lista e o texto para a pesquisa.
/// undefined = não mexer; null ou vazio = apagar.
export function itemsData(items: ReceiptItem[] | null | undefined) {
  if (items === undefined) return {};
  if (items === null || items.length === 0) return { items: Prisma.DbNull, itemsText: null };
  const clean = items.map((i) => ({ name: i.name, quantity: i.quantity ?? null, price: i.price ?? null }));
  return { items: clean, itemsText: clean.map((i) => i.name).join(' · ').slice(0, 2000) };
}

export function toTransactionDto(t: TxWithRelations) {
  return {
    id: t.id,
    type: t.type,
    amount: num(t.amount),
    currency: t.currency,
    date: fromDbDate(t.date),
    description: t.description,
    merchant: t.merchant,
    note: t.note,
    tags: t.tags,
    account: t.account,
    toAccount: t.toAccount,
    toAmount: numOrNull(t.toAmount),
    category: t.category ? toCategoryDto(t.category) : null,
    locationName: t.locationName,
    latitude: t.latitude,
    longitude: t.longitude,
    attachments: t.attachments.map(toAttachmentDto),
    /// Produtos de uma fatura lida (vazio = nenhum)
    items: receiptItems(t.items),
    recurringRuleId: t.recurringRuleId,
    plan: t.plan,
    spaceExpenseId: t.spaceExpenseId,
    /// Movimento criado por um empréstimo (ver /loans/:id)
    loanId: t.loanId,
    isAdjustment: t.isAdjustment,
    excludeFromReports: t.excludeFromReports,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

const CSV_HEADERS: Record<Language, string[]> = {
  pt: ['Data', 'Tipo', 'Valor', 'Moeda', 'Conta', 'Conta destino', 'Categoria', 'Descrição', 'Comerciante', 'Etiquetas', 'Nota'],
  en: ['Date', 'Type', 'Amount', 'Currency', 'Account', 'To account', 'Category', 'Description', 'Merchant', 'Tags', 'Note'],
  fr: ['Date', 'Type', 'Montant', 'Devise', 'Compte', 'Compte de destination', 'Catégorie', 'Description', 'Commerçant', 'Étiquettes', 'Note'],
  de: ['Datum', 'Typ', 'Betrag', 'Währung', 'Konto', 'Zielkonto', 'Kategorie', 'Beschreibung', 'Händler', 'Tags', 'Notiz'],
};

const CSV_TYPES: Record<Language, Record<TransactionType, string>> = {
  pt: { INCOME: 'Receita', EXPENSE: 'Despesa', TRANSFER: 'Transferência' },
  en: { INCOME: 'Income', EXPENSE: 'Expense', TRANSFER: 'Transfer' },
  fr: { INCOME: 'Revenu', EXPENSE: 'Dépense', TRANSFER: 'Virement' },
  de: { INCOME: 'Einnahme', EXPENSE: 'Ausgabe', TRANSFER: 'Überweisung' },
};

const ADJUSTMENT_LABEL: Record<Language, string> = {
  pt: 'Ajuste de saldo',
  en: 'Balance adjustment',
  fr: 'Ajustement du solde',
  de: 'Saldoanpassung',
};

interface WriteInput {
  type: TransactionType;
  amount: number;
  accountId: string;
  toAccountId?: string | null;
  toAmount?: number | null;
  categoryId?: string | null;
  date: string;
  description?: string | null;
  merchant?: string | null;
  note?: string | null;
  tags?: string[];
  locationName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  planId?: string | null;
  excludeFromReports?: boolean;
}

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly exchange: ExchangeService,
    private readonly rules: RulesService,
    private readonly budgets: BudgetsService,
    private readonly monthlyPlans: MonthlyPlansService,
    private readonly attachments: AttachmentsService,
    private readonly entitlements: EntitlementsService,
    private readonly locks: LocksService,
    private readonly dailyLimit: DailyLimitService,
  ) {}

  private async settings(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { currency: true, language: true, country: true, timezone: true, monthStartDay: true, weekStartsOn: true },
    });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    return user;
  }

  /// Uma categoria-mãe nos filtros inclui as subcategorias.
  async expandCategories(userId: string, ids?: string[]): Promise<string[] | undefined> {
    if (!ids?.length) return ids;
    const real = ids.filter((id) => id !== 'none');
    if (!real.length) return ids;
    const children = await this.prisma.category.findMany({ where: { userId, parentId: { in: real } }, select: { id: true } });
    return Array.from(new Set([...ids, ...children.map((c) => c.id)]));
  }

  async list(userId: string, filters: TransactionFilters) {
    const f = { ...filters, categoryIds: await this.expandCategories(userId, filters.categoryIds) };
    const rows = await this.prisma.transaction.findMany({
      where: buildTransactionWhere(userId, f),
      include: txInclude,
      orderBy: orderFor(f.sort),
      skip: f.offset,
      take: f.limit + 1,
    });
    const items = rows.slice(0, f.limit).map(toTransactionDto);
    return { data: items, meta: { nextOffset: rows.length > f.limit ? f.offset + f.limit : null } };
  }

  /// Só o tipo (para quem ajuda a gerir sem ver as receitas).
  async typeOf(userId: string, id: string) {
    const t = await this.prisma.transaction.findFirst({ where: { id, userId }, select: { type: true } });
    return t?.type ?? null;
  }

  async get(userId: string, id: string) {
    const t = await this.prisma.transaction.findFirst({ where: { id, userId }, include: txInclude });
    if (!t) throw ApiException.notFound('TRANSACTION_NOT_FOUND');
    return toTransactionDto(t);
  }

  /// Valida tudo (contas, categoria, plano, moedas) e devolve os dados a gravar.
  private async resolve(userId: string, input: WriteInput, opts: { allowArchived?: boolean; samePlan?: boolean } = {}) {
    const account = await this.prisma.account.findFirst({ where: { id: input.accountId, userId } });
    if (!account) throw ApiException.notFound('ACCOUNT_NOT_FOUND');
    if (account.archivedAt && !opts.allowArchived) throw ApiException.badRequest('ACCOUNT_ARCHIVED');

    let toAccountId: string | null = null;
    let toAmount: Prisma.Decimal | null = null;
    let categoryId: string | null = input.categoryId ?? null;
    let tags = Array.from(new Set((input.tags ?? []).map((t) => t.toLowerCase())));

    if (input.type === 'TRANSFER') {
      if (!input.toAccountId) throw ApiException.badRequest('TRANSFER_TARGET_REQUIRED');
      if (input.toAccountId === input.accountId) throw ApiException.badRequest('SAME_ACCOUNT_TRANSFER');
      const target = await this.prisma.account.findFirst({ where: { id: input.toAccountId, userId } });
      if (!target) throw ApiException.notFound('ACCOUNT_NOT_FOUND');
      if (target.archivedAt && !opts.allowArchived) throw ApiException.badRequest('ACCOUNT_ARCHIVED');
      toAccountId = target.id;
      if (target.currency === account.currency) {
        toAmount = money(input.amount);
      } else if (input.toAmount) {
        toAmount = money(input.toAmount);
      } else {
        const converted = this.exchange.convert(input.amount, account.currency, target.currency);
        if (converted === null) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'toAmount', message: 'required' }]);
        toAmount = money(converted);
      }
      categoryId = null;
    } else {
      if (categoryId) {
        const category = await this.prisma.category.findFirst({ where: { id: categoryId, userId }, select: { type: true } });
        if (!category) throw ApiException.notFound('CATEGORY_NOT_FOUND');
        if (category.type !== input.type) throw ApiException.badRequest('CATEGORY_TYPE_MISMATCH');
      } else if (input.categoryId === undefined) {
        // Sem categoria escolhida: as regras automáticas (Premium) decidem.
        const rule = await this.rules.match(userId, { description: input.description, merchant: input.merchant });
        if (rule) {
          const category = await this.prisma.category.findFirst({ where: { id: rule.categoryId, userId }, select: { type: true } });
          if (category?.type === input.type) {
            categoryId = rule.categoryId;
            tags = Array.from(new Set([...tags, ...rule.addTags]));
          }
        }
      }
    }

    if (input.planId) {
      const plan = await this.prisma.plan.findFirst({ where: { id: input.planId, userId }, select: { id: true } });
      if (!plan) throw ApiException.notFound('PLAN_NOT_FOUND');
      // Ligar um movimento a um plano fechado seria usá-lo sem o plano pago.
      // (Um movimento que já lá estava ligado continua a poder ser corrigido.)
      if (!opts.samePlan) await this.locks.assertUnlocked(userId, 'plans', plan.id);
    }

    return {
      type: input.type,
      amount: money(input.amount),
      currency: account.currency,
      accountId: account.id,
      toAccountId,
      toAmount,
      categoryId,
      date: toDbDate(input.date),
      description: input.description?.trim() || null,
      merchant: input.merchant?.trim() || null,
      note: input.note?.trim() || null,
      tags,
      locationName: input.locationName ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      planId: input.planId ?? null,
      excludeFromReports: input.excludeFromReports ?? false,
    };
  }

  async create(userId: string, dto: CreateTransactionDto, extra: { recurringRuleId?: string; spaceExpenseId?: string; allowArchived?: boolean } = {}) {
    const data = await this.resolve(userId, dto, { allowArchived: extra.allowArchived });
    const created = await this.prisma.transaction.create({
      data: { ...data, ...itemsData(dto.items), userId, recurringRuleId: extra.recurringRuleId ?? null, spaceExpenseId: extra.spaceExpenseId ?? null },
    });
    if (dto.attachmentIds?.length) await this.attachments.linkToTransaction(userId, created.id, dto.attachmentIds);
    if (created.type === 'EXPENSE') this.afterExpense(userId, fromDbDate(created.date));
    return this.get(userId, created.id);
  }

  private afterExpense(userId: string, date: string) {
    this.budgets.checkAlerts(userId, date).catch((err) => this.logger.warn(`Alertas de orçamento: ${(err as Error).message}`));
    this.monthlyPlans.checkAlerts(userId, date).catch((err) => this.logger.warn(`Alertas do plano do mês: ${(err as Error).message}`));
    this.dailyLimit.checkAlerts(userId, date).catch((err) => this.logger.warn(`Limite diário: ${(err as Error).message}`));
  }

  async update(userId: string, id: string, dto: UpdateTransactionDto) {
    const existing = await this.prisma.transaction.findFirst({ where: { id, userId } });
    if (!existing) throw ApiException.notFound('TRANSACTION_NOT_FOUND');
    const merged: WriteInput = {
      type: dto.type ?? existing.type,
      amount: dto.amount ?? num(existing.amount),
      accountId: dto.accountId ?? existing.accountId,
      toAccountId: dto.toAccountId !== undefined ? dto.toAccountId : existing.toAccountId,
      toAmount: dto.toAmount !== undefined ? dto.toAmount : dto.amount !== undefined || dto.accountId !== undefined || dto.toAccountId !== undefined ? null : numOrNull(existing.toAmount),
      // Mantém a categoria se não vier nenhuma (sem voltar a correr as regras).
      categoryId: dto.categoryId !== undefined ? dto.categoryId : existing.categoryId,
      date: dto.date ?? fromDbDate(existing.date),
      description: dto.description !== undefined ? dto.description : existing.description,
      merchant: dto.merchant !== undefined ? dto.merchant : existing.merchant,
      note: dto.note !== undefined ? dto.note : existing.note,
      tags: dto.tags ?? existing.tags,
      locationName: dto.locationName !== undefined ? dto.locationName : existing.locationName,
      latitude: dto.latitude !== undefined ? dto.latitude : existing.latitude,
      longitude: dto.longitude !== undefined ? dto.longitude : existing.longitude,
      planId: dto.planId !== undefined ? dto.planId : existing.planId,
      excludeFromReports: dto.excludeFromReports ?? existing.excludeFromReports,
    };
    const data = await this.resolve(userId, merged, { allowArchived: true, samePlan: (merged.planId ?? null) === existing.planId });
    await this.prisma.transaction.update({ where: { id }, data: { ...data, ...itemsData(dto.items) } });
    if (dto.attachmentIds?.length) await this.attachments.linkToTransaction(userId, id, dto.attachmentIds);
    if (data.type === 'EXPENSE') this.afterExpense(userId, fromDbDate(data.date));
    return this.get(userId, id);
  }

  async remove(userId: string, id: string) {
    const existing = await this.prisma.transaction.findFirst({ where: { id, userId }, include: { attachments: true } });
    if (!existing) throw ApiException.notFound('TRANSACTION_NOT_FOUND');
    await this.prisma.transaction.delete({ where: { id } });
    // Os recibos deste movimento vão com ele.
    for (const a of existing.attachments) await this.attachments.remove(userId, a.id).catch(() => undefined);
    return { deleted: true };
  }

  async duplicate(userId: string, id: string, date?: string) {
    const t = await this.prisma.transaction.findFirst({ where: { id, userId } });
    if (!t) throw ApiException.notFound('TRANSACTION_NOT_FOUND');
    const s = await this.settings(userId);
    return this.create(userId, {
      type: t.type,
      amount: num(t.amount),
      accountId: t.accountId,
      toAccountId: t.toAccountId,
      toAmount: numOrNull(t.toAmount),
      categoryId: t.categoryId,
      date: date ?? todayIn(s.timezone),
      description: t.description,
      merchant: t.merchant,
      note: t.note,
      tags: t.tags,
      planId: t.planId,
    });
  }

  /// Totais do que está filtrado: receitas, despesas, por categoria, por dia.
  async summary(userId: string, filters: Partial<TransactionFilters> & { excludeCategoryIds?: string[] }) {
    const s = await this.settings(userId);
    const main = s.currency;
    const f = { ...filters, categoryIds: await this.expandCategories(userId, filters.categoryIds) };
    const base = buildTransactionWhere(userId, f);
    const where: Prisma.TransactionWhereInput = { AND: [base, { excludeFromReports: false }] };

    const [byType, byCategory, largest] = await Promise.all([
      this.prisma.transaction.groupBy({ by: ['type', 'currency'], where, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.transaction.groupBy({
        by: ['categoryId', 'type', 'currency'],
        where: { AND: [where, { type: { in: ['INCOME', 'EXPENSE'] } }] },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.transaction.findFirst({ where: { AND: [where, { type: 'EXPENSE' }] }, orderBy: { amount: 'desc' }, include: txInclude }),
    ]);

    const unconverted = new Set<string>();
    const conv = (amount: Prisma.Decimal | null, currency: string) => {
      const value = num(amount);
      const c = this.exchange.convert(value, currency, main);
      if (c === null) {
        unconverted.add(currency);
        return 0;
      }
      return c;
    };

    let income = 0;
    let expense = 0;
    let transfers = 0;
    let count = 0;
    for (const row of byType) {
      count += row._count._all;
      const value = conv(row._sum.amount, row.currency);
      if (row.type === 'INCOME') income += value;
      else if (row.type === 'EXPENSE') expense += value;
      else transfers += value;
    }

    const categoryIds = Array.from(new Set(byCategory.map((r) => r.categoryId).filter((x): x is string => !!x)));
    const categories = await this.prisma.category.findMany({ where: { id: { in: categoryIds } } });
    const catMap = new Map(categories.map((c) => [c.id, c]));
    const grouped = new Map<string, { type: TransactionType; categoryId: string | null; amount: number; count: number }>();
    for (const row of byCategory) {
      const key = `${row.type}:${row.categoryId ?? 'none'}`;
      const current = grouped.get(key) ?? { type: row.type, categoryId: row.categoryId, amount: 0, count: 0 };
      current.amount += conv(row._sum.amount, row.currency);
      current.count += row._count._all;
      grouped.set(key, current);
    }
    const breakdown = (type: TransactionType, total: number) =>
      [...grouped.values()]
        .filter((g) => g.type === type)
        .sort((a, b) => b.amount - a.amount)
        .map((g) => {
          const c = g.categoryId ? catMap.get(g.categoryId) : null;
          return {
            categoryId: g.categoryId,
            category: c ? toCategoryDto(c) : null,
            amount: round2(g.amount),
            count: g.count,
            percent: total > 0 ? round2((g.amount / total) * 100) : 0,
          };
        });

    // Por dia (só para intervalos até ~3 meses — dá um gráfico legível).
    let byDay: Array<{ date: string; income: number; expense: number }> | null = null;
    if (f.from && f.to && daysBetween(f.from, f.to) <= 92 && daysBetween(f.from, f.to) >= 0) {
      const rows = await this.prisma.transaction.groupBy({
        by: ['date', 'type', 'currency'],
        where: { AND: [where, { type: { in: ['INCOME', 'EXPENSE'] } }] },
        _sum: { amount: true },
      });
      const days = new Map<string, { income: number; expense: number }>();
      for (let d = f.from; d <= f.to; d = addDays(d, 1)) days.set(d, { income: 0, expense: 0 });
      for (const row of rows) {
        const key = fromDbDate(row.date);
        const day = days.get(key);
        if (!day) continue;
        const value = conv(row._sum.amount, row.currency);
        if (row.type === 'INCOME') day.income += value;
        else day.expense += value;
      }
      byDay = [...days.entries()].map(([date, v]) => ({ date, income: round2(v.income), expense: round2(v.expense) }));
    }

    const rangeDays = f.from && f.to ? daysBetween(f.from, f.to) + 1 : null;
    return {
      currency: main,
      count,
      income: round2(income),
      expense: round2(expense),
      net: round2(income - expense),
      transfers: round2(transfers),
      averagePerDay: rangeDays && rangeDays > 0 ? round2(expense / rangeDays) : null,
      largestExpense: largest ? toTransactionDto(largest) : null,
      expenseByCategory: breakdown('EXPENSE', expense),
      incomeByCategory: breakdown('INCOME', income),
      byDay,
      unconverted: [...unconverted],
    };
  }

  /// CSV (abre no Excel/Numbers/Sheets). No plano grátis, até X dias de cada vez.
  async exportCsv(userId: string, filters: Partial<TransactionFilters>) {
    const s = await this.settings(userId);
    const lang = resolveLanguage(s.language);
    const ent = await this.entitlements.forUser(userId);
    let from = filters.from;
    let to = filters.to;
    if (!ent.features.includes(FEATURES.exportAdvanced)) {
      const max = ent.limits.exportDays ?? 36500;
      to = to ?? todayIn(s.timezone);
      from = from ?? addDays(to, -(max - 1));
      if (daysBetween(from, to) + 1 > max) {
        throw ApiException.forbidden('EXPORT_RANGE_LIMIT', { days: max }, { feature: FEATURES.exportAdvanced, requiredPlan: await this.entitlements.lowestPlanWith(FEATURES.exportAdvanced) });
      }
    }
    const f = { ...filters, from, to, categoryIds: await this.expandCategories(userId, filters.categoryIds) };
    const rows = await this.prisma.transaction.findMany({
      where: buildTransactionWhere(userId, f),
      include: txInclude,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      take: 20_000,
    });
    const sep = lang === 'en' ? ',' : ';';
    const decimal = lang === 'en' ? '.' : ',';
    const cell = (value: string | number | null | undefined) => {
      const text = value === null || value === undefined ? '' : String(value);
      return text.includes('"') || text.includes(sep) || /[\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [CSV_HEADERS[lang].map(cell).join(sep)];
    for (const t of rows) {
      const signed = t.type === 'INCOME' ? num(t.amount) : -num(t.amount);
      const category = t.category ? (t.category.name ?? categoryName(t.category.key, lang)) : '';
      lines.push(
        [
          fromDbDate(t.date),
          CSV_TYPES[lang][t.type],
          signed.toFixed(2).replace('.', decimal),
          t.currency,
          t.account.name,
          t.toAccount?.name ?? '',
          category,
          t.description ?? (t.isAdjustment ? ADJUSTMENT_LABEL[lang] : ''),
          t.merchant ?? '',
          t.tags.join(' '),
          t.note ?? '',
        ]
          .map(cell)
          .join(sep),
      );
    }
    // BOM: o Excel lê bem os acentos.
    const content = Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
    const filename = `contalex-${from ?? 'inicio'}-${to ?? todayIn(s.timezone)}.csv`;
    return { filename, content };
  }

  /// Ao escrever a descrição, sugere categoria/conta (regras ou histórico).
  async suggest(userId: string, description: string, type: TransactionType = 'EXPENSE') {
    const text = description.trim();
    if (text.length < 2) return null;
    const rule = await this.rules.match(userId, { description: text });
    if (rule) return { categoryId: rule.categoryId, accountId: null, merchant: null, tags: rule.addTags, amount: null, source: 'rule' };
    const select = { categoryId: true, accountId: true, merchant: true, tags: true, amount: true } as const;
    const last =
      (await this.prisma.transaction.findFirst({ where: { userId, type, description: { equals: text, mode: 'insensitive' } }, orderBy: { date: 'desc' }, select })) ??
      (await this.prisma.transaction.findFirst({ where: { userId, type, description: { startsWith: text, mode: 'insensitive' } }, orderBy: { date: 'desc' }, select }));
    if (!last) return null;
    return { categoryId: last.categoryId, accountId: last.accountId, merchant: last.merchant, tags: last.tags, amount: num(last.amount), source: 'history' };
  }

  /// Descrições já usadas (autocompletar ao adicionar).
  async descriptions(userId: string, q: string) {
    const text = q.trim();
    if (!text) return [];
    const rows = await this.prisma.transaction.findMany({
      where: { userId, description: { startsWith: text, mode: 'insensitive' } },
      distinct: ['description'],
      orderBy: { date: 'desc' },
      take: 8,
      select: { description: true, type: true, categoryId: true },
    });
    return rows;
  }

  async tags(userId: string) {
    const rows = await this.prisma.$queryRaw<Array<{ tag: string; count: bigint }>>`
      SELECT tag, COUNT(*)::bigint AS count
      FROM (SELECT unnest("tags") AS tag FROM "Transaction" WHERE "userId" = ${userId}) t
      GROUP BY tag ORDER BY count DESC, tag ASC LIMIT 200`;
    return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
  }

  // ----- Filtros guardados -----

  async savedFilters(userId: string) {
    return this.prisma.savedFilter.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  async saveFilter(userId: string, name: string, filters: Record<string, unknown>) {
    await this.entitlements.assertLimit(userId, 'savedFilters', await this.prisma.savedFilter.count({ where: { userId } }));
    return this.prisma.savedFilter.create({ data: { userId, name, filters: filters as object } });
  }

  async removeFilter(userId: string, id: string) {
    const result = await this.prisma.savedFilter.deleteMany({ where: { id, userId } });
    if (!result.count) throw ApiException.notFound('FILTER_NOT_FOUND');
    return { deleted: true };
  }

  // ----- Usado pelos pagamentos recorrentes -----

  async createFromRecurring(rule: RecurringRule, date: string) {
    return this.create(
      rule.userId,
      {
        type: rule.type,
        amount: num(rule.amount),
        accountId: rule.accountId,
        toAccountId: rule.toAccountId,
        categoryId: rule.categoryId,
        date,
        description: rule.description,
        merchant: rule.merchant,
      },
      { recurringRuleId: rule.id, allowArchived: true },
    );
  }
}
