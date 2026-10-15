import { addMonths, financialMonth, financialMonthByKey, isDateOnly, isMonthKey, localHour, monthsBetween, nextOccurrence, occurrenceAt, occurrencesBetween, periodContaining, previousPeriod, startOfWeek, todayIn } from './dates';

describe('datas', () => {
  it('valida YYYY-MM-DD a sério', () => {
    expect(isDateOnly('2026-02-28')).toBe(true);
    expect(isDateOnly('2026-02-30')).toBe(false);
    expect(isDateOnly('2026-2-3')).toBe(false);
  });

  it('somar meses mantém o dia âncora (31 → 28 → 31)', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(occurrenceAt('2026-01-31', 'MONTHLY', 1, 2)).toBe('2026-03-31');
  });

  it('mês financeiro a começar no dia do salário', () => {
    expect(financialMonth('2026-10-01', 1)).toEqual({ start: '2026-10-01', end: '2026-10-31', key: '2026-10' });
    expect(financialMonth('2026-10-10', 25)).toEqual({ start: '2026-09-25', end: '2026-10-24', key: '2026-09' });
    expect(financialMonth('2026-10-25', 25).start).toBe('2026-10-25');
    // dia 31 num mês curto
    expect(financialMonth('2026-02-28', 31)).toEqual({ start: '2026-02-28', end: '2026-03-30', key: '2026-02' });
  });

  it('mês financeiro pela chave e hora local', () => {
    expect(financialMonthByKey('2026-10', 1)).toEqual({ start: '2026-10-01', end: '2026-10-31', key: '2026-10' });
    expect(financialMonthByKey('2026-09', 25)).toEqual({ start: '2026-09-25', end: '2026-10-24', key: '2026-09' });
    // A chave de um mês bate sempre com o mês financeiro que começa nele
    expect(financialMonthByKey(financialMonth('2026-10-10', 25).key, 25)).toEqual(financialMonth('2026-10-10', 25));
    expect(isMonthKey('2026-10')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-1')).toBe(false);
    const instant = new Date('2026-10-01T23:30:00Z');
    expect(localHour('Europe/Lisbon', instant)).toBe(0);
    expect(localHour('America/Sao_Paulo', instant)).toBe(20);
    expect(localHour('Invalid/Zone', instant)).toBe(23);
  });

  it('semanas começam à segunda (ou ao domingo)', () => {
    expect(startOfWeek('2026-10-01', 1)).toBe('2026-09-28'); // quinta → segunda
    expect(startOfWeek('2026-10-01', 7)).toBe('2026-09-27'); // → domingo
    expect(periodContaining('WEEKLY', '2026-10-04').end).toBe('2026-10-04');
    expect(previousPeriod('MONTHLY', '2026-10-15').key).toBe('2026-09');
    expect(previousPeriod('YEARLY', '2026-10-15').key).toBe('2025');
  });

  it('próxima ocorrência nunca salta ocorrências (regras antigas)', () => {
    expect(nextOccurrence('2016-01-31', 'MONTHLY', 1, '2026-10-01')).toBe('2026-10-31');
    expect(nextOccurrence('2026-01-15', 'MONTHLY', 1, '2026-10-15', true)).toBe('2026-10-15');
    expect(nextOccurrence('2026-01-15', 'MONTHLY', 1, '2026-10-15', false)).toBe('2026-11-15');
    expect(nextOccurrence('2020-02-29', 'YEARLY', 1, '2026-01-01')).toBe('2026-02-28');
    expect(nextOccurrence('2026-09-01', 'WEEKLY', 2, '2026-09-20')).toBe('2026-09-29');
    expect(nextOccurrence('2000-01-01', 'DAILY', 1, '2026-10-01')).toBe('2026-10-02');
  });

  it('ocorrências num intervalo', () => {
    expect(occurrencesBetween('2026-01-05', 'MONTHLY', 1, '2026-10-01', '2026-12-31')).toEqual(['2026-10-05', '2026-11-05', '2026-12-05']);
    expect(occurrencesBetween('2026-01-05', 'MONTHLY', 1, '2026-10-01', '2026-12-31', '2026-11-30')).toEqual(['2026-10-05', '2026-11-05']);
  });

  it('meses entre datas e dia de hoje num fuso', () => {
    expect(monthsBetween('2026-08-15', '2026-10-01')).toEqual(['2026-08', '2026-09', '2026-10']);
    const instant = new Date('2026-10-01T23:30:00Z');
    expect(todayIn('Europe/Lisbon', instant)).toBe('2026-10-02');
    expect(todayIn('America/Sao_Paulo', instant)).toBe('2026-10-01');
    expect(todayIn('Invalid/Zone', instant)).toBe('2026-10-01');
  });
});
