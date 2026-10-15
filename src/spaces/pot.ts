import { Prisma } from '../generated/prisma/client';

/// A parte de cada pessoa no fundo comum de um Space.
export interface PotMember {
  userId: string;
  /// O que pôs no fundo
  deposited: number;
  /// O que tirou de lá
  withdrawn: number;
  /// A sua parte das despesas pagas com o fundo
  share: number;
  /// O que ainda é "seu" no fundo: depositado − levantado − a sua parte do que se gastou
  stake: number;
}

export interface Pot {
  /// O que está no fundo agora
  balance: number;
  deposited: number;
  withdrawn: number;
  /// Despesas pagas com o fundo
  spent: number;
  /// Do que lá está, quanto está guardado para metas do grupo
  earmarked: number;
  /// O que se pode gastar ou levantar: o que lá está menos o que é das metas
  free: number;
  members: PotMember[];
}

/// Depósitos de quem já saiu ou apagou a conta.
export const FORMER_DEPOSITOR = '__former__';

const cents = (v: Prisma.Decimal | number) => Math.round(Number(v) * 100);

/// As contas do fundo comum: quem pôs, quem tirou, o que o grupo gastou de
/// lá e o que cabe a cada um. Um depósito negativo é um levantamento.
/// `goalId` só deve vir preenchido nos depósitos de metas que ainda guardam
/// o dinheiro (uma meta arquivada devolve-o ao fundo livre).
export function computePot(
  deposits: Array<{ userId: string | null; amount: Prisma.Decimal | number; goalId?: string | null }>,
  potExpenses: Array<{ amount: Prisma.Decimal | number; shares: Array<{ userId: string | null; amount: Prisma.Decimal | number }> }>,
  memberIds: string[] = [],
): Pot {
  const acc = new Map<string, { deposited: number; withdrawn: number; share: number }>();
  const get = (id: string | null) => {
    const key = id ?? FORMER_DEPOSITOR;
    let entry = acc.get(key);
    if (!entry) {
      entry = { deposited: 0, withdrawn: 0, share: 0 };
      acc.set(key, entry);
    }
    return entry;
  };
  for (const id of memberIds) get(id);
  let earmarked = 0;
  for (const d of deposits) {
    const value = cents(d.amount);
    if (value >= 0) get(d.userId).deposited += value;
    else get(d.userId).withdrawn += -value;
    if (d.goalId) earmarked += value;
  }
  let spent = 0;
  for (const e of potExpenses) {
    spent += cents(e.amount);
    for (const s of e.shares) get(s.userId).share += cents(s.amount);
  }
  const members = [...acc.entries()].map(([userId, v]) => ({
    userId,
    deposited: v.deposited / 100,
    withdrawn: v.withdrawn / 100,
    share: v.share / 100,
    stake: (v.deposited - v.withdrawn - v.share) / 100,
  }));
  const deposited = members.reduce((sum, m) => sum + cents(m.deposited), 0);
  const withdrawn = members.reduce((sum, m) => sum + cents(m.withdrawn), 0);
  const balance = deposited - withdrawn - spent;
  // Nunca se guarda para metas mais do que o que lá está.
  const reserved = Math.min(Math.max(0, earmarked), Math.max(0, balance));
  return {
    balance: balance / 100,
    deposited: deposited / 100,
    withdrawn: withdrawn / 100,
    spent: spent / 100,
    earmarked: reserved / 100,
    free: Math.max(0, balance - reserved) / 100,
    members,
  };
}
