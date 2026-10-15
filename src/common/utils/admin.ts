import { env } from '../../config/env';

/// As áreas da administração. Um admin com `adminAreas` vazio acede a todas;
/// com uma lista, só a essas (e nunca a tornar outros admins).
export const ADMIN_AREAS = ['overview', 'revenue', 'subscribers', 'users', 'countries', 'promo', 'institutions', 'feedback', 'ai'] as const;
export type AdminArea = (typeof ADMIN_AREAS)[number];

/// Administrador = papel ADMIN na base de dados ou email em ADMIN_EMAILS.
export function isAdminUser(user: { role: string; email: string }): boolean {
  if (user.role === 'ADMIN') return true;
  return isSuperAdminEmail(user.email);
}

/// Quem está em ADMIN_EMAILS manda em tudo (não dá para lhe tirar áreas).
export function isSuperAdminEmail(email: string): boolean {
  const emails = env()
    .ADMIN_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return emails.includes(email.toLowerCase());
}

/// null = acede a todas as áreas.
export function adminAreasOf(user: { role: string; email: string; adminAreas: string[] }): AdminArea[] | null {
  if (!isAdminUser(user)) return [];
  if (isSuperAdminEmail(user.email) || user.adminAreas.length === 0) return null;
  return user.adminAreas.filter((a): a is AdminArea => (ADMIN_AREAS as readonly string[]).includes(a));
}

export function canAccessArea(user: { role: string; email: string; adminAreas: string[] }, area: AdminArea): boolean {
  const areas = adminAreasOf(user);
  return areas === null || areas.includes(area);
}

/// A área a que cada rota /admin/... pertence (pelo primeiro troço do caminho).
export function areaOfPath(path: string): AdminArea | 'roles' | null {
  const seg = path.replace(/^\/+/, '').split('/');
  const i = seg.indexOf('admin');
  const first = seg[i + 1] ?? '';
  const third = seg[i + 3] ?? '';
  if (first === 'users' && third === 'role') return 'roles';
  const map: Record<string, AdminArea> = { overview: 'overview', revenue: 'revenue', payments: 'revenue', subscribers: 'subscribers', users: 'users', countries: 'countries', 'promo-codes': 'promo', institutions: 'institutions', feedback: 'feedback', ai: 'ai' };
  return map[first] ?? null;
}
