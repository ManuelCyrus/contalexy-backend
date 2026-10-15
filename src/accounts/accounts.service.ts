import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { ExchangeService } from '../exchange/exchange.service';
import { BalancesService } from './balances.service';
import { ApiException } from '../common/errors/api.exception';
import { isCurrency } from '../meta/countries.data';
import { money, num, numOrNull } from '../common/utils/money';
import { fromDbDate, todayIn, toDbDate } from '../common/utils/dates';
import { Account, Prisma } from '../generated/prisma/client';
import { CreateAccountDto, UpdateAccountDto } from './accounts.dto';

const TYPE_ICONS: Record<string, string> = {
  BANK: 'account_balance',
  CASH: 'payments',
  SAVINGS: 'savings',
  CREDIT_CARD: 'credit_card',
  DIGITAL_WALLET: 'account_balance_wallet',
  INVESTMENT: 'trending_up',
  OTHER: 'wallet',
};

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly exchange: ExchangeService,
    private readonly balances: BalancesService,
  ) {}

  private toDto(account: Account, balance: Prisma.Decimal, mainCurrency: string) {
    const value = num(balance);
    return {
      id: account.id,
      name: account.name,
      type: account.type,
      institution: account.institution,
      /// Banco de referência (o logótipo vem de /meta/institutions)
      institutionId: account.institutionId,
      currency: account.currency,
      balance: value,
      /// Na moeda principal (null se não houver câmbio)
      convertedBalance: this.exchange.convert(value, account.currency, mainCurrency),
      initialBalance: num(account.initialBalance),
      creditLimit: numOrNull(account.creditLimit),
      /// Cartão de crédito: quanto ainda dá para gastar
      availableCredit: account.creditLimit ? num(account.creditLimit.plus(balance)) : null,
      color: account.color,
      icon: account.icon,
      includeInTotal: account.includeInTotal,
      archived: !!account.archivedAt,
      sortOrder: account.sortOrder,
      createdAt: account.createdAt,
    };
  }

  private async mainCurrency(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true } });
    return user?.currency ?? 'EUR';
  }

  async list(userId: string, includeArchived = false) {
    const [accounts, mainCurrency] = await Promise.all([
      this.prisma.account.findMany({
        where: { userId, ...(includeArchived ? {} : { archivedAt: null }) },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.mainCurrency(userId),
    ]);
    const balances = await this.balances.balances(userId, accounts.map((a) => a.id));
    const items = accounts.map((a) => this.toDto(a, balances.get(a.id) ?? new Prisma.Decimal(0), mainCurrency));
    const counted = items.filter((a) => a.includeInTotal && !a.archived);
    const byCurrency: Record<string, number> = {};
    for (const a of counted) byCurrency[a.currency] = (byCurrency[a.currency] ?? 0) + a.balance;
    const total = this.exchange.total(byCurrency, mainCurrency);
    return { accounts: items, total: total.total, currency: mainCurrency, unconverted: total.unconverted };
  }

  async ownedOrThrow(userId: string, id: string) {
    const account = await this.prisma.account.findFirst({ where: { id, userId } });
    if (!account) throw ApiException.notFound('ACCOUNT_NOT_FOUND');
    return account;
  }

  async get(userId: string, id: string) {
    const account = await this.ownedOrThrow(userId, id);
    return this.toDto(account, await this.balances.balance(userId, id), await this.mainCurrency(userId));
  }

  async create(userId: string, dto: CreateAccountDto) {
    const active = await this.prisma.account.count({ where: { userId, archivedAt: null } });
    await this.entitlements.assertLimit(userId, 'accounts', active);
    const currency = dto.currency ?? (await this.mainCurrency(userId));
    if (!isCurrency(currency)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'currency', message: 'unknown' }]);
    const last = await this.prisma.account.aggregate({ where: { userId }, _max: { sortOrder: true } });
    const account = await this.prisma.account.create({
      data: {
        userId,
        name: dto.name,
        type: dto.type,
        institution: dto.institution ?? null,
        institutionId: dto.institutionId ?? null,
        currency,
        initialBalance: money(dto.initialBalance ?? 0),
        creditLimit: dto.creditLimit == null ? null : money(dto.creditLimit),
        color: dto.color ?? '#2D4BE0',
        icon: dto.icon ?? TYPE_ICONS[dto.type] ?? 'wallet',
        includeInTotal: dto.includeInTotal ?? true,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
    return this.toDto(account, account.initialBalance, await this.mainCurrency(userId));
  }

  async update(userId: string, id: string, dto: UpdateAccountDto) {
    const account = await this.ownedOrThrow(userId, id);
    const data: Prisma.AccountUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.institution !== undefined) data.institution = dto.institution;
    if (dto.institutionId !== undefined) data.institutionId = dto.institutionId;
    if (dto.currency !== undefined && dto.currency !== account.currency) {
      if (!isCurrency(dto.currency)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'currency', message: 'unknown' }]);
      const used = await this.prisma.transaction.count({ where: { OR: [{ accountId: id }, { toAccountId: id }] } });
      if (used) throw ApiException.conflict('ACCOUNT_CURRENCY_LOCKED');
      data.currency = dto.currency;
    }
    if (dto.initialBalance !== undefined) data.initialBalance = money(dto.initialBalance);
    if (dto.creditLimit !== undefined) data.creditLimit = dto.creditLimit === null ? null : money(dto.creditLimit);
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.icon !== undefined) data.icon = dto.icon;
    if (dto.includeInTotal !== undefined) data.includeInTotal = dto.includeInTotal;
    if (dto.archived !== undefined) {
      if (!dto.archived && account.archivedAt) {
        const active = await this.prisma.account.count({ where: { userId, archivedAt: null } });
        await this.entitlements.assertLimit(userId, 'accounts', active);
      }
      data.archivedAt = dto.archived ? (account.archivedAt ?? new Date()) : null;
    }
    await this.prisma.account.update({ where: { id }, data });
    return this.get(userId, id);
  }

  /// Sem movimentos apaga-se. Com movimentos só com `force` (apaga-os
  /// também) — a app oferece "Arquivar" como alternativa.
  async remove(userId: string, id: string, force = false) {
    await this.ownedOrThrow(userId, id);
    const count = await this.prisma.transaction.count({ where: { OR: [{ accountId: id }, { toAccountId: id }] } });
    if (count && !force) throw ApiException.conflict('ACCOUNT_HAS_TRANSACTIONS', { count });
    await this.prisma.account.delete({ where: { id } });
    return { deleted: true, transactionsDeleted: count };
  }

  /// "O saldo real é X": cria um ajuste (não conta como receita/despesa).
  async adjustBalance(userId: string, id: string, target: number, date?: string) {
    const account = await this.ownedOrThrow(userId, id);
    if (account.archivedAt) throw ApiException.badRequest('ACCOUNT_ARCHIVED');
    const current = await this.balances.balance(userId, id);
    const diff = money(target).minus(current);
    if (diff.isZero()) return this.get(userId, id);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    await this.prisma.transaction.create({
      data: {
        userId,
        type: diff.isPositive() ? 'INCOME' : 'EXPENSE',
        amount: diff.abs(),
        currency: account.currency,
        accountId: id,
        date: toDbDate(date ?? todayIn(user?.timezone ?? 'UTC')),
        isAdjustment: true,
        excludeFromReports: true,
      },
    });
    return this.get(userId, id);
  }

  async reorder(userId: string, ids: string[]) {
    const owned = await this.prisma.account.findMany({ where: { userId, id: { in: ids } }, select: { id: true } });
    const allowed = new Set(owned.map((a) => a.id));
    await this.prisma.$transaction(ids.filter((id) => allowed.has(id)).map((id, index) => this.prisma.account.update({ where: { id }, data: { sortOrder: index } })));
    return this.list(userId, true);
  }

  /// Saldo de uma conta ao fim de cada um dos últimos meses (gráfico).
  async history(userId: string, id: string, months = 6) {
    const account = await this.ownedOrThrow(userId, id);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    const today = todayIn(user?.timezone ?? 'UTC');
    const points: Array<{ date: string; balance: number }> = [];
    const n = Math.min(Math.max(months, 1), 24);
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 - i + 1, 0));
      const end = i === 0 ? today : fromDbDate(d);
      points.push({ date: end, balance: num(await this.balances.balance(userId, account.id, end)) });
    }
    return { accountId: id, currency: account.currency, points };
  }
}
