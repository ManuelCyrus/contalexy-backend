/// Datas "só dia" (YYYY-MM-DD). Na base de dados são @db.Date (o Prisma
/// entrega-as como Date à meia-noite UTC). Aqui faz-se tudo em texto
/// YYYY-MM-DD e UTC, sem surpresas de fuso horário.

export type DateOnly = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateOnly(value: unknown): value is DateOnly {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/// "2026-10-01" → Date (meia-noite UTC) para guardar num campo @db.Date.
export function toDbDate(value: DateOnly): Date {
  const m = DATE_RE.exec(value);
  if (!m) throw new Error(`Data inválida: ${value}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

/// Date (de um campo @db.Date ou qualquer instante) → "YYYY-MM-DD" (UTC).
export function fromDbDate(date: Date): DateOnly {
  return date.toISOString().slice(0, 10);
}

export function fromDbDateOrNull(date: Date | null | undefined): DateOnly | null {
  return date ? fromDbDate(date) : null;
}

/// O dia de hoje no fuso da pessoa.
export function todayIn(timezone: string, now: Date = new Date()): DateOnly {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return fromDbDate(now);
  }
}

function parts(d: DateOnly): [number, number, number] {
  const m = DATE_RE.exec(d);
  if (!m) throw new Error(`Data inválida: ${d}`);
  return [+m[1], +m[2], +m[3]];
}

function make(y: number, m: number, d: number): DateOnly {
  return fromDbDate(new Date(Date.UTC(y, m - 1, d)));
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(d: DateOnly, n: number): DateOnly {
  const [y, m, day] = parts(d);
  return make(y, m, day + n);
}

/// Soma meses mantendo o dia "âncora" (31 → 28/29 em fevereiro → 31 em março).
export function addMonths(d: DateOnly, n: number, anchorDay?: number): DateOnly {
  const [y, m, day] = parts(d);
  const anchor = anchorDay ?? day;
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return make(ny, nm, Math.min(anchor, daysInMonth(ny, nm)));
}

export function addYears(d: DateOnly, n: number): DateOnly {
  const [y, m, day] = parts(d);
  return make(y + n, m, Math.min(day, daysInMonth(y + n, m)));
}

export function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((toDbDate(to).getTime() - toDbDate(from).getTime()) / 86_400_000);
}

export function compareDates(a: DateOnly, b: DateOnly): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const minDate = (a: DateOnly, b: DateOnly) => (a < b ? a : b);
export const maxDate = (a: DateOnly, b: DateOnly) => (a > b ? a : b);

/// 1 = segunda … 7 = domingo
export function isoWeekday(d: DateOnly): number {
  const wd = toDbDate(d).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function startOfWeek(d: DateOnly, weekStartsOn = 1): DateOnly {
  const diff = (isoWeekday(d) - weekStartsOn + 7) % 7;
  return addDays(d, -diff);
}

export function monthKey(d: DateOnly): string {
  return d.slice(0, 7);
}

export function startOfMonth(d: DateOnly): DateOnly {
  return `${d.slice(0, 7)}-01`;
}

export function endOfMonth(d: DateOnly): DateOnly {
  const [y, m] = parts(d);
  return make(y, m, daysInMonth(y, m));
}

export interface Period {
  start: DateOnly;
  /// Último dia (inclusivo)
  end: DateOnly;
  key: string;
}

/// O "mês financeiro" que contém `today`, a começar no dia `startDay`
/// (ex.: o dia do salário). startDay 1 = mês normal.
export function financialMonth(today: DateOnly, startDay = 1): Period {
  const [y, m, d] = parts(today);
  const clampedThis = Math.min(startDay, daysInMonth(y, m));
  let start: DateOnly;
  if (d >= clampedThis) {
    start = make(y, m, clampedThis);
  } else {
    const prev = addMonths(make(y, m, 1), -1);
    const [py, pm] = parts(prev);
    start = make(py, pm, Math.min(startDay, daysInMonth(py, pm)));
  }
  const nextStart = addMonths(start, 1, startDay);
  return { start, end: addDays(nextStart, -1), key: monthKey(start) };
}

export type PeriodKind = 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export function periodContaining(kind: PeriodKind, today: DateOnly, opts: { monthStartDay?: number; weekStartsOn?: number } = {}): Period {
  if (kind === 'WEEKLY') {
    const start = startOfWeek(today, opts.weekStartsOn ?? 1);
    return { start, end: addDays(start, 6), key: `W:${start}` };
  }
  if (kind === 'YEARLY') {
    const y = today.slice(0, 4);
    return { start: `${y}-01-01`, end: `${y}-12-31`, key: y };
  }
  return financialMonth(today, opts.monthStartDay ?? 1);
}

/// O período anterior ao que contém `today`.
export function previousPeriod(kind: PeriodKind, today: DateOnly, opts: { monthStartDay?: number; weekStartsOn?: number } = {}): Period {
  const current = periodContaining(kind, today, opts);
  return periodContaining(kind, addDays(current.start, -1), opts);
}

export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

/// A n-ésima ocorrência (0 = a primeira) contada SEMPRE a partir do
/// início — assim um dia 31 não "escorrega" para 28 para sempre.
export function occurrenceAt(start: DateOnly, frequency: RecurrenceFrequency, interval: number, n: number): DateOnly {
  const step = Math.max(1, interval) * n;
  switch (frequency) {
    case 'DAILY':
      return addDays(start, step);
    case 'WEEKLY':
      return addDays(start, step * 7);
    case 'MONTHLY':
      return addMonths(start, step, parts(start)[2]);
    case 'YEARLY':
      return addYears(start, step);
  }
}

/// A primeira ocorrência estritamente depois de `after` (ou igual, com inclusive).
export function nextOccurrence(start: DateOnly, frequency: RecurrenceFrequency, interval: number, after: DateOnly, inclusive = false): DateOnly {
  if (inclusive ? start >= after : start > after) return start;
  // Salta logo para perto (sem passar à frente): usa o maior mês/ano
  // possível, para a estimativa ficar sempre por baixo.
  const days = daysBetween(start, after);
  const unit = frequency === 'DAILY' ? 1 : frequency === 'WEEKLY' ? 7 : frequency === 'MONTHLY' ? 31 : 366;
  let n = Math.max(0, Math.floor(days / (unit * Math.max(1, interval))) - 1);
  for (let guard = 0; guard < 2000; guard++, n++) {
    const occ = occurrenceAt(start, frequency, interval, n);
    if (inclusive ? occ >= after : occ > after) return occ;
  }
  throw new Error('nextOccurrence: limite de iterações');
}

/// Todas as ocorrências entre from e to (inclusivos), no máximo `limit`.
export function occurrencesBetween(start: DateOnly, frequency: RecurrenceFrequency, interval: number, from: DateOnly, to: DateOnly, end?: DateOnly | null, limit = 400): DateOnly[] {
  const out: DateOnly[] = [];
  let next = nextOccurrence(start, frequency, interval, from, true);
  while (next <= to && (!end || next <= end) && out.length < limit) {
    out.push(next);
    next = nextOccurrence(start, frequency, interval, next, false);
  }
  return out;
}

/// Meses (YYYY-MM) entre duas datas, inclusivos.
export function monthsBetween(from: DateOnly, to: DateOnly): string[] {
  const out: string[] = [];
  let cursor = startOfMonth(from);
  while (cursor <= to && out.length < 600) {
    out.push(monthKey(cursor));
    cursor = addMonths(cursor, 1, 1);
  }
  return out;
}

/// Hora local (0–23) num fuso — para não mandar lembretes de madrugada.
export function localHour(timezone: string, now: Date = new Date()): number {
  try {
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }).format(now);
    return Number(hour) % 24;
  } catch {
    return now.getUTCHours();
  }
}

/// O mês financeiro com a chave "AAAA-MM" (a chave é o mês em que começa).
export function financialMonthByKey(key: string, startDay = 1): Period {
  const [y, m] = key.split('-').map(Number);
  const start = make(y, m, Math.min(startDay, daysInMonth(y, m)));
  const nextStart = addMonths(start, 1, startDay);
  return { start, end: addDays(nextStart, -1), key };
}

export const isMonthKey = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
