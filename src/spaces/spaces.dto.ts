import { z } from 'zod';
import { dateOnly, hexColor, iconName, positiveMoney, uuid } from '../accounts/accounts.dto';

export const SPACE_TYPES = ['HOUSEHOLD', 'COUPLE', 'TRIP', 'FRIENDS', 'PROJECT', 'OTHER'] as const;

export const createSpaceSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(SPACE_TYPES).default('OTHER'),
  description: z.string().trim().max(300).nullable().optional(),
  icon: iconName.optional(),
  color: hexColor.optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
});
export type CreateSpaceDto = z.infer<typeof createSpaceSchema>;

/// Privilégios de um Space (só o dono os muda).
export const privilegesSchema = z.object({
  /// Quem pode convidar: ALL (qualquer membro) | ADMINS
  inviteBy: z.enum(['ALL', 'ADMINS']).optional(),
  /// Quem pode registar despesas: ALL | ADMINS
  expensesBy: z.enum(['ALL', 'ADMINS']).optional(),
  /// Quem pode mudar/apagar despesas: OWN (quem registou ou pagou, e os admins) | ADMINS
  editBy: z.enum(['OWN', 'ADMINS']).optional(),
});

const rolePrivileges = z.object({ invite: z.boolean(), addExpense: z.boolean(), editOwn: z.boolean(), editAny: z.boolean(), fund: z.boolean(), goals: z.boolean(), plan: z.boolean(), chat: z.boolean(), manageMembers: z.boolean() }).partial();
export const privilegesMatrixSchema = z.object({ ADMIN: rolePrivileges.optional(), MEMBER: rolePrivileges.optional() });

export const updateSpaceSchema = z.object({
  privileges: privilegesMatrixSchema.optional(),
  name: z.string().trim().min(1).max(60).optional(),
  type: z.enum(SPACE_TYPES).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  icon: iconName.optional(),
  color: hexColor.optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  ...privilegesSchema.shape,
});
export type UpdateSpaceDto = z.infer<typeof updateSpaceSchema>;

export const inviteSchema = z
  .object({
    username: z.string().trim().toLowerCase().min(1).max(40).optional(),
    email: z.string().trim().toLowerCase().email().max(160).optional(),
  })
  .refine((v) => !!v.username || !!v.email, 'username or email required');
export type InviteDto = z.infer<typeof inviteSchema>;

/// O código pode vir como a pessoa o escreveu: com espaços, hífenes ou em minúsculas.
export const joinSchema = z.object({
  code: z
    .string()
    .max(40)
    .transform((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .pipe(z.string().min(4).max(16)),
});

export const roleSchema = z.object({ role: z.enum(['OWNER', 'ADMIN', 'MEMBER']) });

export const expenseSchema = z.object({
  title: z.string().trim().min(1).max(100),
  amount: positiveMoney,
  date: dateOnly.optional(),
  paidById: uuid.optional(),
  splitMethod: z.enum(['EQUAL', 'EXACT', 'PERCENT', 'SHARES']).default('EQUAL'),
  /// Quem entra na divisão (vazio = todos os membros, em partes iguais)
  participants: z.array(z.object({ userId: uuid, value: z.number().finite().min(0).max(1e12).nullable().optional() })).max(100).optional(),
  categoryKey: z.string().trim().max(30).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  attachmentIds: z.array(uuid).max(5).optional(),
  /// Registar a minha parte também nas minhas despesas pessoais
  addToMyExpenses: z.object({ accountId: uuid, categoryId: uuid.nullable().optional() }).nullable().optional(),
  /// Paga com o fundo comum do Space (em vez de por um membro)
  fromPot: z.boolean().optional(),
});
export type ExpenseDto = z.infer<typeof expenseSchema>;

export const updateExpenseSchema = expenseSchema.partial().omit({ addToMyExpenses: true, fromPot: true });
export type UpdateExpenseDto = z.infer<typeof updateExpenseSchema>;

export const settlementSchema = z.object({
  fromUserId: uuid.optional(),
  toUserId: uuid,
  amount: positiveMoney,
  date: dateOnly.optional(),
  note: z.string().trim().max(200).nullable().optional(),
});
export type SettlementDto = z.infer<typeof settlementSchema>;

// ------------------------------------------------------------------
// Plano em grupo: fundo comum, metas e plano de gastos
// ------------------------------------------------------------------

/// Pôr dinheiro no fundo comum do Space (opcionalmente para uma meta).
export const depositSchema = z.object({
  amount: positiveMoney,
  date: dateOnly.optional(),
  note: z.string().trim().max(200).nullable().optional(),
  goalId: uuid.nullable().optional(),
  /// Registar também na minha conta pessoal (sai de lá ao depositar)
  accountId: uuid.nullable().optional(),
  categoryId: uuid.nullable().optional(),
});
export type DepositDto = z.infer<typeof depositSchema>;

/// Tirar do fundo a minha parte (com `accountId`, entra na minha conta pessoal).
export const withdrawSchema = z.object({
  amount: positiveMoney,
  date: dateOnly.optional(),
  note: z.string().trim().max(200).nullable().optional(),
  accountId: uuid.nullable().optional(),
});
export type WithdrawDto = z.infer<typeof withdrawSchema>;

export const spaceGoalSchema = z.object({
  name: z.string().trim().min(1).max(60),
  targetAmount: positiveMoney,
  targetDate: dateOnly.nullable().optional(),
  icon: iconName.optional(),
  color: hexColor.optional(),
});
export type SpaceGoalDto = z.infer<typeof spaceGoalSchema>;

export const updateSpaceGoalSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  targetAmount: positiveMoney.optional(),
  targetDate: dateOnly.nullable().optional(),
  icon: iconName.optional(),
  color: hexColor.optional(),
  /// ARCHIVED = guardar (deixa de aparecer para depositar); ACTIVE = reabrir
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});
export type UpdateSpaceGoalDto = z.infer<typeof updateSpaceGoalSchema>;

/// O plano do grupo: quanto se quer gastar em cada categoria (ou linha livre).
export const spacePlanSchema = z.object({
  lines: z
    .array(
      z
        .object({
          categoryKey: z.string().trim().max(30).nullable().optional(),
          title: z.string().trim().max(60).nullable().optional(),
          amount: z.number().finite().min(0).max(1e12),
        })
        .refine((l) => !!l.categoryKey || !!l.title, 'categoryKey or title required'),
    )
    .max(60),
});
export type SpacePlanDto = z.infer<typeof spacePlanSchema>;
