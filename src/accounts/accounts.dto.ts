import { z } from 'zod';

export const ACCOUNT_TYPES = ['BANK', 'CASH', 'SAVINGS', 'CREDIT_CARD', 'DIGITAL_WALLET', 'INVESTMENT', 'OTHER'] as const;
export const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
export const iconName = z.string().regex(/^[a-z0-9_]{1,40}$/);
export const moneyValue = z.number().finite().min(-1e12).max(1e12);
export const positiveMoney = z.number().finite().positive().max(1e12);
export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const uuid = z.string().uuid();

export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(ACCOUNT_TYPES),
  institution: z.string().trim().max(60).nullable().optional(),
  institutionId: uuid.nullable().optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  initialBalance: moneyValue.default(0),
  creditLimit: z.number().finite().min(0).max(1e12).nullable().optional(),
  color: hexColor.optional(),
  icon: iconName.optional(),
  includeInTotal: z.boolean().optional(),
});
export type CreateAccountDto = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  institution: z.string().trim().max(60).nullable().optional(),
  institutionId: uuid.nullable().optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  initialBalance: moneyValue.optional(),
  creditLimit: z.number().finite().min(0).max(1e12).nullable().optional(),
  color: hexColor.optional(),
  icon: iconName.optional(),
  includeInTotal: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type UpdateAccountDto = z.infer<typeof updateAccountSchema>;

export const adjustBalanceSchema = z.object({
  balance: moneyValue,
  date: dateOnly.optional(),
});

export const reorderSchema = z.object({ ids: z.array(uuid).max(500) });
