import { addDays, DateOnly, nextOccurrence, occurrencesBetween } from '../common/utils/dates';
import { round2 } from '../common/utils/money';

export const DEPOSIT_FREQUENCIES = ['ONCE', 'WEEKLY', 'MONTHLY'] as const;
export type DepositFrequency = (typeof DEPOSIT_FREQUENCIES)[number];

/// O que interessa de um depósito planeado para fazer contas com datas.
export interface DepositSchedule {
  amount: number;
  frequency: string;
  startDate: DateOnly;
  /// A ocorrência por tratar (pode já ter passado: fica "em atraso")
  nextDate: DateOnly;
  endDate: DateOnly | null;
}

const repeats = (frequency: string): frequency is 'WEEKLY' | 'MONTHLY' => frequency === 'WEEKLY' || frequency === 'MONTHLY';

/// As datas de um depósito até `to`: a pendente (`nextDate`) e as seguintes,
/// contadas sempre a partir do início (um dia 31 não escorrega para 28).
export function depositDates(d: DepositSchedule, to: DateOnly, limit = 120): DateOnly[] {
  if (d.nextDate > to || (d.endDate && d.nextDate > d.endDate)) return [];
  if (!repeats(d.frequency)) return [d.nextDate];
  return [d.nextDate, ...occurrencesBetween(d.startDate, d.frequency, 1, addDays(d.nextDate, 1), to, d.endDate, limit - 1)];
}

/// A ocorrência a seguir a `after` — ou null quando o plano acaba ali
/// (depósito de uma só vez, ou passou da data de fim).
export function nextDepositDate(d: Pick<DepositSchedule, 'frequency' | 'startDate' | 'endDate'>, after: DateOnly): DateOnly | null {
  if (!repeats(d.frequency)) return null;
  const next = nextOccurrence(d.startDate, d.frequency, 1, after, false);
  return d.endDate && next > d.endDate ? null : next;
}

/// Quanto os depósitos que se repetem somam por mês.
export function plannedPerMonth(deposits: DepositSchedule[]): number {
  let total = 0;
  for (const d of deposits) {
    if (d.frequency === 'MONTHLY') total += d.amount;
    else if (d.frequency === 'WEEKLY') total += d.amount * 4.348125;
  }
  return round2(total);
}

/// "Com este plano chegas lá em…": junta os depósitos planeados por ordem
/// de data até cobrir o que falta. null = o plano não chega (até 20 anos).
export function projectedByPlan(remaining: number, deposits: DepositSchedule[], today: DateOnly): DateOnly | null {
  if (remaining <= 0) return today;
  const horizon = addDays(today, 365 * 20);
  const events: Array<{ date: DateOnly; amount: number }> = [];
  for (const d of deposits) {
    for (const date of depositDates(d, horizon, 1100)) events.push({ date: date < today ? today : date, amount: d.amount });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let left = remaining;
  for (const e of events) {
    left = round2(left - e.amount);
    if (left <= 0) return e.date;
  }
  return null;
}
