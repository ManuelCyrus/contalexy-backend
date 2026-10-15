import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomInt, randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { MailService } from '../mail/mail.service';
import { UsersService } from '../users/users.service';
import { GoogleVerifier } from '../google/google.verifier';
import { deviceInfo } from '../common/utils/device';
import { ApiException } from '../common/errors/api.exception';
import { Language, mailText, resolveLanguage } from '../common/i18n/messages';
import { env } from '../config/env';
import { countryInfo, countryTimezone, isCountry, isCurrency } from '../meta/countries.data';
import { DEFAULT_CATEGORIES } from '../categories/default-categories';
import { GoogleDto, isStrongPassword, isValidTimezone, isValidUsername, LoginDto, RegisterDto, usernameBase } from './auth.dto';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/// "15m" → 900 (segundos).
export function durationSeconds(value: string): number {
  const m = /^(\d+)\s*([smhd]?)$/.exec(value.trim());
  if (!m) return 900;
  const n = Number(m[1]);
  return m[2] === 'd' ? n * 86400 : m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}

/// De onde vem um pedido de entrada (para o histórico de logins).
export interface LoginContext {
  userAgent?: string;
  ip?: string | null;
}

export type LoginMethod = 'password' | 'google' | 'register' | 'reset';

/// O histórico guarda-se durante meio ano.
const LOGIN_HISTORY_DAYS = 180;

let cachedDummy: string | null = null;
const dummyHash = () => (cachedDummy ??= bcrypt.hashSync('dummy-password-never-valid-1', 11));

/// País de partida quando o telemóvel não diz qual é (conta criada com o Google).
const COUNTRY_BY_LANGUAGE: Record<Language, string> = { pt: 'PT', en: 'US', fr: 'FR', de: 'DE' };

interface NewUser {
  name: string;
  username: string;
  email: string;
  passwordHash: string | null;
  googleId?: string | null;
  emailVerifiedAt?: Date | null;
  avatarUrl?: string | null;
  country: string;
  language: string;
  languageSource: string;
  currency: string;
  phone?: string | null;
  birthDate?: Date | null;
  timezone: string;
  signupPlatform?: string | null;
  signupCampaign?: string | null;
}

/// Tentativas falhadas seguidas que bloqueiam a conta, e por quanto tempo.
const LOCK_ATTEMPTS = 8;
const LOCK_MINUTES = 15;

/// De onde veio o registo: android | ios | web, pelo navegador do pedido, e a campanha que a app indicou.
function signupOrigin(ctx: LoginContext, campaign?: string | null) {
  const info = deviceInfo(ctx.userAgent);
  const platform = info.os === 'Android' ? 'android' : info.os === 'iOS' ? 'ios' : info.client && info.client !== 'app' ? 'web' : info.client === 'app' ? 'app' : null;
  return { signupPlatform: platform, signupCampaign: campaign?.trim().slice(0, 60) || null };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly mail: MailService,
    private readonly googleVerifier: GoogleVerifier,
  ) {}

  async register(dto: RegisterDto, ctx: LoginContext = {}) {
    if (!isValidUsername(dto.username)) throw ApiException.badRequest('USERNAME_INVALID');
    if (!isStrongPassword(dto.password)) throw ApiException.badRequest('WEAK_PASSWORD');
    if (!isCountry(dto.country)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'country', message: 'unknown' }]);
    const currency = dto.currency ?? countryInfo(dto.country)?.currency ?? 'EUR';
    if (!isCurrency(currency)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'currency', message: 'unknown' }]);
    const language = resolveLanguage(dto.language);
    // O telemóvel nem sempre sabe dizer o fuso (nome IANA): usa-se o do país.
    const timezone = dto.timezone && isValidTimezone(dto.timezone) ? dto.timezone : (countryTimezone(dto.country) ?? 'UTC');

    const [emailTaken, usernameTaken] = await Promise.all([
      this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } }),
      this.prisma.user.findUnique({ where: { username: dto.username }, select: { id: true } }),
    ]);
    if (emailTaken) throw ApiException.conflict('EMAIL_TAKEN');
    if (usernameTaken) throw ApiException.conflict('USERNAME_TAKEN');

    const user = await this.createUser({
      name: dto.name,
      username: dto.username,
      email: dto.email,
      passwordHash: await bcrypt.hash(dto.password, 11),
      country: dto.country,
      language,
      languageSource: dto.languageSource,
      currency,
      phone: dto.phone ?? null,
      birthDate: new Date(`${dto.birthDate}T00:00:00Z`),
      timezone,
      ...signupOrigin(ctx, dto.campaign),
    });
    return this.session(user.id, user.email, ctx, 'register');
  }

  /// Cria a conta e tudo o que vem com ela: categorias de base e os convites
  /// que já estavam à espera deste email.
  private createUser(data: NewUser) {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data });
      await tx.category.createMany({
        data: DEFAULT_CATEGORIES.map((c, i) => ({ userId: created.id, key: c.key, type: c.type, icon: c.icon, color: c.color, sortOrder: i })),
      });
      // Convites para Spaces feitos para este email antes de a conta existir.
      await tx.spaceInvitation.updateMany({
        where: { email: data.email, inviteeId: null, status: 'PENDING' },
        data: { inviteeId: created.id },
      });
      // E os convites para acompanhar os gastos de alguém.
      await tx.sharedAccess.updateMany({
        where: { email: data.email, viewerId: null, status: 'PENDING', ownerId: { not: created.id } },
        data: { viewerId: created.id },
      });
      return created;
    });
  }

  async login(dto: LoginDto, ctx: LoginContext = {}) {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.login }, { username: dto.login.replace(/^@/, '') }] },
      select: { id: true, email: true, passwordHash: true },
    });
    // Conta bloqueada por uns minutos depois de muitas tentativas falhadas
    // (por conta, além do limite por IP): trava quem tenta adivinhar.
    if (user) {
      const failed = await this.prisma.loginEvent.count({ where: { userId: user.id, success: false, createdAt: { gte: new Date(Date.now() - LOCK_MINUTES * 60_000) } } });
      if (failed >= LOCK_ATTEMPTS) throw ApiException.tooManyRequests('LOGIN_LOCKED', { minutes: LOCK_MINUTES });
    }
    // Compara sempre (mesmo sem utilizador) para não revelar quem existe pelo tempo de resposta.
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? dummyHash());
    // Uma conta sem palavra-passe (só Google) nunca entra por aqui — nem com
    // a palavra-passe "de faz de conta" usada na comparação acima.
    if (!user || !user.passwordHash || !ok) {
      // A tentativa falhada fica no histórico da conta (a pessoa vê que alguém tentou).
      if (user) await this.recordLogin(user.id, 'password', false, ctx);
      throw ApiException.unauthorized('INVALID_CREDENTIALS');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
    // Entrar de novo cancela um pedido para apagar a conta.
    const deletionCancelled = await this.users.cancelDeletion(user.id);
    return { ...(await this.session(user.id, user.email, ctx, 'password')), deletionCancelled };
  }

  /// Entrar com o Google. Três casos:
  ///  1) a conta Google já está ligada a uma conta → entra;
  ///  2) já existe uma conta com esse email → fica ligada ao Google;
  ///  3) não existe → cria-se a conta (o username é sugerido a partir do email).
  /// Devolve a sessão e ainda `created` (conta nova) e `passwordCleared`.
  async google(dto: GoogleDto, ctx: LoginContext = {}) {
    const identity = await this.googleVerifier.verify(dto.idToken);
    if (!identity.emailVerified) throw ApiException.unauthorized('GOOGLE_EMAIL_NOT_VERIFIED');

    let created = false;
    let passwordCleared = false;
    let user = await this.prisma.user.findUnique({ where: { googleId: identity.sub }, select: { id: true, email: true } });

    if (!user) {
      const existing = await this.prisma.user.findUnique({
        where: { email: identity.email },
        select: { id: true, email: true, passwordHash: true, emailVerifiedAt: true, googleId: true },
      });
      if (existing?.googleId) {
        // O email já pertence a uma conta ligada a OUTRA conta Google.
        throw ApiException.conflict('EMAIL_TAKEN');
      } else if (existing) {
        // No registo o email não é confirmado: quem criou esta conta pode não
        // ser o dono do email. A Google acabou de provar quem é o dono, por
        // isso a palavra-passe antiga deixa de servir e as outras sessões
        // fecham-se (senão, quem registou o email de outra pessoa continuava
        // a conseguir entrar). Se o email já estava confirmado, fica tudo.
        passwordCleared = !existing.emailVerifiedAt && !!existing.passwordHash;
        await this.prisma.$transaction([
          this.prisma.user.update({
            where: { id: existing.id },
            data: {
              googleId: identity.sub,
              emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
              ...(passwordCleared ? { passwordHash: null } : {}),
            },
          }),
          ...(passwordCleared ? [this.prisma.refreshToken.updateMany({ where: { userId: existing.id, revokedAt: null }, data: { revokedAt: new Date() } })] : []),
        ]);
        user = { id: existing.id, email: existing.email };
      } else {
        const language = resolveLanguage(dto.language);
        const country = dto.country && isCountry(dto.country) ? dto.country : COUNTRY_BY_LANGUAGE[language];
        const newUser = await this.createUser({
          name: (identity.name ?? identity.email.split('@')[0]).slice(0, 80),
          username: await this.freeUsername(identity.email, identity.name),
          email: identity.email,
          passwordHash: null,
          googleId: identity.sub,
          emailVerifiedAt: new Date(),
          avatarUrl: identity.picture,
          country,
          language,
          languageSource: 'auto',
          currency: countryInfo(country)?.currency ?? 'EUR',
          birthDate: dto.birthDate ? new Date(`${dto.birthDate}T00:00:00Z`) : null,
          timezone: dto.timezone && isValidTimezone(dto.timezone) ? dto.timezone : (countryTimezone(country) ?? 'UTC'),
          ...signupOrigin(ctx, dto.campaign),
        });
        user = { id: newUser.id, email: newUser.email };
        created = true;
      }
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
    const deletionCancelled = created ? false : await this.users.cancelDeletion(user.id);
    return { ...(await this.session(user.id, user.email, ctx, 'google')), created, passwordCleared, deletionCancelled };
  }

  /// Um username livre para uma conta criada com o Google ("ana.costa",
  /// "ana.costa27"…). A pessoa pode mudá-lo depois no perfil.
  private async freeUsername(email: string, name: string | null) {
    const base = usernameBase(email, name);
    const candidates = [
      ...(base === 'user' ? [] : [base]),
      ...Array.from({ length: 4 }, () => `${base}${randomInt(10, 100)}`),
      ...Array.from({ length: 6 }, () => `${base}${randomInt(1000, 100000)}`),
    ];
    for (const candidate of candidates) {
      if (!isValidUsername(candidate)) continue;
      const taken = await this.prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
      if (!taken) return candidate;
    }
    return `user${randomBytes(6).toString('hex')}`;
  }

  /// Troca o refresh token por um novo (o antigo deixa de servir). Se um
  /// token já usado aparecer outra vez, alguém o copiou: fecham-se todas
  /// as sessões dessa pessoa.
  async refresh(refreshToken: string, ctx: LoginContext = {}) {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!record) throw ApiException.unauthorized('SESSION_EXPIRED');
    if (record.revokedAt) {
      await this.prisma.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw ApiException.unauthorized('SESSION_EXPIRED');
    }
    if (record.expiresAt < new Date()) throw ApiException.unauthorized('SESSION_EXPIRED');
    await this.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    await this.prisma.user.update({ where: { id: record.userId }, data: { lastActiveAt: new Date() } });
    // A sessão é a mesma: só o token é que muda.
    return this.tokens(record.user.id, record.user.email, ctx, record.sessionId ?? randomUUID());
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha256(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  /// Manda um código de 6 dígitos por email. Responde sempre "ok" (não
  /// diz se o email existe).
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, name: true, email: true, language: true } });
    if (!user) return { ok: true };
    const recent = await this.prisma.passwordReset.count({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 3600_000) } } });
    if (recent >= 3) return { ok: true };
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.passwordReset.create({
      data: { userId: user.id, codeHash: sha256(`${user.id}:${code}`), expiresAt: new Date(Date.now() + 15 * 60_000) },
    });
    const lang = resolveLanguage(user.language);
    await this.mail.send(user.email, mailText('reset.subject', lang), mailText('reset.body', lang, { name: user.name.split(' ')[0], code }));
    return { ok: true };
  }

  async resetPassword(email: string, code: string, newPassword: string, ctx: LoginContext = {}) {
    if (!isStrongPassword(newPassword)) throw ApiException.badRequest('WEAK_PASSWORD');
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, email: true, emailVerifiedAt: true } });
    if (!user) throw ApiException.badRequest('RESET_CODE_INVALID');
    const reset = await this.prisma.passwordReset.findFirst({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!reset) throw ApiException.badRequest('RESET_CODE_INVALID');
    if (reset.attempts >= 5) throw ApiException.badRequest('TOO_MANY_ATTEMPTS');
    if (reset.codeHash !== sha256(`${user.id}:${code}`)) {
      await this.prisma.passwordReset.update({ where: { id: reset.id }, data: { attempts: { increment: 1 } } });
      throw ApiException.badRequest('RESET_CODE_INVALID');
    }
    await this.prisma.$transaction([
      // Quem recebeu o código no email provou que o email é seu.
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(newPassword, 11), emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
      }),
      this.prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      this.prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    const deletionCancelled = await this.users.cancelDeletion(user.id);
    return { ...(await this.session(user.id, user.email, ctx, 'reset')), deletionCancelled };
  }

  async usernameAvailable(username: string) {
    const normalized = username.trim().toLowerCase();
    if (!isValidUsername(normalized)) return { valid: false, available: false };
    const taken = await this.prisma.user.findUnique({ where: { username: normalized }, select: { id: true } });
    return { valid: true, available: !taken };
  }

  /// Abre uma sessão nova (um aparelho que entrou) e regista-a no histórico.
  async session(userId: string, email: string, ctx: LoginContext = {}, method: LoginMethod = 'password') {
    const sessionId = randomUUID();
    const tokens = await this.tokens(userId, email, ctx, sessionId);
    await this.recordLogin(userId, method, true, ctx, sessionId);
    return { ...tokens, user: await this.users.me(userId) };
  }

  async tokens(userId: string, email: string, ctx: LoginContext, sessionId: string) {
    const expiresIn = durationSeconds(env().JWT_ACCESS_EXPIRES_IN);
    const accessToken = await this.jwt.signAsync({ sub: userId, email, sid: sessionId }, { secret: env().JWT_ACCESS_SECRET, expiresIn });
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        userAgent: ctx.userAgent?.slice(0, 200) ?? null,
        ip: ctx.ip ?? null,
        sessionId,
        expiresAt: new Date(Date.now() + env().REFRESH_TOKEN_DAYS * 86_400_000),
      },
    });
    return { accessToken, refreshToken, expiresIn };
  }

  /// Uma linha no histórico de entradas. Nunca estraga o login se falhar.
  private async recordLogin(userId: string, method: LoginMethod, success: boolean, ctx: LoginContext, sessionId?: string) {
    try {
      await this.prisma.loginEvent.create({
        data: { userId, method, success, userAgent: ctx.userAgent?.slice(0, 200) ?? null, ip: ctx.ip ?? null, sessionId: sessionId ?? null },
      });
      await this.prisma.loginEvent.deleteMany({ where: { userId, createdAt: { lt: new Date(Date.now() - LOGIN_HISTORY_DAYS * 86_400_000) } } });
    } catch (err) {
      this.logger.warn(`Não foi possível registar a entrada: ${(err as Error).message}`);
    }
  }
}
