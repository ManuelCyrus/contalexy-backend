import { normalizeProductName, unitPrice } from './prices.service';

describe('preços', () => {
  it('o mesmo produto escrito de formas diferentes', () => {
    expect(normalizeProductName('Leite Mimosa 1 L')).toBe(normalizeProductName('leite  MIMOSA 1l'));
    expect(normalizeProductName('Açúcar Branco 1 Kg')).toBe('acucar branco 1kg');
  });

  it('preço por kg/litro', () => {
    expect(unitPrice(2.49, 500, 'g')).toEqual({ value: 4.98, per: 'kg' });
    expect(unitPrice(1.2, 1.5, 'l')).toEqual({ value: 0.8, per: 'l' });
    expect(unitPrice(1, null, 'kg')).toBeNull();
  });
});
