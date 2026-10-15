import { z } from 'zod';
import { dateOnly, positiveMoney, uuid } from '../accounts/accounts.dto';

export const INVESTMENT_TYPES = ['STOCK', 'ETF', 'FUND', 'CRYPTO', 'BOND', 'DEPOSIT', 'REAL_ESTATE', 'OTHER'] as const;
const amount = z.number().finite().min(0).max(1e12);

export const createInvestmentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(INVESTMENT_TYPES).default('OTHER'),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  invested: amount.default(0),
  currentValue: amount.optional(),
  units: z.number().finite().min(0).max(1e12).nullable().optional(),
  expectedYield: z.number().finite().min(0).max(1000).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  accountId: uuid.nullable().optional(),
});
export type CreateInvestmentDto = z.infer<typeof createInvestmentSchema>;
export const updateInvestmentSchema = createInvestmentSchema.partial().extend({ isActive: z.boolean().optional() });
export type UpdateInvestmentDto = z.infer<typeof updateInvestmentSchema>;

export const dividendSchema = z.object({
  amount: positiveMoney,
  date: dateOnly,
  /// true = projeção (ainda não entrou)
  expected: z.boolean().default(false),
  note: z.string().trim().max(200).nullable().optional(),
  /// Registar o dividendo recebido como receita nesta conta
  accountId: uuid.nullable().optional(),
  categoryId: uuid.nullable().optional(),
});
export type DividendDto = z.infer<typeof dividendSchema>;

/// Projeção automática: X por mês (ou por trimestre) durante N meses.
export const projectDividendsSchema = z.object({
  amount: positiveMoney,
  every: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']).default('MONTHLY'),
  startDate: dateOnly,
  months: z.number().int().min(1).max(120).default(12),
});
export type ProjectDividendsDto = z.infer<typeof projectDividendsSchema>;
