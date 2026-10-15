import { z } from 'zod';
import { uuid } from '../accounts/accounts.dto';

const amount = z.number().finite().min(0).max(1e12);

export const monthlyPlanLineSchema = z
  .object({
    /// Categoria de despesa (o "real" vem dos movimentos dessa categoria)
    categoryId: uuid.nullable().optional(),
    /// Objetivo para onde vai este dinheiro (o "real" vem do que lá puseste)
    goalId: uuid.nullable().optional(),
    /// Linha livre (ex.: "Prendas") — entra no planeado, sem "real"
    name: z.string().trim().max(60).nullable().optional(),
    amount,
    /// A linha tem "o que vou comprar"? true/false = escolha da pessoa · null = decide-se pela
    /// categoria · sem o campo = fica como estava
    list: z.boolean().nullable().optional(),
  })
  .refine((l) => !!l.categoryId || !!l.goalId || !!l.name, 'categoryId, goalId or name required');

export const monthlyPlanSchema = z.object({
  plannedIncome: amount,
  plannedSavings: amount.default(0),
  note: z.string().trim().max(500).nullable().optional(),
  lines: z.array(monthlyPlanLineSchema).max(60).default([]),
});
export type MonthlyPlanDto = z.infer<typeof monthlyPlanSchema>;

export const monthlyPlanLineFlagsSchema = z.object({ list: z.boolean().nullable() });
export type MonthlyPlanLineFlagsDto = z.infer<typeof monthlyPlanLineFlagsSchema>;
