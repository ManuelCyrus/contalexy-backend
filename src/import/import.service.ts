import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { ApiException } from '../common/errors/api.exception';
import { EntitlementsService } from '../billing/entitlements.service';
import { FEATURES } from '../billing/plans.catalog';
import { AiService } from '../ai/ai.service';
import { TransactionsService } from '../transactions/transactions.service';
import { UploadedFileLike } from '../storage/storage.service';
import { toDbDate } from '../common/utils/dates';
import { applyMapping, guessMapping, Mapping, mappingConfidence, ParsedRow, RawTable, readTable } from './parse';
import { Prisma } from '../generated/prisma/client';

export const mappingSchema = z.object({
  date: z.number().int().min(0).nullable(),
  amount: z.number().int().min(0).nullable(),
  debit: z.number().int().min(0).nullable(),
  credit: z.number().int().min(0).nullable(),
  description: z.number().int().min(0).nullable(),
  merchant: z.number().int().min(0).nullable(),
  category: z.number().int().min(0).nullable(),
  positiveIsExpense: z.boolean().default(false),
  monthFirst: z.boolean().default(false),
});
export const commitSchema = z.object({
  mapping: mappingSchema.optional(),
  accountId: z.string().uuid(),
  /// Categoria para tudo (opcional); senão, pelas regras automáticas e pelo nome da categoria no ficheiro
  categoryId: z.string().uuid().nullable().optional(),
  skipDuplicates: z.boolean().default(true),
  /// Só estas linhas (índices); vazio = todas as válidas
  rows: z.array(z.number().int().min(0)).max(5000).optional(),
});
export type CommitDto = z.infer<typeof commitSchema>;

const BATCH_TTL_MS = 60 * 60_000;
const MAX_ROWS = 5000;

/// Importar movimentos de outra app ou do banco (CSV/XLSX): ler, mapear as
/// colunas, ver duplicados, pré-visualizar e só depois confirmar.
@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly ai: AiService,
    private readonly transactions: TransactionsService,
  ) {}

  private table(batch: { columns: unknown; rows: unknown }): RawTable {
    return { columns: batch.columns as string[], rows: batch.rows as string[][] };
  }

  private async batch(userId: string, id: string) {
    const b = await this.prisma.importBatch.findFirst({ where: { id, userId } });
    if (!b) throw ApiException.notFound('IMPORT_NOT_FOUND');
    if (b.expiresAt < new Date()) throw ApiException.notFound('IMPORT_NOT_FOUND');
    return b;
  }

  /// Linhas iguais a movimentos que já existem (mesma data, valor e descrição).
  private async markDuplicates(userId: string, rows: ParsedRow[]) {
    const valid = rows.filter((r) => r.valid);
    if (!valid.length) return new Set<number>();
    const dates = [...new Set(valid.map((r) => r.date as string))];
    const existing = await this.prisma.transaction.findMany({
      where: { userId, date: { in: dates.map((d) => toDbDate(d)) } },
      select: { date: true, amount: true, description: true, type: true },
    });
    const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40);
    const keys = new Set(existing.map((t) => `${t.date.toISOString().slice(0, 10)}|${Number(t.amount).toFixed(2)}|${t.type}|${norm(t.description)}`));
    const loose = new Set(existing.map((t) => `${t.date.toISOString().slice(0, 10)}|${Number(t.amount).toFixed(2)}|${t.type}`));
    const dup = new Set<number>();
    for (const r of valid) {
      const key = `${r.date}|${(r.amount as number).toFixed(2)}|${r.type}`;
      if (keys.has(`${key}|${norm(r.description)}`) || (!r.description && loose.has(key))) dup.add(r.index);
    }
    return dup;
  }

  private async preview(userId: string, batchId: string, table: RawTable, mapping: Mapping, extra: Record<string, unknown> = {}) {
    const rows = applyMapping(table, mapping);
    const duplicates = await this.markDuplicates(userId, rows);
    const valid = rows.filter((r) => r.valid);
    return {
      batchId,
      columns: table.columns.map((name, index) => ({ index, name, sample: table.rows.slice(0, 3).map((r) => r[index] ?? '') })),
      mapping,
      confidence: mappingConfidence(mapping),
      rowCount: table.rows.length,
      validCount: valid.length,
      duplicateCount: duplicates.size,
      totals: {
        income: Math.round(valid.filter((r) => r.type === 'INCOME').reduce((a, r) => a + (r.amount ?? 0), 0) * 100) / 100,
        expense: Math.round(valid.filter((r) => r.type === 'EXPENSE').reduce((a, r) => a + (r.amount ?? 0), 0) * 100) / 100,
      },
      /// As primeiras 60 linhas já interpretadas (para a pessoa conferir)
      rows: rows.slice(0, 60).map((r) => ({ ...r, duplicate: duplicates.has(r.index) })),
      ...extra,
    };
  }

  async upload(userId: string, file: UploadedFileLike | undefined) {
    if (!file?.buffer?.length) throw ApiException.badRequest('FILE_REQUIRED');
    if (file.size > 5 * 1024 * 1024) throw ApiException.badRequest('FILE_TOO_LARGE', { max: 5 });
    const name = (file.originalname ?? 'ficheiro.csv').slice(0, 160);
    if (!/\.(csv|txt|tsv|xlsx|xlsm)$/i.test(name)) throw ApiException.badRequest('FILE_TYPE_NOT_ALLOWED');
    let table: RawTable;
    try {
      table = await readTable(file.buffer, name);
    } catch {
      throw ApiException.badRequest('IMPORT_UNREADABLE');
    }
    if (!table.columns.length || !table.rows.length) throw ApiException.badRequest('IMPORT_EMPTY');
    if (table.rows.length > MAX_ROWS) table.rows = table.rows.slice(0, MAX_ROWS);
    // Limpa importações antigas por confirmar.
    await this.prisma.importBatch.deleteMany({ where: { userId, status: 'PREVIEW', createdAt: { lt: new Date(Date.now() - BATCH_TTL_MS) } } });
    const mapping = guessMapping(table);
    const batch = await this.prisma.importBatch.create({
      data: { userId, fileName: name, columns: table.columns as unknown as Prisma.InputJsonValue, rows: table.rows as unknown as Prisma.InputJsonValue, mapping: mapping as unknown as Prisma.InputJsonValue, rowCount: table.rows.length, expiresAt: new Date(Date.now() + BATCH_TTL_MS) },
    });
    const smart = await this.entitlements.hasFeature(userId, FEATURES.importSmart);
    return this.preview(userId, batch.id, table, mapping, { fileName: name, canUseAi: smart, suggestAi: smart && mappingConfidence(mapping) < 0.7 });
  }

  /// Voltar a pré-visualizar com outro mapeamento (escolhido pela pessoa).
  async remap(userId: string, id: string, mapping: Mapping) {
    const b = await this.batch(userId, id);
    await this.prisma.importBatch.update({ where: { id }, data: { mapping: mapping as unknown as Prisma.InputJsonValue } });
    return this.preview(userId, id, this.table(b), mapping, { fileName: b.fileName });
  }

  /// Pedir à IA o mapeamento (só quando o normal não chega; conta como uma pergunta).
  async aiMapping(userId: string, id: string, requestKey?: string) {
    const b = await this.batch(userId, id);
    const table = this.table(b);
    const ai = await this.ai.mapImportColumns(userId, table.columns, table.rows.slice(0, 8), requestKey);
    const { usage, ...mapping } = ai;
    const merged: Mapping = { ...guessMapping(table), ...mapping };
    await this.prisma.importBatch.update({ where: { id }, data: { mapping: merged as unknown as Prisma.InputJsonValue } });
    return { ...(await this.preview(userId, id, table, merged, { fileName: b.fileName })), usage };
  }

  async commit(userId: string, id: string, dto: CommitDto) {
    const b = await this.batch(userId, id);
    if (b.status === 'DONE') throw ApiException.conflict('IMPORT_ALREADY_DONE');
    const table = this.table(b);
    const mapping: Mapping = dto.mapping ?? ((b.mapping as unknown as Mapping | null) ?? guessMapping(table));
    const rows = applyMapping(table, mapping);
    const duplicates = await this.markDuplicates(userId, rows);
    const wanted = dto.rows?.length ? new Set(dto.rows) : null;
    const account = await this.prisma.account.findFirst({ where: { id: dto.accountId, userId }, select: { id: true } });
    if (!account) throw ApiException.notFound('ACCOUNT_NOT_FOUND');
    const categories = await this.prisma.category.findMany({ where: { userId, archivedAt: null }, select: { id: true, key: true, name: true, type: true } });
    const byName = new Map(categories.map((c) => [`${c.type}:${(c.name ?? c.key ?? '').toLowerCase()}`, c.id]));
    let imported = 0;
    let skipped = 0;
    for (const r of rows) {
      if (!r.valid || (wanted && !wanted.has(r.index))) continue;
      if (dto.skipDuplicates && duplicates.has(r.index)) {
        skipped += 1;
        continue;
      }
      const categoryId = dto.categoryId ?? (r.category ? (byName.get(`${r.type}:${r.category.toLowerCase()}`) ?? null) : null);
      await this.transactions.create(userId, {
        type: r.type as 'INCOME' | 'EXPENSE',
        amount: r.amount as number,
        accountId: dto.accountId,
        categoryId,
        date: r.date as string,
        description: r.description ?? r.merchant ?? b.fileName,
        merchant: r.merchant,
        tags: ['importado'],
      });
      imported += 1;
    }
    await this.prisma.importBatch.update({ where: { id }, data: { status: 'DONE', imported, rows: [] as unknown as Prisma.InputJsonValue } });
    return { imported, skipped, total: rows.filter((r) => r.valid).length };
  }

  async discard(userId: string, id: string) {
    await this.batch(userId, id);
    await this.prisma.importBatch.delete({ where: { id } });
    return { deleted: true };
  }
}
