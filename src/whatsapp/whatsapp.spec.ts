import { looksLikeQuestion, parseMoneyMessage, smallTalk } from './whatsapp.service';

describe('mensagens de WhatsApp', () => {
  it('percebe valor, tipo e descrição em várias formas', () => {
    expect(parseMoneyMessage('12,50 café')).toEqual({ amount: 12.5, type: 'EXPENSE', description: 'café', currency: null });
    expect(parseMoneyMessage('café 12.50')).toEqual({ amount: 12.5, type: 'EXPENSE', description: 'café', currency: null });
    expect(parseMoneyMessage('recebi 100 freelance')).toEqual({ amount: 100, type: 'INCOME', description: 'freelance', currency: null });
    expect(parseMoneyMessage('+250 salário')).toEqual({ amount: 250, type: 'INCOME', description: 'salário', currency: null });
    expect(parseMoneyMessage('paguei 30€ gasolina')).toEqual({ amount: 30, type: 'EXPENSE', description: 'gasolina', currency: 'EUR' });
    expect(parseMoneyMessage('olá, tudo bem?')).toBeNull();
  });

  it('percebe a moeda escrita por extenso e tira as ligações', () => {
    expect(parseMoneyMessage('Downuts de 0,40 euros')).toEqual({ amount: 0.4, type: 'EXPENSE', description: 'Downuts', currency: 'EUR' });
    expect(parseMoneyMessage('almoço 2500 kz')).toEqual({ amount: 2500, type: 'EXPENSE', description: 'almoço', currency: 'AOA' });
    expect(parseMoneyMessage('R$ 35 uber')).toEqual({ amount: 35, type: 'EXPENSE', description: 'uber', currency: 'BRL' });
    expect(parseMoneyMessage('recebi 1000 reais de freelance')?.currency).toBe('BRL');
    expect(parseMoneyMessage('5 dollars for lunch')).toEqual({ amount: 5, type: 'EXPENSE', description: 'lunch', currency: 'USD' });
  });

  it('responde a agradecimentos e cumprimentos', () => {
    expect(smallTalk('Obrigado')).toBe('thanks');
    expect(smallTalk('obrigada!')).toBe('thanks');
    expect(smallTalk('Olá')).toBe('hello');
    expect(smallTalk('bom dia')).toBe('hello');
    expect(smallTalk('qualquer coisa')).toBeNull();
  });

  it('reconhece perguntas para o assistente', () => {
    expect(looksLikeQuestion('Quanto já gastei este mês ?')).toBe(true);
    expect(looksLikeQuestion('quanto gastei em 2026')).toBe(true);
    expect(looksLikeQuestion('How much did I spend?')).toBe(true);
    expect(looksLikeQuestion('12,50 café')).toBe(false);
    expect(looksLikeQuestion('Olá?')).toBe(false);
  });
});
