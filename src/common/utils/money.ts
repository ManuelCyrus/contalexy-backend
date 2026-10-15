import { Prisma } from '../../generated/prisma/client';

export type Decimal = Prisma.Decimal;

export const dec = (value: number | string | Prisma.Decimal | null | undefined): Prisma.Decimal =>
  new Prisma.Decimal(value ?? 0);

/// Número (da API) → Decimal com 2 casas.
export const money = (value: number | string): Prisma.Decimal => new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/// Decimal → número com 2 casas (para a resposta JSON).
export const num = (value: Prisma.Decimal | number | string | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  return Number(new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2));
};

export const numOrNull = (value: Prisma.Decimal | null | undefined): number | null => (value === null || value === undefined ? null : num(value));

export const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export function sum(values: Array<Prisma.Decimal | number | null | undefined>): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => acc.plus(v ?? 0), new Prisma.Decimal(0));
}

/// Divide um total em partes iguais (em cêntimos), espalhando o resto
/// pelos primeiros — a soma bate sempre certo com o total.
export function splitEvenly(total: Prisma.Decimal, count: number): Prisma.Decimal[] {
  if (count <= 0) return [];
  const cents = total.times(100).toDecimalPlaces(0).toNumber();
  const base = Math.trunc(cents / count);
  let rest = cents - base * count;
  return Array.from({ length: count }, () => {
    const extra = rest > 0 ? 1 : rest < 0 ? -1 : 0;
    rest -= extra;
    return new Prisma.Decimal(base + extra).dividedBy(100);
  });
}

/// Divide em partes proporcionais a pesos (percentagens ou "partes").
export function splitByWeights(total: Prisma.Decimal, weights: number[]): Prisma.Decimal[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) return weights.map(() => new Prisma.Decimal(0));
  const cents = total.times(100).toDecimalPlaces(0).toNumber();
  const raw = weights.map((w) => (cents * w) / totalWeight);
  const floored = raw.map((r) => Math.floor(r));
  let rest = cents - floored.reduce((a, b) => a + b, 0);
  // O resto vai para quem ficou com a maior parte decimal.
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (rest <= 0) break;
    floored[i] += 1;
    rest -= 1;
  }
  return floored.map((c) => new Prisma.Decimal(c).dividedBy(100));
}

/// "12,50 €" no formato do país/idioma da pessoa.
export function formatMoney(amount: number | Prisma.Decimal, currency: string, language = 'en', country?: string): string {
  const value = typeof amount === 'number' ? amount : amount.toNumber();
  const locales = [country ? `${language}-${country}` : language, language, 'en'];
  try {
    return new Intl.NumberFormat(locales, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function formatDate(date: string, language = 'en', country?: string): string {
  try {
    const d = new Date(`${date}T12:00:00Z`);
    return new Intl.DateTimeFormat([country ? `${language}-${country}` : language, 'en'], { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
  } catch {
    return date;
  }
}
