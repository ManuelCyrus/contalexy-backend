import { z } from 'zod';
import { dateOnly, positiveMoney, uuid } from '../accounts/accounts.dto';

const remindDays = z.array(z.number().int().min(1).max(90)).max(5);

/// A outra pessoa, quando também usa o Contalexy (pelo id ou pelo @username).
const counterpart = {
  counterpartId: uuid.nullable().optional(),
  counterpartUsername: z.string().trim().toLowerCase().min(1).max(40).nullable().optional(),
};

export const createLoanSchema = z.object({
  /// LENT = emprestei (devem-me) · BORROWED = pedi emprestado (devo)
  direction: z.enum(['LENT', 'BORROWED']),
  /// Dispensável quando se liga a uma pessoa (fica o nome dela)
  personName: z.string().trim().min(1).max(60).optional(),
  ...counterpart,
  amount: positiveMoney,
  currency: z.string().trim().toUpperCase().length(3).optional(),
  date: dateOnly.optional(),
  dueDate: dateOnly.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  /// Conta de onde saiu / onde entrou o dinheiro
  accountId: uuid.nullable().optional(),
  /// Registar também o movimento nessa conta (para o saldo bater certo)
  registerTransaction: z.boolean().optional(),
  /// Avisar X dias antes (ex.: [7, 1]); [] = sem avisos antes
  remindDaysBefore: remindDays.optional(),
  remindOnDue: z.boolean().optional(),
  remindOverdue: z.boolean().optional(),
  pinned: z.boolean().optional(),
});
export type CreateLoanDto = z.infer<typeof createLoanSchema>;

export const updateLoanSchema = z.object({
  personName: z.string().trim().min(1).max(60).optional(),
  amount: positiveMoney.optional(),
  date: dateOnly.optional(),
  dueDate: dateOnly.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  remindDaysBefore: remindDays.optional(),
  remindOnDue: z.boolean().optional(),
  remindOverdue: z.boolean().optional(),
  pinned: z.boolean().optional(),
  /// CANCELLED = perdoado/anulado; OPEN = reabrir
  status: z.enum(['OPEN', 'CANCELLED']).optional(),
});
export type UpdateLoanDto = z.infer<typeof updateLoanSchema>;

export const loanPaymentSchema = z.object({
  amount: positiveMoney,
  date: dateOnly.optional(),
  note: z.string().trim().max(200).nullable().optional(),
  /// Registar o movimento nesta conta (entrada se me devolveram, saída se devolvi)
  accountId: uuid.nullable().optional(),
});
export type LoanPaymentDto = z.infer<typeof loanPaymentSchema>;

/// Ligar um empréstimo à conta da outra pessoa.
export const linkLoanSchema = z.object(counterpart).refine((v) => !!v.counterpartId || !!v.counterpartUsername, 'counterpart required');
export type LinkLoanDto = z.infer<typeof linkLoanSchema>;

/// Aceitar um empréstimo ligado; com `accountId`, regista-se logo o dinheiro nessa conta.
export const acceptLoanSchema = z.object({ accountId: uuid.nullable().optional() });

/// Um lembrete à outra pessoa (num empréstimo ligado), com uma frase opcional.
export const loanNudgeSchema = z.object({ message: z.string().trim().max(200).optional() });
export type LoanNudgeDto = z.infer<typeof loanNudgeSchema>;
export type AcceptLoanDto = z.infer<typeof acceptLoanSchema>;
