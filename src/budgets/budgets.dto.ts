import { z } from 'zod';
import { positiveMoney, uuid } from '../accounts/accounts.dto';

export const createBudgetSchema = z.object({
  name: z.string().trim().min(1).max(60),
  amount: positiveMoney,
  currency: z.string().trim().toUpperCase().length(3).optional(),
  period: z.enum(['WEEKLY', 'MONTHLY', 'YEARLY']).default('MONTHLY'),
  /// Vazio = todas as despesas (limite geral)
  categoryIds: z.array(uuid).max(50).default([]),
  alertThresholds: z.array(z.number().int().min(1).max(200)).min(0).max(4).optional(),
  rollover: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type CreateBudgetDto = z.infer<typeof createBudgetSchema>;

export const updateBudgetSchema = createBudgetSchema.partial();
export type UpdateBudgetDto = z.infer<typeof updateBudgetSchema>;
