import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { ApiException } from '../common/errors/api.exception';
import { TransactionsService } from '../transactions/transactions.service';
import { fromDbDateOrNull, toDbDate } from '../common/utils/dates';
import { money, numOrNull } from '../common/utils/money';
import { dateOnly, positiveMoney, uuid } from '../accounts/accounts.dto';
import { PendingTransaction, Prisma } from '../generated/prisma/client';

export const confirmPendingSchema = z.object({
  accountId: uuid,
  categoryId: uuid.nullable().optional(),
  amount: positiveMoney.optional(),
  date: dateOnly.optional(),
  description: z.string().trim().max(140).nullable().optional(),
  type: z.enum(['INCOME', 'EXPENSE']).optional(),
});
export type ConfirmPendingDto = z.infer<typeof confirmPendingSchema>;

/// Movimentos à espera de confirmação (vindos do WhatsApp): a pessoa vê,
/// corrige se for preciso e só então ficam guardados.
@Injectable()
export class PendingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
  ) {}

  dto(p: PendingTransaction) {
    return {
      id: p.id,
      source: p.source,
      type: p.type,
      amount: numOrNull(p.amount),
      currency: p.currency,
      date: fromDbDateOrNull(p.date),
      description: p.description,
      merchant: p.merchant,
      categoryKey: p.categoryKey,
      attachmentId: p.attachmentId,
      items: p.items,
      rawText: p.rawText,
      status: p.status,
      transactionId: p.transactionId,
      createdAt: p.createdAt,
    };
  }

  async create(userId: string, input: { source: 'WHATSAPP' | 'IMPORT'; sourceId?: string | null; type?: 'INCOME' | 'EXPENSE'; amount?: number | null; currency?: string | null; date?: string | null; description?: string | null; merchant?: string | null; categoryKey?: string | null; attachmentId?: string | null; items?: unknown; rawText?: string | null }) {
    try {
      const row = await this.prisma.pendingTransaction.create({
        data: {
          userId,
          source: input.source,
          sourceId: input.sourceId ?? null,
          type: input.type ?? 'EXPENSE',
          amount: input.amount != null ? money(input.amount) : null,
          currency: input.currency ?? null,
          date: input.date ? toDbDate(input.date) : null,
          description: input.description?.slice(0, 140) ?? null,
          merchant: input.merchant?.slice(0, 80) ?? null,
          categoryKey: input.categoryKey ?? null,
          attachmentId: input.attachmentId ?? null,
          items: (input.items ?? undefined) as Prisma.InputJsonValue | undefined,
          rawText: input.rawText?.slice(0, 2000) ?? null,
        },
      });
      return { created: true as const, pending: this.dto(row) };
    } catch (err) {
      // A mesma mensagem outra vez: já está.
      if ((err as { code?: string }).code === 'P2002') return { created: false as const, pending: null };
      throw err;
    }
  }

  async list(userId: string) {
    const rows = await this.prisma.pendingTransaction.findMany({ where: { userId, status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => this.dto(r));
  }

  async count(userId: string) {
    return this.prisma.pendingTransaction.count({ where: { userId, status: 'PENDING' } });
  }

  private async owned(userId: string, id: string) {
    const row = await this.prisma.pendingTransaction.findFirst({ where: { id, userId } });
    if (!row) throw ApiException.notFound('NOT_FOUND');
    if (row.status !== 'PENDING') throw ApiException.conflict('PENDING_ALREADY_DONE');
    return row;
  }

  async confirm(userId: string, id: string, dto: ConfirmPendingDto) {
    const p = await this.owned(userId, id);
    const amount = dto.amount ?? numOrNull(p.amount);
    const date = dto.date ?? fromDbDateOrNull(p.date);
    if (!amount || amount <= 0) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'amount', message: 'required' }]);
    if (!date) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'date', message: 'required' }]);
    const type = dto.type ?? (p.type === 'INCOME' ? 'INCOME' : 'EXPENSE');
    let categoryId = dto.categoryId ?? null;
    if (categoryId === null && dto.categoryId === undefined && p.categoryKey) {
      categoryId = (await this.prisma.category.findFirst({ where: { userId, key: p.categoryKey, type }, select: { id: true } }))?.id ?? null;
    }
    const items = Array.isArray(p.items) ? (p.items as { name: string; quantity?: number | null; price?: number | null }[]) : undefined;
    const tx = await this.transactions.create(userId, {
      type,
      amount,
      accountId: dto.accountId,
      categoryId,
      date,
      description: dto.description !== undefined ? dto.description : (p.description ?? p.merchant ?? null),
      merchant: p.merchant,
      attachmentIds: p.attachmentId ? [p.attachmentId] : undefined,
      items: items?.slice(0, 80),
      tags: [p.source === 'WHATSAPP' ? 'whatsapp' : 'importado'],
    });
    await this.prisma.pendingTransaction.update({ where: { id }, data: { status: 'CONFIRMED', transactionId: tx.id } });
    return tx;
  }

  async discard(userId: string, id: string) {
    await this.owned(userId, id);
    await this.prisma.pendingTransaction.update({ where: { id }, data: { status: 'DISCARDED' } });
    return { discarded: true };
  }
}
