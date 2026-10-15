import { addMonthsAnchored, periodAt } from './quota.service';

const d = (s: string) => new Date(s);

describe('quotas por aniversário', () => {
  it('conta um mês a partir do dia da ativação', () => {
    const p = periodAt(d('2026-03-15T10:00:00Z'), d('2026-05-20T00:00:00Z'));
    expect(p.start.toISOString()).toBe('2026-05-15T10:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-06-15T10:00:00.000Z');
  });

  it('prende o dia ao último do mês quando o mês é mais curto, sem deslizar', () => {
    const anchor = d('2026-01-31T00:00:00Z');
    expect(addMonthsAnchored(anchor, 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonthsAnchored(anchor, 2).toISOString()).toBe('2026-03-31T00:00:00.000Z');
    const p = periodAt(anchor, d('2026-03-01T00:00:00Z'));
    expect(p.start.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('o período acaba quando o plano acaba', () => {
    const p = periodAt(d('2026-01-10T00:00:00Z'), d('2026-04-12T00:00:00Z'), d('2026-04-20T00:00:00Z'));
    expect(p.start.toISOString()).toBe('2026-04-10T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-04-20T00:00:00.000Z');
  });

  it('no próprio dia da ativação o período começa aí', () => {
    const p = periodAt(d('2026-10-13T08:00:00Z'), d('2026-10-13T09:00:00Z'));
    expect(p.start.toISOString()).toBe('2026-10-13T08:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-11-13T08:00:00.000Z');
  });
});
