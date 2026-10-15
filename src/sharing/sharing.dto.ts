import { z } from 'zod';
import { dateOnly, uuid } from '../accounts/accounts.dto';
import { HELP_SECTIONS } from './help';

/// SUMMARY = totais, categorias, plano e limites · FULL = também os movimentos
export const SHARE_SCOPES = ['SUMMARY', 'FULL'] as const;

/// O que se pode mostrar a quem acompanha. Cada secção liga-se e desliga-se à parte:
/// income (o que entra) · plan (plano do mês, este e os passados) · budgets (limites) ·
/// goals (objetivos) · transactions (a lista de movimentos) · plans (planos: viagem,
/// compras…) · recurring (despesas fixas)
export const SHARE_SECTIONS = ['income', 'plan', 'budgets', 'goals', 'transactions', 'plans', 'recurring'] as const;
export type ShareSection = (typeof SHARE_SECTIONS)[number];

/// O que cada âmbito mostra à partida ("Resumo" e "Tudo").
export const SECTION_PRESETS: Record<(typeof SHARE_SCOPES)[number], ShareSection[]> = {
  SUMMARY: ['income', 'plan', 'budgets', 'goals'],
  FULL: [...SHARE_SECTIONS],
};

const sections = z.array(z.enum(SHARE_SECTIONS)).max(SHARE_SECTIONS.length);
/// "Mostrar tudo exceto": categorias que ficam de fora de tudo
const hiddenCategoryIds = z.array(uuid).max(100);
/// Onde quem acompanha também pode ajudar a gerir (alterar)
const manage = z.array(z.enum(HELP_SECTIONS)).max(HELP_SECTIONS.length);

export const shareInviteSchema = z
  .object({
    username: z.string().trim().toLowerCase().min(1).max(40).optional(),
    email: z.string().trim().toLowerCase().email().max(160).optional(),
    scope: z.enum(SHARE_SCOPES).default('SUMMARY'),
    /// Por omissão, o que o `scope` indica
    sections: sections.optional(),
    hiddenCategoryIds: hiddenCategoryIds.optional(),
    manage: manage.optional(),
  })
  .refine((v) => !!v.username || !!v.email, 'username or email required');
export type ShareInviteDto = z.infer<typeof shareInviteSchema>;

export const shareUpdateSchema = z
  .object({ scope: z.enum(SHARE_SCOPES).optional(), sections: sections.optional(), hiddenCategoryIds: hiddenCategoryIds.optional(), manage: manage.optional() })
  .refine((v) => v.scope !== undefined || v.sections !== undefined || v.hiddenCategoryIds !== undefined || v.manage !== undefined, 'nothing to change');
export type ShareUpdateDto = z.infer<typeof shareUpdateSchema>;

/// Filtros da lista de movimentos de quem partilha.
export const sharedTransactionsSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  /// Em vez do mês: um intervalo à escolha
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  categoryId: uuid.optional(),
  type: z.enum(['INCOME', 'EXPENSE']).optional(),
  q: z.string().trim().min(1).max(60).optional(),
  minAmount: z.coerce.number().finite().min(0).optional(),
  maxAmount: z.coerce.number().finite().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type SharedTransactionsQuery = z.infer<typeof sharedTransactionsSchema>;

export const shareNoteSchema = z.object({ text: z.string().trim().min(1).max(600) });
