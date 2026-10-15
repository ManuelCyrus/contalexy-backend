import { z } from 'zod';
import { dateOnly, hexColor, iconName, moneyValue, positiveMoney, uuid } from '../accounts/accounts.dto';
import { DEPOSIT_FREQUENCIES } from './deposits';

/// Objetivo específico dentro de um objetivo: uma parte do caminho, com ou sem valor e data.
export const goalStepSchema = z.object({
  title: z.string().trim().min(1).max(120),
  amount: z.number().finite().min(0).max(1e12).nullable().optional(),
  dueDate: dateOnly.nullable().optional(),
  done: z.boolean().optional(),
});
export type GoalStepDto = z.infer<typeof goalStepSchema>;

export const updateGoalStepSchema = goalStepSchema.partial().extend({ sortOrder: z.number().int().min(0).max(1000).optional() });
export type UpdateGoalStepDto = z.infer<typeof updateGoalStepSchema>;

/// Quantos objetivos específicos cabem num objetivo.
export const GOAL_STEPS_MAX = 30;

export const createGoalSchema = z.object({
  name: z.string().trim().min(1).max(60),
  targetAmount: positiveMoney,
  currency: z.string().trim().toUpperCase().length(3).optional(),
  /// Quando se começa a juntar (por omissão, hoje) e até quando se quer chegar
  startDate: dateOnly.nullable().optional(),
  targetDate: dateOnly.nullable().optional(),
  /// Objetivos específicos logo à partida
  steps: z.array(goalStepSchema).max(GOAL_STEPS_MAX).optional(),
  icon: iconName.optional(),
  color: hexColor.optional(),
  accountId: uuid.nullable().optional(),
  /// Já tenho X guardado (primeira contribuição)
  initialAmount: z.number().finite().min(0).max(1e12).optional(),
  /// Fixar no Início
  pinned: z.boolean().optional(),
});
export type CreateGoalDto = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  targetAmount: positiveMoney.optional(),
  startDate: dateOnly.nullable().optional(),
  targetDate: dateOnly.nullable().optional(),
  icon: iconName.optional(),
  color: hexColor.optional(),
  accountId: uuid.nullable().optional(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'ARCHIVED']).optional(),
  pinned: z.boolean().optional(),
});
export type UpdateGoalDto = z.infer<typeof updateGoalSchema>;

export const contributionSchema = z.object({
  /// Negativo = retirar
  amount: moneyValue.refine((v) => v !== 0, 'amount must not be 0'),
  date: dateOnly.optional(),
  note: z.string().trim().max(200).nullable().optional(),
});
export type ContributionDto = z.infer<typeof contributionSchema>;

/// Depósito planeado: "no dia X vou pôr Y" (ONCE) ou "todas as semanas /
/// todos os meses passo a pôr Y" a partir de `date`.
export const depositSchema = z.object({
  amount: positiveMoney,
  frequency: z.enum(DEPOSIT_FREQUENCIES).optional(),
  date: dateOnly,
  /// Só para os que se repetem: até quando
  endDate: dateOnly.nullable().optional(),
  /// true = no dia entra sozinho no objetivo; false = só lembra
  autoApply: z.boolean().optional(),
  note: z.string().trim().max(200).nullable().optional(),
});
export type DepositDto = z.infer<typeof depositSchema>;

export const updateDepositSchema = z.object({
  amount: positiveMoney.optional(),
  frequency: z.enum(DEPOSIT_FREQUENCIES).optional(),
  date: dateOnly.optional(),
  endDate: dateOnly.nullable().optional(),
  autoApply: z.boolean().optional(),
  note: z.string().trim().max(200).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateDepositDto = z.infer<typeof updateDepositSchema>;

/// "Depositei": por omissão, o valor e o dia planeados.
export const confirmDepositSchema = z.object({ amount: positiveMoney.optional(), date: dateOnly.optional() });
export type ConfirmDepositDto = z.infer<typeof confirmDepositSchema>;
