import { depositDates, nextDepositDate, plannedPerMonth, projectedByPlan } from './deposits';

describe('depósitos planeados (datas e contas)', () => {
  const monthly = { amount: 100, frequency: 'MONTHLY', startDate: '2026-10-31', nextDate: '2026-10-31', endDate: null };

  it('um depósito de uma vez só tem uma data', () => {
    const once = { amount: 50, frequency: 'ONCE', startDate: '2026-11-05', nextDate: '2026-11-05', endDate: null };
    expect(depositDates(once, '2026-12-31')).toEqual(['2026-11-05']);
    expect(depositDates(once, '2026-11-04')).toEqual([]);
    expect(nextDepositDate(once, '2026-11-05')).toBeNull();
  });

  it('todos os meses no dia 31: nos meses curtos cai no último dia e volta ao 31', () => {
    expect(depositDates(monthly, '2027-03-31')).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31']);
  });

  it('a ocorrência em atraso continua a contar e as seguintes não se repetem', () => {
    const late = { ...monthly, startDate: '2026-08-15', nextDate: '2026-09-15' };
    expect(depositDates(late, '2026-11-20')).toEqual(['2026-09-15', '2026-10-15', '2026-11-15']);
  });

  it('respeita a data de fim', () => {
    const until = { ...monthly, startDate: '2026-10-10', nextDate: '2026-10-10', endDate: '2026-12-10' };
    expect(depositDates(until, '2027-06-01')).toEqual(['2026-10-10', '2026-11-10', '2026-12-10']);
    expect(nextDepositDate(until, '2026-11-10')).toBe('2026-12-10');
    expect(nextDepositDate(until, '2026-12-10')).toBeNull();
  });

  it('todas as semanas', () => {
    const weekly = { amount: 20, frequency: 'WEEKLY', startDate: '2026-10-05', nextDate: '2026-10-05', endDate: null };
    expect(depositDates(weekly, '2026-10-26')).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    expect(nextDepositDate(weekly, '2026-10-05')).toBe('2026-10-12');
  });

  it('soma por mês só o que se repete', () => {
    const weekly = { amount: 20, frequency: 'WEEKLY', startDate: '2026-10-05', nextDate: '2026-10-05', endDate: null };
    const once = { amount: 500, frequency: 'ONCE', startDate: '2026-11-05', nextDate: '2026-11-05', endDate: null };
    expect(plannedPerMonth([monthly, weekly, once])).toBe(186.96);
  });

  it('diz quando se chega ao objetivo com o que está planeado', () => {
    const start = { ...monthly, startDate: '2026-10-28', nextDate: '2026-10-28' };
    // Faltam 250: 100 em out, 100 em nov, e os últimos 50 chegam em dezembro.
    expect(projectedByPlan(250, [start], '2026-10-07')).toBe('2026-12-28');
    // Um depósito único grande resolve logo.
    const once = { amount: 300, frequency: 'ONCE', startDate: '2026-11-05', nextDate: '2026-11-05', endDate: null };
    expect(projectedByPlan(250, [start, once], '2026-10-07')).toBe('2026-11-05');
    // Um plano que acaba cedo demais não chega.
    expect(projectedByPlan(250, [{ ...start, endDate: '2026-11-28' }], '2026-10-07')).toBeNull();
    expect(projectedByPlan(0, [], '2026-10-07')).toBe('2026-10-07');
    expect(projectedByPlan(10, [], '2026-10-07')).toBeNull();
  });
});
