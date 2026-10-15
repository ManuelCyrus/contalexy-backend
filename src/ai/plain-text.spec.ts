import { plainText } from './ai.service';

describe('plainText', () => {
  it('tira o Markdown que o modelo mete nas respostas', () => {
    const input = ['Olá, Manuel.', '', '- **Casa**: 688,01 € (56,47% do total)', '* _Alimentação_: 294,22 €', '## Próximo passo', 'Vê os `lançamentos` de **Casa**.'].join('\n');
    expect(plainText(input)).toBe(['Olá, Manuel.', '', '- Casa: 688,01 € (56,47% do total)', '- Alimentação: 294,22 €', 'Próximo passo', 'Vê os lançamentos de Casa.'].join('\n'));
  });
  it('não estraga multiplicações nem sublinhados em palavras', () => {
    expect(plainText('2 * 3 = 6 e snake_case fica')).toBe('2 * 3 = 6 e snake_case fica');
  });
});
