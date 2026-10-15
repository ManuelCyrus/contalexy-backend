import { z } from 'zod';
import { round2 } from '../common/utils/money';

/// Calculadora de poupança: contas certas, sem IA. A IA só explica o
/// resultado se a pessoa pedir (assistente).
export const savingsSimSchema = z.object({
  /// O que já está guardado
  initial: z.number().finite().min(0).max(1e12).default(0),
  /// Quanto se põe por mês
  monthly: z.number().finite().min(0).max(1e12).default(0),
  /// Taxa anual em % (juros ou rendimento esperado); 0 = só poupança
  annualRatePercent: z.number().finite().min(-100).max(1000).default(0),
  /// Quantos meses
  months: z.number().int().min(1).max(600).default(12),
  /// Meta (opcional): quando se chega lá
  target: z.number().finite().positive().max(1e12).optional(),
  /// Subir a mensalidade X % por ano (opcional)
  yearlyIncreasePercent: z.number().finite().min(0).max(100).optional(),
  /// Imposto sobre os juros em % (ex.: 28 em Portugal)
  taxPercent: z.number().finite().min(0).max(100).optional(),
});
export type SavingsSimDto = z.infer<typeof savingsSimSchema>;

export function simulateSavings(dto: SavingsSimDto) {
  const monthlyRate = Math.pow(1 + dto.annualRatePercent / 100, 1 / 12) - 1;
  const tax = (dto.taxPercent ?? 0) / 100;
  let balance = dto.initial;
  let deposit = dto.monthly;
  let totalDeposits = dto.initial;
  let totalInterest = 0;
  let totalTax = 0;
  let targetMonth: number | null = dto.target !== undefined && balance >= dto.target ? 0 : null;
  const schedule: { month: number; deposit: number; interest: number; balance: number }[] = [];
  for (let m = 1; m <= dto.months; m += 1) {
    if (dto.yearlyIncreasePercent && m > 1 && (m - 1) % 12 === 0) deposit = deposit * (1 + dto.yearlyIncreasePercent / 100);
    const gross = balance * monthlyRate;
    const net = gross - (gross > 0 ? gross * tax : 0);
    totalTax += gross > 0 ? gross * tax : 0;
    totalInterest += net;
    balance = balance + net + deposit;
    totalDeposits += deposit;
    if (targetMonth === null && dto.target !== undefined && balance >= dto.target) targetMonth = m;
    if (m <= 120 || m % 12 === 0 || m === dto.months) schedule.push({ month: m, deposit: round2(deposit), interest: round2(net), balance: round2(balance) });
  }
  // Para chegar à meta no prazo: quanto pôr por mês (anuidade), sem subida.
  let monthlyForTarget: number | null = null;
  if (dto.target !== undefined) {
    const n = dto.months;
    const growth = Math.pow(1 + monthlyRate * (1 - tax), n);
    const r = monthlyRate * (1 - tax);
    const needed = r === 0 ? (dto.target - dto.initial) / n : (dto.target - dto.initial * growth) * r / (growth - 1);
    monthlyForTarget = round2(Math.max(0, needed));
  }
  return {
    finalBalance: round2(balance),
    totalDeposits: round2(totalDeposits),
    totalInterest: round2(totalInterest),
    totalTax: round2(totalTax),
    monthlyRatePercent: round2(monthlyRate * 100 * 1000) / 1000,
    /// Em que mês se chega à meta (null = não se chega no prazo)
    targetMonth,
    /// O que seria preciso pôr por mês para chegar à meta no prazo
    monthlyForTarget,
    schedule,
  };
}

/// "Quanto tempo até…": meses até à meta (até 600) com estes depósitos.
export function monthsToTarget(initial: number, monthly: number, annualRatePercent: number, target: number): number | null {
  const r = Math.pow(1 + annualRatePercent / 100, 1 / 12) - 1;
  let balance = initial;
  for (let m = 1; m <= 600; m += 1) {
    balance = balance * (1 + r) + monthly;
    if (balance >= target) return m;
  }
  return null;
}
