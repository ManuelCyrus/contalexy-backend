import { z } from 'zod';
import { birthDateSchema } from '../auth/auth.dto';

export const updateMeSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /// "Sobre mim" (vazio apaga)
  bio: z.string().trim().max(160).nullable().optional(),
  username: z.string().trim().toLowerCase().min(1).max(40).optional(),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/).nullable().optional(),
  country: z.string().trim().toUpperCase().length(2).optional(),
  birthDate: birthDateSchema.optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  language: z.string().trim().min(2).max(10).optional(),
  languageSource: z.enum(['auto', 'manual']).optional(),
  timezone: z.string().trim().max(60).optional(),
  monthStartDay: z.number().int().min(1).max(28).optional(),
  weekStartsOn: z.union([z.literal(1), z.literal(7)]).optional(),
  notificationPrefs: z.record(z.string().max(30), z.boolean()).optional(),
});
export type UpdateMeDto = z.infer<typeof updateMeSchema>;

export const changePasswordSchema = z.object({
  /// Dispensada em contas que ainda não têm palavra-passe (entraram com o Google).
  currentPassword: z.string().max(128).optional(),
  newPassword: z.string().min(1).max(128),
});

/// Apagar a conta pede uma confirmação forte: a palavra-passe ou, em contas
/// que só entram com o Google, um ID token acabado de pedir à Google.
export const deleteAccountSchema = z.object({
  password: z.string().max(128).optional(),
  idToken: z.string().max(4096).optional(),
});

export const pushTokenSchema = z.object({
  token: z.string().min(10).max(4096),
  platform: z.enum(['android', 'ios', 'web']),
});
