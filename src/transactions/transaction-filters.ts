import { Prisma } from '../generated/prisma/client';
import { toDbDate } from '../common/utils/dates';
import { TransactionFilters } from './transactions.dto';

/// Filtros → `where` do Prisma. `categoryIds` já deve vir com as
/// subcategorias incluídas (ver TransactionsService.expandCategories).
/// `excludeCategoryIds`: categorias que ficam de fora (quem acompanha os gastos
/// de alguém não vê as que essa pessoa reservou). Os movimentos sem categoria ficam.
export function buildTransactionWhere(userId: string, f: Partial<TransactionFilters> & { excludeCategoryIds?: string[] }): Prisma.TransactionWhereInput {
  const and: Prisma.TransactionWhereInput[] = [];
  const where: Prisma.TransactionWhereInput = { userId };

  if (f.type?.length) where.type = { in: f.type };
  if (f.accountIds?.length) and.push({ OR: [{ accountId: { in: f.accountIds } }, { toAccountId: { in: f.accountIds } }] });
  if (f.categoryIds?.length) {
    const ids = f.categoryIds.filter((c) => c !== 'none');
    const or: Prisma.TransactionWhereInput[] = [];
    if (ids.length) or.push({ categoryId: { in: ids } });
    if (f.categoryIds.includes('none')) or.push({ categoryId: null, type: { in: ['INCOME', 'EXPENSE'] } });
    and.push({ OR: or });
  }
  if (f.excludeCategoryIds?.length) and.push({ OR: [{ categoryId: null }, { categoryId: { notIn: f.excludeCategoryIds } }] });
  if (f.tags?.length) where.tags = { hasSome: f.tags };
  if (f.from || f.to) {
    where.date = {
      ...(f.from ? { gte: toDbDate(f.from) } : {}),
      ...(f.to ? { lte: toDbDate(f.to) } : {}),
    };
  }
  if (f.minAmount !== undefined || f.maxAmount !== undefined) {
    where.amount = {
      ...(f.minAmount !== undefined ? { gte: new Prisma.Decimal(f.minAmount) } : {}),
      ...(f.maxAmount !== undefined ? { lte: new Prisma.Decimal(f.maxAmount) } : {}),
    };
  }
  if (f.q) {
    const q = f.q;
    and.push({
      OR: [
        { description: { contains: q, mode: 'insensitive' } },
        { merchant: { contains: q, mode: 'insensitive' } },
        { note: { contains: q, mode: 'insensitive' } },
        // Os produtos de uma fatura lida também se pesquisam ("onde comprei o leite?")
        { itemsText: { contains: q, mode: 'insensitive' } },
        { tags: { has: q.toLowerCase().replace(/^#/, '') } },
      ],
    });
  }
  if (f.hasAttachment !== undefined) where.attachments = f.hasAttachment ? { some: {} } : { none: {} };
  if (f.planId) where.planId = f.planId;
  if (f.recurringOnly) where.recurringRuleId = { not: null };
  if (and.length) where.AND = and;
  return where;
}

export function orderFor(sort: TransactionFilters['sort'] | undefined): Prisma.TransactionOrderByWithRelationInput[] {
  switch (sort) {
    case 'date_asc':
      return [{ date: 'asc' }, { createdAt: 'asc' }];
    case 'amount_desc':
      return [{ amount: 'desc' }, { date: 'desc' }];
    case 'amount_asc':
      return [{ amount: 'asc' }, { date: 'desc' }];
    default:
      return [{ date: 'desc' }, { createdAt: 'desc' }];
  }
}
