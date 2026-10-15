import { SpaceRole } from '../generated/prisma/client';

/// O que se pode permitir, por papel (ADMIN e MEMBER; o dono pode sempre tudo).
export const SPACE_PERMISSIONS = ['invite', 'addExpense', 'editOwn', 'editAny', 'fund', 'goals', 'plan', 'chat', 'manageMembers'] as const;
export type SpacePermission = (typeof SPACE_PERMISSIONS)[number];
export type RolePrivileges = Record<SpacePermission, boolean>;
export type SpacePrivileges = Record<'ADMIN' | 'MEMBER', RolePrivileges>;

const ALL: RolePrivileges = { invite: true, addExpense: true, editOwn: true, editAny: true, fund: true, goals: true, plan: true, chat: true, manageMembers: true };
export const DEFAULT_PRIVILEGES: SpacePrivileges = {
  ADMIN: { ...ALL },
  MEMBER: { invite: true, addExpense: true, editOwn: true, editAny: false, fund: true, goals: true, plan: true, chat: true, manageMembers: false },
};

/// A matriz guardada (JSON) por cima dos valores por omissão. As colunas
/// antigas (inviteBy, expensesBy, editBy) continuam a contar para quem
/// nunca gravou a matriz.
export function resolvePrivileges(space: { privileges?: unknown; inviteBy?: string; expensesBy?: string; editBy?: string }): SpacePrivileges {
  const stored = (space.privileges && typeof space.privileges === 'object' ? (space.privileges as Partial<Record<'ADMIN' | 'MEMBER', Partial<RolePrivileges>>>) : {}) ?? {};
  const out: SpacePrivileges = { ADMIN: { ...DEFAULT_PRIVILEGES.ADMIN }, MEMBER: { ...DEFAULT_PRIVILEGES.MEMBER } };
  if (space.inviteBy === 'ADMINS') out.MEMBER.invite = false;
  if (space.expensesBy === 'ADMINS') out.MEMBER.addExpense = false;
  if (space.editBy === 'ADMINS') out.MEMBER.editOwn = false;
  for (const role of ['ADMIN', 'MEMBER'] as const) {
    for (const key of SPACE_PERMISSIONS) {
      const v = stored[role]?.[key];
      if (typeof v === 'boolean') out[role][key] = v;
    }
  }
  // Quem não pode registar despesas também não mexe nas dos outros.
  if (!out.MEMBER.editOwn) out.MEMBER.editAny = false;
  return out;
}

/// O que um membro pode fazer, dado o papel e a matriz.
export function permissionsFor(role: SpaceRole, matrix: SpacePrivileges): RolePrivileges & { manage: boolean; owner: boolean } {
  if (role === 'OWNER') return { ...ALL, manage: true, owner: true };
  const base = role === 'ADMIN' ? matrix.ADMIN : matrix.MEMBER;
  return { ...base, manage: role === 'ADMIN', owner: false };
}

/// As colunas antigas, derivadas da matriz (para quem lê o esquema antigo).
export function legacyColumns(matrix: SpacePrivileges) {
  return { inviteBy: matrix.MEMBER.invite ? 'ALL' : 'ADMINS', expensesBy: matrix.MEMBER.addExpense ? 'ALL' : 'ADMINS', editBy: matrix.MEMBER.editOwn ? 'OWN' : 'ADMINS' };
}
