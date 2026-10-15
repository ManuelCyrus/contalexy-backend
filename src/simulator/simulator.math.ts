import { round2 } from '../common/utils/money';

/// As contas do simulador, sem base de dados (fáceis de testar).

export interface Baseline {
  /// Dinheiro disponível agora (contas correntes, dinheiro, carteiras)
  available: number;
  /// O que ainda falta acontecer até ao fim deste mês
  restIncome: number;
  restExpenses: number;
  restSavings: number;
  /// Um mês "normal"
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlySavings: number;
}

export interface Adjustments {
  /// +10 = receber 10% mais; −20 = receber 20% menos (a partir do próximo mês)
  incomeChangePercent?: number;
  expenseChangePercent?: number;
  /// Poupar mais X por mês (a partir do próximo mês)
  extraMonthlySaving?: number;
}

/// Um gasto (positivo) ou uma entrada (negativo) num mês: 0 = este mês.
export interface OneOff {
  month: number;
  amount: number;
}

export interface MonthPoint {
  index: number;
  income: number;
  expenses: number;
  savings: number;
  /// Gastos pontuais desse mês (compras simuladas, empréstimos a devolver…)
  oneOff: number;
  /// Dinheiro livre no fim do mês
  free: number;
  /// Poupança acumulada desde hoje
  savedTotal: number;
}

/// Mês a mês: o dinheiro livre no fim de cada mês (índice 0 = este mês).
export function projectMonths(b: Baseline, months: number, oneOffs: OneOff[] = [], adj: Adjustments = {}): MonthPoint[] {
  const out: MonthPoint[] = [];
  let free = b.available;
  let savedTotal = 0;
  const income = Math.max(0, b.monthlyIncome * (1 + (adj.incomeChangePercent ?? 0) / 100));
  const expenses = Math.max(0, b.monthlyExpenses * (1 + (adj.expenseChangePercent ?? 0) / 100));
  const savings = Math.max(0, b.monthlySavings + (adj.extraMonthlySaving ?? 0));
  for (let i = 0; i <= months; i++) {
    const m = i === 0 ? { income: b.restIncome, expenses: b.restExpenses, savings: b.restSavings } : { income, expenses, savings };
    const oneOff = oneOffs.filter((o) => o.month === i).reduce((acc, o) => acc + o.amount, 0);
    free = free + m.income - m.expenses - m.savings - oneOff;
    savedTotal += m.savings;
    out.push({ index: i, income: round2(m.income), expenses: round2(m.expenses), savings: round2(m.savings), oneOff: round2(oneOff), free: round2(free), savedTotal: round2(savedTotal) });
  }
  return out;
}

/// OK = cabe com folga · TIGHT = cabe à justa · AFFECTS_GOALS = só cabe se
/// poupar menos do que o planeado · NOT_AFFORDABLE = compromete as despesas.
export type Verdict = 'OK' | 'TIGHT' | 'AFFECTS_GOALS' | 'NOT_AFFORDABLE';

export function verdictFor(remaining: number, plannedSavings: number, cushion: number): Verdict {
  if (remaining >= 0) return remaining >= cushion ? 'OK' : 'TIGHT';
  return remaining + plannedSavings >= 0 ? 'AFFECTS_GOALS' : 'NOT_AFFORDABLE';
}

/// Quantos meses a pôr `monthly` de lado até juntar `amount` (null = nunca).
export function monthsToSave(amount: number, monthly: number): number | null {
  if (amount <= 0.005) return 0;
  if (monthly <= 0) return null;
  return Math.ceil((amount - 0.005) / monthly);
}

/// Um número "redondo" perto de `value` (para sugestões).
export function niceRound(value: number): number {
  if (value <= 0) return 0;
  const step = value < 20 ? 1 : value < 100 ? 5 : value < 1000 ? 10 : value < 10000 ? 50 : 100;
  return Math.max(step, Math.round(value / step) * step);
}

/// Valores à volta de `base` para comparar ("e se guardar mais?").
export function savingScenarios(base: number, exact?: number | null): number[] {
  const values = [0.5, 1, 1.5, 2].map((f) => niceRound(base * f));
  if (exact && exact > 0) values.push(round2(exact));
  return [...new Set(values.filter((v) => v > 0))].sort((a, b) => a - b);
}

/// Variação em % (null se não houver base de comparação).
export function percentChange(current: number, reference: number): number | null {
  if (reference <= 0) return null;
  return round2(((current - reference) / reference) * 100);
}
