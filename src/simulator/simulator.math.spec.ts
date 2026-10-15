import { Baseline, monthsToSave, niceRound, percentChange, projectMonths, savingScenarios, verdictFor } from './simulator.math';

describe('simulador (contas)', () => {
  // O exemplo do documento: saldo 2000, compra 1200, despesas previstas 900,
  // objetivos de poupança 300 → sobram −400.
  const example: Baseline = { available: 2000, restIncome: 0, restExpenses: 900, restSavings: 300, monthlyIncome: 1500, monthlyExpenses: 900, monthlySavings: 300 };

  it('comprar agora: saldo − despesas − poupança − compra', () => {
    const without = projectMonths(example, 3);
    expect(without[0].free).toBe(800);
    const withPurchase = projectMonths(example, 3, [{ month: 0, amount: 1200 }]);
    expect(withPurchase[0].free).toBe(-400);
    // Cada mês seguinte: + receitas − despesas − poupança (1500 − 900 − 300 = +300)
    expect(withPurchase.map((m) => m.free)).toEqual([-400, -100, 200, 500]);
    expect(without.map((m) => m.savedTotal)).toEqual([300, 600, 900, 1200]);
  });

  it('"e se for daqui a 2 meses?" e alterações ao mês normal', () => {
    const later = projectMonths(example, 3, [{ month: 2, amount: 1200 }]);
    expect(later.map((m) => m.free)).toEqual([800, 1100, 200, 500]);
    expect(later[2].oneOff).toBe(1200);
    // Gastar 10% menos e poupar mais 100 por mês, a partir do próximo mês
    const adjusted = projectMonths(example, 2, [], { expenseChangePercent: -10, extraMonthlySaving: 100 });
    expect(adjusted[1]).toMatchObject({ expenses: 810, savings: 400, free: 1090 });
    // Uma entrada de dinheiro é um gasto negativo
    expect(projectMonths(example, 1, [{ month: 1, amount: -500 }])[1].free).toBe(1600);
  });

  it('veredicto da compra', () => {
    expect(verdictFor(500, 300, 90)).toBe('OK');
    expect(verdictFor(50, 300, 90)).toBe('TIGHT');
    expect(verdictFor(0, 300, 0)).toBe('OK');
    // Só cabe se se poupar menos do que o planeado
    expect(verdictFor(-200, 300, 90)).toBe('AFFECTS_GOALS');
    expect(verdictFor(-400, 300, 90)).toBe('NOT_AFFORDABLE');
  });

  it('quanto tempo a juntar', () => {
    // Computador de 1200, 300 já guardados, 150 por mês → 6 meses
    expect(monthsToSave(900, 150)).toBe(6);
    expect(monthsToSave(1200, 150)).toBe(8);
    expect(monthsToSave(901, 150)).toBe(7);
    expect(monthsToSave(0, 150)).toBe(0);
    expect(monthsToSave(100, 0)).toBeNull();
  });

  it('números redondos e cenários', () => {
    expect(niceRound(47)).toBe(45);
    expect(niceRound(148)).toBe(150);
    expect(niceRound(1234)).toBe(1250);
    expect(niceRound(3)).toBe(3);
    expect(niceRound(0)).toBe(0);
    expect(savingScenarios(150)).toEqual([75, 150, 230, 300]);
    expect(savingScenarios(100, 125)).toEqual([50, 100, 125, 150, 200]);
    expect(percentChange(135, 100)).toBe(35);
    expect(percentChange(50, 0)).toBeNull();
  });
});
