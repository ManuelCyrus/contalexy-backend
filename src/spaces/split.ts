import { Prisma, SplitMethod } from '../generated/prisma/client';
import { splitByWeights, splitEvenly } from '../common/utils/money';
import { ApiException } from '../common/errors/api.exception';

export interface Participant {
  userId: string;
  /// EXACT: valor; PERCENT: %; SHARES: partes; EQUAL: ignorado
  value?: number | null;
}

export interface ComputedShare {
  userId: string;
  amount: Prisma.Decimal;
  weight: Prisma.Decimal | null;
}

/// Quanto cada pessoa deve de uma despesa. A soma bate SEMPRE certo com o
/// total (os cêntimos que sobram vão para os primeiros).
export function computeShares(method: SplitMethod, total: Prisma.Decimal, participants: Participant[]): ComputedShare[] {
  const unique = new Map<string, Participant>();
  for (const p of participants) unique.set(p.userId, p);
  const list = [...unique.values()];
  if (!list.length) throw ApiException.badRequest('SPLIT_MEMBER_INVALID');
  const totalText = total.toFixed(2);

  switch (method) {
    case 'EQUAL': {
      const parts = splitEvenly(total, list.length);
      return list.map((p, i) => ({ userId: p.userId, amount: parts[i], weight: null }));
    }
    case 'EXACT': {
      const amounts = list.map((p) => new Prisma.Decimal(p.value ?? 0).toDecimalPlaces(2));
      if (amounts.some((a) => a.isNegative())) throw ApiException.badRequest('SPLIT_INVALID', { total: totalText });
      const sum = amounts.reduce((acc, a) => acc.plus(a), new Prisma.Decimal(0));
      if (!sum.equals(total)) throw ApiException.badRequest('SPLIT_INVALID', { total: totalText });
      return list.map((p, i) => ({ userId: p.userId, amount: amounts[i], weight: null }));
    }
    case 'PERCENT': {
      const weights = list.map((p) => Number(p.value ?? 0));
      const sum = weights.reduce((a, b) => a + b, 0);
      if (weights.some((w) => w < 0) || Math.abs(sum - 100) > 0.01) throw ApiException.badRequest('SPLIT_INVALID', { total: totalText });
      const parts = splitByWeights(total, weights);
      return list.map((p, i) => ({ userId: p.userId, amount: parts[i], weight: new Prisma.Decimal(weights[i]) }));
    }
    case 'SHARES': {
      const weights = list.map((p) => Number(p.value ?? 0));
      if (weights.some((w) => w < 0) || weights.reduce((a, b) => a + b, 0) <= 0) throw ApiException.badRequest('SPLIT_INVALID', { total: totalText });
      const parts = splitByWeights(total, weights);
      return list.map((p, i) => ({ userId: p.userId, amount: parts[i], weight: new Prisma.Decimal(weights[i]) }));
    }
  }
}

export const FORMER_MEMBER = '__former__';

export interface MemberBalance {
  userId: string;
  paid: number;
  owed: number;
  sent: number;
  received: number;
  /// > 0: os outros devem-lhe; < 0: deve aos outros
  net: number;
}

const cents = (v: Prisma.Decimal | number) => Math.round(Number(v) * 100);

/// Saldos de todos (incluindo quem já saiu ou apagou a conta).
export function computeBalances(
  expenses: Array<{ paidById: string | null; amount: Prisma.Decimal; shares: Array<{ userId: string | null; amount: Prisma.Decimal }> }>,
  settlements: Array<{ fromUserId: string | null; toUserId: string | null; amount: Prisma.Decimal }>,
  memberIds: string[] = [],
): MemberBalance[] {
  const acc = new Map<string, { paid: number; owed: number; sent: number; received: number }>();
  const get = (id: string | null) => {
    const key = id ?? FORMER_MEMBER;
    let entry = acc.get(key);
    if (!entry) {
      entry = { paid: 0, owed: 0, sent: 0, received: 0 };
      acc.set(key, entry);
    }
    return entry;
  };
  for (const id of memberIds) get(id);
  for (const e of expenses) {
    get(e.paidById).paid += cents(e.amount);
    for (const s of e.shares) get(s.userId).owed += cents(s.amount);
  }
  for (const s of settlements) {
    get(s.fromUserId).sent += cents(s.amount);
    get(s.toUserId).received += cents(s.amount);
  }
  return [...acc.entries()].map(([userId, v]) => ({
    userId,
    paid: v.paid / 100,
    owed: v.owed / 100,
    sent: v.sent / 100,
    received: v.received / 100,
    net: (v.paid - v.owed + v.sent - v.received) / 100,
  }));
}

/// Quem paga a quem, com o menor número de transferências possível
/// (aproximação gulosa: o maior devedor paga ao maior credor).
export function simplifyDebts(balances: Array<{ userId: string; net: number }>): Array<{ from: string; to: string; amount: number }> {
  const debtors = balances.filter((b) => b.net < -0.004).map((b) => ({ id: b.userId, c: -Math.round(b.net * 100) }));
  const creditors = balances.filter((b) => b.net > 0.004).map((b) => ({ id: b.userId, c: Math.round(b.net * 100) }));
  debtors.sort((a, b) => b.c - a.c);
  creditors.sort((a, b) => b.c - a.c);
  const out: Array<{ from: string; to: string; amount: number }> = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].c, creditors[j].c);
    if (pay > 0) out.push({ from: debtors[i].id, to: creditors[j].id, amount: pay / 100 });
    debtors[i].c -= pay;
    creditors[j].c -= pay;
    if (debtors[i].c === 0) i++;
    if (creditors[j].c === 0) j++;
  }
  return out;
}
