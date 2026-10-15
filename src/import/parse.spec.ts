import { applyMapping, guessMapping, parseAmount, parseDate, readTable } from './parse';

describe('importação de CSV', () => {
  it('lê valores e datas em vários formatos', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('-12,50')).toBe(-12.5);
    expect(parseAmount('(12.50)')).toBe(-12.5);
    expect(parseAmount('€ 7,99')).toBe(7.99);
    expect(parseDate('15/03/2026')).toBe('2026-03-15');
    expect(parseDate('2026-03-15')).toBe('2026-03-15');
    expect(parseDate('15.03.26')).toBe('2026-03-15');
    expect(parseDate('03/15/2026')).toBe('2026-03-15');
    expect(parseDate('abc')).toBeNull();
  });

  it('adivinha as colunas de um extrato com débito e crédito', async () => {
    const csv = 'Extrato da conta\nData;Descrição;Débito;Crédito;Saldo\n01/03/2026;Supermercado;45,10;;954,90\n02/03/2026;Salário;;1500,00;2454,90\n';
    const table = await readTable(Buffer.from(csv, 'utf8'), 'extrato.csv');
    expect(table.columns).toEqual(['Data', 'Descrição', 'Débito', 'Crédito', 'Saldo']);
    const m = guessMapping(table);
    expect(m).toMatchObject({ date: 0, description: 1, debit: 2, credit: 3, amount: null });
    const rows = applyMapping(table, m);
    expect(rows[0]).toMatchObject({ date: '2026-03-01', amount: 45.1, type: 'EXPENSE', description: 'Supermercado', valid: true });
    expect(rows[1]).toMatchObject({ amount: 1500, type: 'INCOME' });
  });

  it('adivinha uma coluna única com sinal', async () => {
    const csv = 'date,amount,memo\n2026-04-01,-9.99,Spotify\n2026-04-02,120.00,Refund\n';
    const table = await readTable(Buffer.from(csv, 'utf8'), 'x.csv');
    const m = guessMapping(table);
    expect(m).toMatchObject({ date: 0, amount: 1, description: 2 });
    expect(applyMapping(table, m)[0]).toMatchObject({ amount: 9.99, type: 'EXPENSE' });
  });
});
