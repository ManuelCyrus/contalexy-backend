import { parseMoneyMessage } from './whatsapp.service';

describe('mensagens de WhatsApp', () => {
  it('percebe valor, tipo e descrição em várias formas', () => {
    expect(parseMoneyMessage('12,50 café')).toEqual({ amount: 12.5, type: 'EXPENSE', description: 'café' });
    expect(parseMoneyMessage('café 12.50')).toEqual({ amount: 12.5, type: 'EXPENSE', description: 'café' });
    expect(parseMoneyMessage('recebi 100 freelance')).toEqual({ amount: 100, type: 'INCOME', description: 'freelance' });
    expect(parseMoneyMessage('+250 salário')).toEqual({ amount: 250, type: 'INCOME', description: 'salário' });
    expect(parseMoneyMessage('paguei 30€ gasolina')).toEqual({ amount: 30, type: 'EXPENSE', description: 'gasolina' });
    expect(parseMoneyMessage('olá, tudo bem?')).toBeNull();
  });
});
