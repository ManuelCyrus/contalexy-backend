import { computePot, FORMER_DEPOSITOR } from './pot';

describe('fundo comum de um Space', () => {
  it('sem nada, o fundo está a zero e os membros aparecem', () => {
    const pot = computePot([], [], ['a', 'b']);
    expect(pot).toMatchObject({ balance: 0, deposited: 0, spent: 0, earmarked: 0 });
    expect(pot.members.map((m) => m.userId)).toEqual(['a', 'b']);
  });

  it('depósitos, levantamentos e despesas pagas com o fundo', () => {
    const pot = computePot(
      [
        { userId: 'a', amount: 100 },
        { userId: 'b', amount: 50, goalId: 'g1' },
        { userId: 'a', amount: -20 },
      ],
      [
        {
          amount: 60,
          shares: [
            { userId: 'a', amount: 30 },
            { userId: 'b', amount: 30 },
          ],
        },
      ],
      ['a', 'b'],
    );
    // Dos 70 que lá estão, 50 são de uma meta: livres para gastar ficam 20.
    expect(pot).toMatchObject({ deposited: 150, withdrawn: 20, spent: 60, balance: 70, earmarked: 50, free: 20 });
    const a = pot.members.find((m) => m.userId === 'a');
    const b = pot.members.find((m) => m.userId === 'b');
    // A: pôs 100, tirou 20, cabe-lhe 30 do que se gastou → ainda tem 50 no fundo.
    expect(a).toMatchObject({ deposited: 100, withdrawn: 20, share: 30, stake: 50 });
    expect(b).toMatchObject({ deposited: 50, share: 30, stake: 20 });
    // O que está no fundo é a soma do que cabe a cada um.
    expect(pot.members.reduce((sum, m) => sum + m.stake, 0)).toBe(pot.balance);
  });

  it('quem gastou mais do que pôs fica a dever ao fundo', () => {
    const pot = computePot([{ userId: 'a', amount: 100 }], [{ amount: 80, shares: [{ userId: 'a', amount: 40 }, { userId: 'b', amount: 40 }] }], ['a', 'b']);
    expect(pot.members.find((m) => m.userId === 'b')?.stake).toBe(-40);
    expect(pot.balance).toBe(20);
  });

  it('o dinheiro de quem apagou a conta continua no fundo', () => {
    const pot = computePot([{ userId: null, amount: 30 }], [], ['a']);
    expect(pot.balance).toBe(30);
    expect(pot.members.find((m) => m.userId === FORMER_DEPOSITOR)?.deposited).toBe(30);
  });

  it('nunca se guarda para metas mais do que o que está no fundo', () => {
    const pot = computePot([{ userId: 'a', amount: 50, goalId: 'g1' }], [{ amount: 30, shares: [{ userId: 'a', amount: 30 }] }], ['a']);
    expect(pot).toMatchObject({ balance: 20, earmarked: 20, free: 0 });
  });

  it('os cêntimos não se perdem', () => {
    const pot = computePot(
      [
        { userId: 'a', amount: 0.1 },
        { userId: 'a', amount: 0.2 },
      ],
      [],
    );
    expect(pot.balance).toBe(0.3);
  });
});
