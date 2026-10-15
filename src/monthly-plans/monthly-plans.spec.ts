import { lineHasList, lineStatus, roundUpNice } from './monthly-plans.service';

describe('plano mensal', () => {
  it('estado de uma linha: bem até 80%, aviso até 100%, depois passou', () => {
    expect(lineStatus(300, 100)).toBe('OK');
    expect(lineStatus(300, 240)).toBe('WARNING');
    expect(lineStatus(300, 300)).toBe('WARNING');
    expect(lineStatus(300, 300.01)).toBe('EXCEEDED');
    expect(lineStatus(0, 0)).toBe('OK');
    expect(lineStatus(0, 5)).toBe('EXCEEDED');
  });

  it('"o que vou comprar": vale a escolha da pessoa; sem escolha, decide a categoria', () => {
    // Comida tem lista; mensalidades e transportes, à partida, não.
    expect(lineHasList(null, { key: 'food' })).toBe(true);
    expect(lineHasList(null, { key: 'subscriptions' })).toBe(false);
    expect(lineHasList(null, { key: 'transport' })).toBe(false);
    // Uma categoria criada pela pessoa tem lista; uma linha sem categoria, não.
    expect(lineHasList(null, { key: null })).toBe(true);
    expect(lineHasList(null, null)).toBe(false);
    // A escolha manda sempre.
    expect(lineHasList(true, { key: 'subscriptions' })).toBe(true);
    expect(lineHasList(false, { key: 'food' })).toBe(false);
  });

  it('sugestões arredondadas para cima', () => {
    expect(roundUpNice(0)).toBe(0);
    expect(roundUpNice(42)).toBe(45);
    expect(roundUpNice(283.4)).toBe(290);
    expect(roundUpNice(1432)).toBe(1450);
    expect(roundUpNice(7810)).toBe(7900);
  });
});
