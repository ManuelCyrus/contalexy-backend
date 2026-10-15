import { businessSummary } from './plans.service';

describe('plano de negócio', () => {
  // O exemplo do documento: capital 900; produtos 400, anúncios 200,
  // embalagens 50, transporte 50; reserva 200.
  const items = [
    { kind: 'COST', estimatedAmount: 400 },
    { kind: 'COST', estimatedAmount: 200 },
    { kind: 'COST', estimatedAmount: 50 },
    { kind: 'COST', estimatedAmount: 50 },
    { kind: 'RESERVE', estimatedAmount: 200 },
    { kind: 'REVENUE', estimatedAmount: 1000 },
  ];

  it('custos, margem e lucro previstos', () => {
    const b = businessSummary({ capital: 900, items, spent: 0, earned: 0 });
    expect(b).toMatchObject({ startupCosts: 700, monthlyCosts: 0, reserve: 200, totalCosts: 700, capitalNeeded: 900, capitalLeft: 0 });
    expect(b).toMatchObject({ expectedRevenue: 1000, expectedProfit: 300, marginPercent: 30, breakEvenRevenue: 700 });
    expect(b.roiPercent).toBeCloseTo(42.86, 2);
  });

  it('previsto contra real', () => {
    const b = businessSummary({ capital: 900, items: [...items, { kind: 'MONTHLY_COST', estimatedAmount: 60 }], spent: 720, earned: 1150 });
    expect(b).toMatchObject({ totalCosts: 760, capitalLeft: -60, expectedProfit: 240, actualCosts: 720, actualRevenue: 1150, actualProfit: 430, profitDifference: 190 });
  });

  it('sem capital nem receitas não inventa números', () => {
    const b = businessSummary({ capital: null, items: [{ kind: 'COST', estimatedAmount: 100 }], spent: 0, earned: 0 });
    expect(b).toMatchObject({ capitalLeft: null, marginPercent: null, expectedProfit: -100 });
  });
});
