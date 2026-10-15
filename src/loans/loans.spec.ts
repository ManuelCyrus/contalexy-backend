import { overdueReminderDay, reminderFor } from './loans.service';

describe('empréstimos (lembretes)', () => {
  const loan = { dueDate: '2026-10-20', remindDaysBefore: [7, 1], remindOnDue: true, remindOverdue: true };

  it('avisa X dias antes, no dia e depois de passar a data', () => {
    expect(reminderFor(loan, '2026-10-13')).toEqual({ kind: 'due_soon', key: 'before:7:2026-10-20', days: 7 });
    expect(reminderFor(loan, '2026-10-14')).toBeNull();
    expect(reminderFor(loan, '2026-10-19')).toMatchObject({ kind: 'due_soon', days: 1 });
    expect(reminderFor(loan, '2026-10-20')).toEqual({ kind: 'due_today', key: 'due:2026-10-20', days: 0 });
    expect(reminderFor(loan, '2026-10-21')).toEqual({ kind: 'overdue', key: 'overdue:1:2026-10-20', days: 1 });
    expect(reminderFor(loan, '2026-10-22')).toBeNull();
    expect(reminderFor(loan, '2026-10-23')).toMatchObject({ kind: 'overdue', days: 3 });
  });

  it('respeita o que a pessoa desligou', () => {
    expect(reminderFor({ ...loan, remindOnDue: false }, '2026-10-20')).toBeNull();
    expect(reminderFor({ ...loan, remindOverdue: false }, '2026-10-21')).toBeNull();
    expect(reminderFor({ ...loan, remindDaysBefore: [] }, '2026-10-19')).toBeNull();
    expect(reminderFor({ ...loan, dueDate: null }, '2026-10-20')).toBeNull();
  });

  it('em atraso: 1, 3, 7, 14, 30 dias e depois de 14 em 14', () => {
    const days = Array.from({ length: 80 }, (_, i) => i).filter((d) => overdueReminderDay(d) !== null);
    expect(days).toEqual([1, 3, 7, 14, 30, 44, 58, 72]);
  });
});
