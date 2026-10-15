import { z } from 'zod';
import { uuid } from '../accounts/accounts.dto';

const monthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const amount = z.number().finite().min(0).max(1e12);

/// Enviar o meu plano de um mês a outra pessoa.
export const sendPlanSchema = z
  .object({
    /// O mês do meu plano que vai servir de modelo
    periodKey: monthKey,
    userId: uuid.optional(),
    username: z.string().trim().toLowerCase().min(1).max(40).optional(),
    note: z.string().trim().max(300).nullable().optional(),
    /// Mostrar também o meu rendimento planeado (por omissão não vai)
    includeIncome: z.boolean().default(false),
  })
  .refine((v) => !!v.userId || !!v.username, 'userId or username required');
export type SendPlanDto = z.infer<typeof sendPlanSchema>;

/// Quem acompanha os gastos de alguém propõe-lhe um plano, feito com as
/// categorias dessa pessoa.
export const proposePlanSchema = z.object({
  periodKey: monthKey.optional(),
  plannedSavings: amount.default(0),
  note: z.string().trim().max(300).nullable().optional(),
  lines: z
    .array(
      z
        .object({
          /// Categoria de despesa de quem recebe a proposta
          categoryId: uuid.nullable().optional(),
          /// Linha livre (ex.: "Prendas")
          name: z.string().trim().max(60).nullable().optional(),
          amount,
        })
        .refine((l) => !!l.categoryId || !!l.name, 'categoryId or name required'),
    )
    .min(1)
    .max(60),
});
export type ProposePlanDto = z.infer<typeof proposePlanSchema>;

export const acceptPlanOfferSchema = z.object({
  /// O mês em que passo a usar o plano (por omissão, o mês atual)
  periodKey: monthKey.optional(),
});
export type AcceptPlanOfferDto = z.infer<typeof acceptPlanOfferSchema>;
