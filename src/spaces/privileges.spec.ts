import { legacyColumns, permissionsFor, resolvePrivileges } from './privileges';

describe('privilégios dos grupos', () => {
  it('as colunas antigas continuam a contar para quem nunca gravou a matriz', () => {
    const m = resolvePrivileges({ privileges: {}, inviteBy: 'ADMINS', expensesBy: 'ALL', editBy: 'ADMINS' });
    expect(m.MEMBER.invite).toBe(false);
    expect(m.MEMBER.addExpense).toBe(true);
    expect(m.MEMBER.editOwn).toBe(false);
    expect(m.MEMBER.editAny).toBe(false);
    expect(m.ADMIN.invite).toBe(true);
  });

  it('a matriz guardada ganha às colunas antigas e o dono pode tudo', () => {
    const m = resolvePrivileges({ privileges: { MEMBER: { invite: true, plan: true }, ADMIN: { manageMembers: false } }, inviteBy: 'ADMINS', expensesBy: 'ALL', editBy: 'OWN' });
    expect(m.MEMBER.invite).toBe(true);
    expect(m.MEMBER.plan).toBe(true);
    expect(m.ADMIN.manageMembers).toBe(false);
    expect(permissionsFor('OWNER', m).manageMembers).toBe(true);
    expect(permissionsFor('ADMIN', m).manageMembers).toBe(false);
    expect(permissionsFor('MEMBER', m).manage).toBe(false);
    expect(legacyColumns(m)).toEqual({ inviteBy: 'ALL', expensesBy: 'ALL', editBy: 'OWN' });
  });
});
