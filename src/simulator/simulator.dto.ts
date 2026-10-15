import { z } from 'zod';
import { dateOnly, positiveMoney, uuid } from '../accounts/accounts.dto';

/// "E se eu comprar isto?"
export const purchaseSimSchema = z.object({
  amount: positiveMoney,
  name: z.string().trim().max(80).optional(),
  /// 0 (ou vazio) = comprar agora; 2 = "e se for daqui a 2 meses?"
  monthsFromNow: z.number().int().min(0).max(12).optional(),
  /// "E se eu guardar X por mês para isto?"
  monthlySaving: positiveMoney.optional(),
  /// Quanto já tenho guardado para esta compra
  alreadySaved: z.number().finite().min(0).max(1e12).optional(),
});
export type PurchaseSimDto = z.infer<typeof purchaseSimSchema>;

/// "Quanto tempo demoro a juntar X?" — para um objetivo que já existe
/// (goalId) ou para uma ideia (targetAmount).
export const goalSimSchema = z
  .object({
    goalId: uuid.optional(),
    targetAmount: positiveMoney.optional(),
    saved: z.number().finite().min(0).max(1e12).optional(),
    monthlySaving: positiveMoney.optional(),
    targetDate: dateOnly.optional(),
    /// "E se aparecer uma despesa inesperada de X?"
    unexpectedExpense: positiveMoney.optional(),
  })
  .refine((v) => !!v.goalId || v.targetAmount !== undefined, 'goalId or targetAmount required');
export type GoalSimDto = z.infer<typeof goalSimSchema>;

/// Projeção de vários meses com "e se…".
export const forecastSimSchema = z.object({
  months: z.number().int().min(1).max(36).default(6),
  incomeChangePercent: z.number().finite().min(-100).max(500).optional(),
  expenseChangePercent: z.number().finite().min(-100).max(500).optional(),
  extraMonthlySaving: z.number().finite().min(0).max(1e12).optional(),
  /// Gastos (positivo) ou entradas (negativo) pontuais: month 0 = este mês
  oneOffs: z
    .array(z.object({ month: z.number().int().min(0).max(36), amount: z.number().finite().min(-1e12).max(1e12), name: z.string().trim().max(60).optional() }))
    .max(12)
    .optional(),
});
export type ForecastSimDto = z.infer<typeof forecastSimSchema>;
