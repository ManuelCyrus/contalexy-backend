import { linePricing } from './plans.service';

describe('total de uma linha do plano', () => {
  it('com preço por unidade, o total é quantidade × preço', () => {
    expect(linePricing({ quantity: 3, unitPrice: 1.2 })).toEqual({ unitPrice: 1.2, estimatedAmount: 3.6 });
    expect(linePricing({ quantity: 6, unitPrice: 0.89, estimatedAmount: 1 })).toEqual({ unitPrice: 0.89, estimatedAmount: 5.34 });
    expect(linePricing({ quantity: 1, unitPrice: 0 })).toEqual({ unitPrice: 0, estimatedAmount: 0 });
  });

  it('sem preço por unidade, vale o total que a pessoa escreveu (ou nenhum)', () => {
    expect(linePricing({ quantity: 40, estimatedAmount: 1000 })).toEqual({ unitPrice: null, estimatedAmount: 1000 });
    expect(linePricing({ quantity: 2 })).toEqual({ unitPrice: null, estimatedAmount: null });
    expect(linePricing({ quantity: 2, unitPrice: null, estimatedAmount: null })).toEqual({ unitPrice: null, estimatedAmount: null });
  });

  it('arredonda ao cêntimo', () => {
    expect(linePricing({ quantity: 3, unitPrice: 0.333 })).toEqual({ unitPrice: 0.33, estimatedAmount: 1 });
  });
});
