import { z } from 'zod';
import { dateOnly, positiveMoney, uuid } from '../accounts/accounts.dto';

export const TX_TYPES = ['INCOME', 'EXPENSE', 'TRANSFER'] as const;
export const tag = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^#+/, ''))
  .pipe(z.string().min(1).max(30));

/// Um produto de uma fatura lida (o preço é o total da linha).
export const receiptItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().min(0).max(99999).nullable().optional(),
  price: z.number().min(0).max(1e12).nullable().optional(),
});
export type ReceiptItem = z.infer<typeof receiptItemSchema>;

const baseTransaction = {
  amount: positiveMoney,
  accountId: uuid,
  toAccountId: uuid.nullable().optional(),
  toAmount: positiveMoney.nullable().optional(),
  categoryId: uuid.nullable().optional(),
  date: dateOnly,
  description: z.string().trim().max(140).nullable().optional(),
  merchant: z.string().trim().max(80).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  tags: z.array(tag).max(10).optional(),
  locationName: z.string().trim().max(120).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  planId: uuid.nullable().optional(),
  excludeFromReports: z.boolean().optional(),
  attachmentIds: z.array(uuid).max(5).optional(),
  /// Produtos da fatura (null ou [] = tirar os que lá estavam)
  items: z.array(receiptItemSchema).max(80).nullable().optional(),
};

export const createTransactionSchema = z.object({ type: z.enum(TX_TYPES), ...baseTransaction });
export type CreateTransactionDto = z.infer<typeof createTransactionSchema>;

export const updateTransactionSchema = createTransactionSchema.partial();
export type UpdateTransactionDto = z.infer<typeof updateTransactionSchema>;

/// "a,b,c" → ['a','b','c'] (query string)
const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(item).max(100));

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/// Filtros dos movimentos (lista, resumo e exportação).
export const filterSchema = z.object({
  type: csv(z.enum(TX_TYPES)).optional(),
  accountIds: csv(uuid).optional(),
  /// "none" = sem categoria
  categoryIds: csv(z.union([uuid, z.literal('none')])).optional(),
  tags: csv(tag).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  minAmount: z.coerce.number().min(0).optional(),
  maxAmount: z.coerce.number().min(0).optional(),
  q: z.string().trim().max(80).optional(),
  hasAttachment: bool.optional(),
  planId: uuid.optional(),
  recurringOnly: bool.optional(),
  sort: z.enum(['date_desc', 'date_asc', 'amount_desc', 'amount_asc']).default('date_desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type TransactionFilters = z.infer<typeof filterSchema>;

export const savedFilterSchema = z.object({
  name: z.string().trim().min(1).max(40),
  filters: z.record(z.string(), z.unknown()),
});
