import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ApiException } from '../common/errors/api.exception';
import { money, num, numOrNull, round2 } from '../common/utils/money';
import { addMonths, fromDbDate, monthKey, toDbDate, todayIn } from '../common/utils/dates';
import { TransactionsService } from '../transactions/transactions.service';
import { Dividend, Investment } from '../generated/prisma/client';
import { CreateInvestmentDto, DividendDto, ProjectDividendsDto, UpdateInvestmentDto } from './investments.dto';

/// Investimentos com valor atualizado à mão e dividendos: os recebidos
/// entram como receita (se a pessoa quiser); os previstos são só projeção.
@Injectable()
export class InvestmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
  ) {}

  private dto(i: Investment & { dividends?: Dividend[] }) {
    const invested = num(i.invested);
    const value = num(i.currentValue);
    const received = (i.dividends ?? []).filter((d) => !d.expected).reduce((a, d) => a + num(d.amount), 0);
    return {
      id: i.id,
      name: i.name,
      type: i.type,
      currency: i.currency,
      invested,
      currentValue: value,
      units: i.units === null ? null : Number(i.units),
      expectedYield: i.expectedYield === null ? null : Number(i.expectedYield),
      note: i.note,
      accountId: i.accountId,
      isActive: i.isActive,
      valuedAt: i.valuedAt,
      gain: round2(value - invested),
      gainPercent: invested > 0 ? round2(((value - invested) / invested) * 100) : null,
      dividendsReceived: round2(received),
      totalReturn: round2(value - invested + received),
      createdAt: i.createdAt,
    };
  }

  private async owned(userId: string, id: string) {
    const row = await this.prisma.investment.findFirst({ where: { id, userId } });
    if (!row) throw ApiException.notFound('INVESTMENT_NOT_FOUND');
    return row;
  }

  private async user(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true, timezone: true } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    return user;
  }

  async list(userId: string) {
    const rows = await this.prisma.investment.findMany({ where: { userId }, include: { dividends: true }, orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] });
    const items = rows.map((r) => this.dto(r));
    const active = items.filter((i) => i.isActive);
    const user = await this.user(userId);
    return {
      items,
      currency: user.currency,
      summary: {
        invested: round2(active.reduce((a, i) => a + i.invested, 0)),
        currentValue: round2(active.reduce((a, i) => a + i.currentValue, 0)),
        gain: round2(active.reduce((a, i) => a + i.gain, 0)),
        dividendsReceived: round2(items.reduce((a, i) => a + i.dividendsReceived, 0)),
      },
    };
  }

  async get(userId: string, id: string) {
    const row = await this.prisma.investment.findFirst({ where: { id, userId }, include: { dividends: { orderBy: { date: 'desc' } } } });
    if (!row) throw ApiException.notFound('INVESTMENT_NOT_FOUND');
    return { ...this.dto(row), dividends: row.dividends.map((d) => this.dividendDto(d)) };
  }

  private dividendDto(d: Dividend) {
    return { id: d.id, investmentId: d.investmentId, amount: num(d.amount), currency: d.currency, date: fromDbDate(d.date), expected: d.expected, note: d.note, transactionId: d.transactionId, createdAt: d.createdAt };
  }

  async create(userId: string, dto: CreateInvestmentDto) {
    const user = await this.user(userId);
    const row = await this.prisma.investment.create({
      data: {
        userId,
        name: dto.name,
        type: dto.type,
        currency: dto.currency ?? user.currency,
        invested: money(dto.invested),
        currentValue: money(dto.currentValue ?? dto.invested),
        units: dto.units ?? null,
        expectedYield: dto.expectedYield ?? null,
        note: dto.note ?? null,
        accountId: dto.accountId ?? null,
        valuedAt: new Date(),
      },
    });
    return this.get(userId, row.id);
  }

  async update(userId: string, id: string, dto: UpdateInvestmentDto) {
    await this.owned(userId, id);
    await this.prisma.investment.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.invested !== undefined ? { invested: money(dto.invested) } : {}),
        ...(dto.currentValue !== undefined ? { currentValue: money(dto.currentValue), valuedAt: new Date() } : {}),
        ...(dto.units !== undefined ? { units: dto.units } : {}),
        ...(dto.expectedYield !== undefined ? { expectedYield: dto.expectedYield } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...(dto.accountId !== undefined ? { accountId: dto.accountId } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    return this.get(userId, id);
  }

  async remove(userId: string, id: string) {
    await this.owned(userId, id);
    await this.prisma.investment.delete({ where: { id } });
    return { deleted: true };
  }

  /// Um dividendo: recebido (pode entrar como receita numa conta) ou previsto.
  async addDividend(userId: string, id: string, dto: DividendDto) {
    const inv = await this.owned(userId, id);
    let transactionId: string | null = null;
    if (!dto.expected && dto.accountId) {
      const category = dto.categoryId ?? (await this.prisma.category.findFirst({ where: { userId, key: 'other_income', type: 'INCOME' }, select: { id: true } }))?.id ?? null;
      const tx = await this.transactions.create(userId, { type: 'INCOME', amount: dto.amount, accountId: dto.accountId, categoryId: category, date: dto.date, description: inv.name, tags: ['dividendos'] });
      transactionId = tx.id;
    }
    const row = await this.prisma.dividend.create({ data: { investmentId: id, userId, amount: money(dto.amount), currency: inv.currency, date: toDbDate(dto.date), expected: dto.expected, note: dto.note ?? null, transactionId } });
    return this.dividendDto(row);
  }

  /// Marca um dividendo previsto como recebido (com o valor real, se mudou).
  async confirmDividend(userId: string, id: string, dividendId: string, input: { amount?: number; date?: string; accountId?: string | null; categoryId?: string | null }) {
    const inv = await this.owned(userId, id);
    const d = await this.prisma.dividend.findFirst({ where: { id: dividendId, investmentId: id } });
    if (!d) throw ApiException.notFound('NOT_FOUND');
    const amount = input.amount ?? num(d.amount);
    const date = input.date ?? fromDbDate(d.date);
    let transactionId = d.transactionId;
    if (input.accountId && !transactionId) {
      const category = input.categoryId ?? (await this.prisma.category.findFirst({ where: { userId, key: 'other_income', type: 'INCOME' }, select: { id: true } }))?.id ?? null;
      const tx = await this.transactions.create(userId, { type: 'INCOME', amount, accountId: input.accountId, categoryId: category, date, description: inv.name, tags: ['dividendos'] });
      transactionId = tx.id;
    }
    const row = await this.prisma.dividend.update({ where: { id: dividendId }, data: { expected: false, amount: money(amount), date: toDbDate(date), transactionId } });
    return this.dividendDto(row);
  }

  async removeDividend(userId: string, id: string, dividendId: string) {
    await this.owned(userId, id);
    const d = await this.prisma.dividend.findFirst({ where: { id: dividendId, investmentId: id } });
    if (!d) throw ApiException.notFound('NOT_FOUND');
    await this.prisma.dividend.delete({ where: { id: dividendId } });
    return { deleted: true };
  }

  /// Cria a projeção: X todos os meses/trimestres/anos a partir de uma data.
  async project(userId: string, id: string, dto: ProjectDividendsDto) {
    const inv = await this.owned(userId, id);
    const step = dto.every === 'MONTHLY' ? 1 : dto.every === 'QUARTERLY' ? 3 : 12;
    const rows: { investmentId: string; userId: string; amount: ReturnType<typeof money>; currency: string; date: Date; expected: boolean }[] = [];
    for (let m = 0; m < dto.months; m += step) {
      rows.push({ investmentId: id, userId, amount: money(dto.amount), currency: inv.currency, date: toDbDate(addMonths(dto.startDate, m, Number(dto.startDate.slice(8, 10)))), expected: true });
    }
    // Substitui a projeção anterior a partir dessa data (os recebidos ficam).
    await this.prisma.dividend.deleteMany({ where: { investmentId: id, expected: true, date: { gte: toDbDate(dto.startDate) } } });
    await this.prisma.dividend.createMany({ data: rows });
    return this.get(userId, id);
  }

  /// Dividendos por mês: recebidos e previstos, para comparar.
  async dividendsByMonth(userId: string, months = 12) {
    const user = await this.user(userId);
    const today = todayIn(user.timezone);
    const from = addMonths(today, -(months - 1));
    const rows = await this.prisma.dividend.findMany({ where: { userId, date: { gte: toDbDate(from.slice(0, 7) + '-01'), lte: toDbDate(addMonths(today, 12)) } }, include: { investment: { select: { name: true, currency: true } } }, orderBy: { date: 'asc' } });
    const byMonth = new Map<string, { month: string; received: number; expected: number }>();
    for (const d of rows) {
      const key = monthKey(fromDbDate(d.date));
      const m = byMonth.get(key) ?? { month: key, received: 0, expected: 0 };
      if (d.expected) m.expected += num(d.amount);
      else m.received += num(d.amount);
      byMonth.set(key, m);
    }
    const list = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({ ...m, received: round2(m.received), expected: round2(m.expected) }));
    const thisMonth = monthKey(today);
    return {
      currency: user.currency,
      months: list,
      thisMonth: list.find((m) => m.month === thisMonth) ?? { month: thisMonth, received: 0, expected: 0 },
      upcoming: rows.filter((d) => d.expected && fromDbDate(d.date) >= today).slice(0, 10).map((d) => ({ ...this.dividendDto(d), investment: d.investment.name })),
      yearReceived: round2(rows.filter((d) => !d.expected && fromDbDate(d.date).startsWith(today.slice(0, 4))).reduce((a, d) => a + num(d.amount), 0)),
      yearExpected: round2(rows.filter((d) => d.expected && fromDbDate(d.date).startsWith(today.slice(0, 4))).reduce((a, d) => a + num(d.amount), 0)),
    };
  }
}
