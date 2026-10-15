import { dec, formatMoney, money, num, splitByWeights, splitEvenly, sum } from './money';

describe('dinheiro', () => {
  it('arredonda a 2 casas sem erros de vírgula flutuante', () => {
    expect(num(money(0.1).plus(money(0.2)))).toBe(0.3);
    expect(num(money('10.005'))).toBe(10.01);
    expect(num(sum([dec('1.10'), 2.2, null]))).toBe(3.3);
  });

  it('divide em partes iguais e a soma bate certo', () => {
    const parts = splitEvenly(money(100), 3).map(num);
    expect(parts).toEqual([33.34, 33.33, 33.33]);
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
  });

  it('divide por pesos (percentagem/partes) sem perder cêntimos', () => {
    const parts = splitByWeights(money(10), [1, 1, 1]).map(num);
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 10);
    expect(splitByWeights(money(90), [50, 25, 25]).map(num)).toEqual([45, 22.5, 22.5]);
  });

  it('formata no estilo de cada país', () => {
    expect(formatMoney(1234.5, 'EUR', 'pt', 'PT')).toMatch(/1\s?234,50\s?€/);
    expect(formatMoney(1234.5, 'USD', 'en', 'US')).toBe('$1,234.50');
    expect(formatMoney(1234.5, 'EUR', 'de', 'DE')).toMatch(/1\.234,50\s?€/);
  });
});
