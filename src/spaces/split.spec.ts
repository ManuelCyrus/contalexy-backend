import { Prisma } from '../generated/prisma/client';
import { computeBalances, computeShares, simplifyDebts } from './split';
import { ApiException } from '../common/errors/api.exception';

const D = (v: number) => new Prisma.Decimal(v);
const amounts = (shares: Array<{ amount: Prisma.Decimal }>) => shares.map((s) => Number(s.amount));

describe('divisão de despesas', () => {
  it('partes iguais com cêntimos espalhados', () => {
    expect(amounts(computeShares('EQUAL', D(100), [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }]))).toEqual([33.34, 33.33, 33.33]);
  });

  it('valores exatos têm de somar o total', () => {
    expect(amounts(computeShares('EXACT', D(50), [{ userId: 'a', value: 20 }, { userId: 'b', value: 30 }]))).toEqual([20, 30]);
    expect(() => computeShares('EXACT', D(50), [{ userId: 'a', value: 20 }, { userId: 'b', value: 20 }])).toThrow(ApiException);
  });

  it('percentagens têm de dar 100', () => {
    expect(amounts(computeShares('PERCENT', D(80), [{ userId: 'a', value: 75 }, { userId: 'b', value: 25 }]))).toEqual([60, 20]);
    expect(() => computeShares('PERCENT', D(80), [{ userId: 'a', value: 70 }, { userId: 'b', value: 20 }])).toThrow(ApiException);
  });

  it('partes (ex.: 2 adultos + 1 criança)', () => {
    expect(amounts(computeShares('SHARES', D(50), [{ userId: 'a', value: 2 }, { userId: 'b', value: 2 }, { userId: 'c', value: 1 }]))).toEqual([20, 20, 10]);
  });

  it('saldos e acertos: quem deve a quem', () => {
    const expenses = [
      { paidById: 'ana', amount: D(90), shares: [{ userId: 'ana', amount: D(30) }, { userId: 'rui', amount: D(30) }, { userId: 'eva', amount: D(30) }] },
      { paidById: 'rui', amount: D(30), shares: [{ userId: 'ana', amount: D(15) }, { userId: 'rui', amount: D(15) }] },
    ];
    const balances = computeBalances(expenses, [{ fromUserId: 'eva', toUserId: 'ana', amount: D(10) }]);
    const net = Object.fromEntries(balances.map((b) => [b.userId, b.net]));
    expect(net).toEqual({ ana: 35, rui: -15, eva: -20 });
    expect(simplifyDebts(balances)).toEqual([
      { from: 'eva', to: 'ana', amount: 20 },
      { from: 'rui', to: 'ana', amount: 15 },
    ]);
  });

  it('quem apagou a conta fica como "antigo membro" sem estragar os saldos', () => {
    const balances = computeBalances([{ paidById: null, amount: D(20), shares: [{ userId: 'ana', amount: D(10) }, { userId: null, amount: D(10) }] }], []);
    expect(balances.reduce((a, b) => a + b.net, 0)).toBeCloseTo(0, 10);
  });
});
