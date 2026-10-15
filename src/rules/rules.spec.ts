import { ruleMatches } from './rules.service';

describe('regras automáticas', () => {
  it('contém / igual / começa por — sem acentos nem maiúsculas', () => {
    expect(ruleMatches({ field: 'DESCRIPTION', operator: 'CONTAINS', value: 'uber' }, { description: 'Viagem UBER para casa' })).toBe(true);
    expect(ruleMatches({ field: 'DESCRIPTION', operator: 'EQUALS', value: 'Café' }, { description: 'cafe' })).toBe(true);
    expect(ruleMatches({ field: 'DESCRIPTION', operator: 'STARTS_WITH', value: 'pingo' }, { description: 'Pingo Doce Benfica' })).toBe(true);
    expect(ruleMatches({ field: 'MERCHANT', operator: 'CONTAINS', value: 'galp' }, { description: 'galp', merchant: null })).toBe(false);
  });
});
