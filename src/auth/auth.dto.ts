import { z } from 'zod';

/// Data de nascimento: AAAA-MM-DD, entre os 13 e os 120 anos.
export const birthDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid date')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return false;
    const age = (Date.now() - d.getTime()) / (365.25 * 86_400_000);
    return age >= 13 && age <= 120;
  }, 'invalid age');

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  username: z.string().trim().toLowerCase().min(1).max(40),
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(1).max(128),
  country: z.string().trim().toUpperCase().length(2),
  birthDate: birthDateSchema,
  language: z.string().trim().min(2).max(10),
  languageSource: z.enum(['auto', 'manual']).default('auto'),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/).optional().or(z.literal('').transform(() => undefined)),
  timezone: z.string().trim().max(60).optional(),
  /// Origem ou campanha (ex.: \"instagram_pt\"), para saber de onde vêm as pessoas
  campaign: z.string().trim().max(60).optional(),
});
export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  login: z.string().trim().toLowerCase().min(1).max(160),
  password: z.string().min(1).max(128),
});
export type LoginDto = z.infer<typeof loginSchema>;

/// Entrar (ou criar conta) com o Google: a app manda o "ID token" que a
/// Google lhe deu; país, idioma e fuso só servem para uma conta nova.
export const googleSchema = z.object({
  idToken: z.string().min(20).max(4096),
  country: z.string().trim().toUpperCase().length(2).optional(),
  birthDate: birthDateSchema.optional(),
  language: z.string().trim().min(2).max(10).optional(),
  timezone: z.string().trim().max(60).optional(),
  /// Origem ou campanha (ex.: \"instagram_pt\"), para saber de onde vêm as pessoas
  campaign: z.string().trim().max(60).optional(),
});
export type GoogleDto = z.infer<typeof googleSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

export const forgotSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
});

export const resetSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  code: z.string().trim().regex(/^\d{6}$/),
  newPassword: z.string().min(1).max(128),
});

export const USERNAME_RE = /^[a-z0-9._]{3,24}$/;
const RESERVED = new Set(['admin', 'administrator', 'support', 'suporte', 'contalex', 'help', 'ajuda', 'root', 'system', 'me', 'null', 'undefined']);

export function isValidUsername(username: string) {
  return USERNAME_RE.test(username) && !RESERVED.has(username) && !/^[._]|[._]$/.test(username) && !username.includes('..');
}

/// Um username de partida para quem entra com o Google, tirado do email
/// ("Ana.Costa+x@gmail.com" → "ana.costa") ou, se não der, do nome.
/// Fica com 19 caracteres no máximo para ainda caberem uns algarismos.
export function usernameBase(email: string, name?: string | null): string {
  const clean = (value: string) =>
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, '.')
      .replace(/[._]{2,}/g, '.')
      .replace(/^[._]+|[._]+$/g, '');
  for (const source of [email.split('@')[0].split('+')[0], name ?? '']) {
    const candidate = clean(source).slice(0, 19).replace(/[._]+$/g, '');
    if (isValidUsername(candidate)) return candidate;
  }
  return 'user';
}

/// 8+ caracteres, com pelo menos uma letra e um número.
export function isStrongPassword(password: string) {
  return password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

export function isValidTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
