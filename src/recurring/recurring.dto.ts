import { z } from 'zod';
import { dateOnly, positiveMoney, uuid } from '../accounts/accounts.dto';
import { TX_TYPES } from '../transactions/transactions.dto';

export const RECURRING_KINDS = ['BILL', 'SUBSCRIPTION', 'SALARY', 'RENT', 'LOAN', 'INSURANCE', 'OTHER'] as const;

export const createRecurringSchema = z.object({
  type: z.enum(TX_TYPES),
  amount: positiveMoney,
  accountId: uuid,
  toAccountId: uuid.nullable().optional(),
  categoryId: uuid.nullable().optional(),
  description: z.string().trim().min(1).max(80),
  merchant: z.string().trim().max(80).nullable().optional(),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  interval: z.number().int().min(1).max(24).default(1),
  startDate: dateOnly,
  endDate: dateOnly.nullable().optional(),
  autoCreate: z.boolean().default(true),
  remindDaysBefore: z.number().int().min(0).max(30).default(1),
  kind: z.enum(RECURRING_KINDS).default('OTHER'),
  isActive: z.boolean().optional(),
});
export type CreateRecurringDto = z.infer<typeof createRecurringSchema>;

export const updateRecurringSchema = createRecurringSchema.partial();
export type UpdateRecurringDto = z.infer<typeof updateRecurringSchema>;

export const payRecurringSchema = z.object({
  date: dateOnly.optional(),
  amount: positiveMoney.optional(),
});
