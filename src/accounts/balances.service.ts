import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { DateOnly, toDbDate } from '../common/utils/dates';

/// Saldo de cada conta = saldo inicial + receitas − despesas − transferências
/// que saíram + transferências que entraram (até uma data, se pedida).
@Injectable()
export class BalancesService {
  constructor(private readonly prisma: PrismaService) {}

  async balances(userId: string, accountIds?: string[], until?: DateOnly): Promise<Map<string, Prisma.Decimal>> {
    const accounts = await this.prisma.account.findMany({
      where: { userId, ...(accountIds ? { id: { in: accountIds } } : {}) },
      select: { id: true, initialBalance: true },
    });
    const ids = accounts.map((a) => a.id);
    const result = new Map<string, Prisma.Decimal>(accounts.map((a) => [a.id, new Prisma.Decimal(a.initialBalance)]));
    if (!ids.length) return result;
    const dateFilter = until ? { date: { lte: toDbDate(until) } } : {};

    const [flows, incoming] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['accountId', 'type'],
        where: { userId, accountId: { in: ids }, ...dateFilter },
        _sum: { amount: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['toAccountId'],
        where: { userId, type: 'TRANSFER', toAccountId: { in: ids }, ...dateFilter },
        _sum: { toAmount: true },
      }),
    ]);
    for (const row of flows) {
      const current = result.get(row.accountId) ?? new Prisma.Decimal(0);
      const amount = row._sum.amount ?? new Prisma.Decimal(0);
      result.set(row.accountId, row.type === 'INCOME' ? current.plus(amount) : current.minus(amount));
    }
    for (const row of incoming) {
      if (!row.toAccountId) continue;
      const current = result.get(row.toAccountId) ?? new Prisma.Decimal(0);
      result.set(row.toAccountId, current.plus(row._sum.toAmount ?? 0));
    }
    return result;
  }

  async balance(userId: string, accountId: string, until?: DateOnly): Promise<Prisma.Decimal> {
    return (await this.balances(userId, [accountId], until)).get(accountId) ?? new Prisma.Decimal(0);
  }
}
