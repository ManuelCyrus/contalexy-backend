import { alertLevelFor, dailyStatus } from './daily-limit.service';

describe('limite do dia', () => {
  it('bem até 80%, aviso até ao limite, atingido no limite e ultrapassado depois', () => {
    expect(dailyStatus(20, 0)).toBe('OK');
    expect(dailyStatus(20, 15.99)).toBe('OK');
    expect(dailyStatus(20, 16)).toBe('WARNING');
    expect(dailyStatus(20, 19.99)).toBe('WARNING');
    expect(dailyStatus(20, 20)).toBe('REACHED');
    expect(dailyStatus(20, 20.01)).toBe('EXCEEDED');
  });

  it('um dia para não gastar (limite 0): qualquer despesa ultrapassa', () => {
    expect(dailyStatus(0, 0)).toBe('OK');
    expect(dailyStatus(0, 0.5)).toBe('EXCEEDED');
  });

  it('cada aviso sai uma vez: aos 80% e ao chegar ao limite', () => {
    expect(alertLevelFor('OK')).toBe(0);
    expect(alertLevelFor('WARNING')).toBe(80);
    expect(alertLevelFor('REACHED')).toBe(100);
    expect(alertLevelFor('EXCEEDED')).toBe(100);
  });
});
