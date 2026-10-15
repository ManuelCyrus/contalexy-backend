import { z } from 'zod';
import { dateOnly, uuid } from '../accounts/accounts.dto';

/// O que se pode enviar a outra pessoa como modelo.
export const OFFER_KINDS = ['GOAL', 'PLAN', 'BUDGET'] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

const monthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const sendItemSchema = z
  .object({
    kind: z.enum(OFFER_KINDS),
    /// O meu objetivo, plano ou limite que vai servir de modelo
    itemId: uuid,
    userId: uuid.optional(),
    username: z.string().trim().toLowerCase().min(1).max(40).optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => !!v.userId || !!v.username, 'userId or username required');
export type SendItemDto = z.infer<typeof sendItemSchema>;

/// Quem aceita ajusta à sua vida: o nome, as datas (objetivos) ou o mês (planos).
export const acceptItemSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /// Objetivos: quando começo e até quando quero chegar
  startDate: dateOnly.nullable().optional(),
  targetDate: dateOnly.nullable().optional(),
  /// Planos: o mês a que o plano fica ligado (null = sem mês)
  periodKey: monthKey.nullable().optional(),
});
export type AcceptItemDto = z.infer<typeof acceptItemSchema>;
