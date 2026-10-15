import { monthsToTarget, simulateSavings } from './savings';

describe('calculadora de poupança', () => {
  it('sem juros é só a soma dos depósitos', () => {
    const r = simulateSavings({ initial: 100, monthly: 50, annualRatePercent: 0, months: 12 });
    expect(r.finalBalance).toBe(700);
    expect(r.totalInterest).toBe(0);
  });

  it('com juros compostos e imposto, e diz quando chega à meta', () => {
    const r = simulateSavings({ initial: 1000, monthly: 100, annualRatePercent: 4, months: 24, taxPercent: 28, target: 3000 });
    expect(r.finalBalance).toBeGreaterThan(3400);
    expect(r.totalTax).toBeGreaterThan(0);
    expect(r.targetMonth).toBeGreaterThan(15);
    expect(r.monthlyForTarget).toBeLessThan(100);
    expect(monthsToTarget(0, 100, 0, 1200)).toBe(12);
    expect(monthsToTarget(0, 0, 0, 100)).toBeNull();
  });
});
