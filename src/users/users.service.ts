import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { SubscriptionsService } from '../billing/subscriptions.service';
import { StorageService, UploadedFileLike } from '../storage/storage.service';
import { GoogleVerifier } from '../google/google.verifier';
import { ApiException } from '../common/errors/api.exception';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { mailText, resolveLanguage } from '../common/i18n/messages';
import { deviceInfo } from '../common/utils/device';
import { env, isTrue } from '../config/env';
import { countryTimezone, isCountry, isCurrency } from '../meta/countries.data';
import { isStrongPassword, isValidTimezone, isValidUsername } from '../auth/auth.dto';
import { UpdateMeDto } from './users.dto';
import { fromDbDate } from '../common/utils/dates';
import { num, round2 } from '../common/utils/money';
import { adminAreasOf, isAdminUser } from '../common/utils/admin';
import { helpSections } from '../sharing/help';

const DEFAULT_PREFS = { budgets: true, reminders: true, loans: true, spaces: true, sharing: true, goals: true, account: true, messages: true };

/// Quanto tempo uma conta fica "a apagar" antes de desaparecer de vez.
export const DELETION_DAYS = 30;

/// O cartão de uma pessoa, como os outros a veem (nunca o email nem o telefone).
const personCard = { id: true, name: true, username: true, avatarUrl: true } as const;
const helpOf = (a?: { sections: string[]; manageSections: string[]; hiddenCategoryIds: string[] }) => (a ? helpSections(a) : []);

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly storage: StorageService,
    private readonly googleVerifier: GoogleVerifier,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  /// O perfil da própria pessoa + o plano (para a app decidir o que mostra).
  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    const subscription = await this.subscriptions.summary(userId);
    return {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      phone: user.phone,
      birthDate: user.birthDate ? user.birthDate.toISOString().slice(0, 10) : null,
      country: user.country,
      language: user.language,
      languageSource: user.languageSource,
      currency: user.currency,
      timezone: user.timezone,
      monthStartDay: user.monthStartDay,
      weekStartsOn: user.weekStartsOn,
      notificationPrefs: { ...DEFAULT_PREFS, ...((user.notificationPrefs ?? {}) as Record<string, boolean>) },
      onboarded: !!user.onboardedAt,
      /// false = entrou com o Google e ainda não definiu uma palavra-passe
      hasPassword: !!user.passwordHash,
      /// A conta está ligada a uma conta Google
      googleLinked: !!user.googleId,
      /// Pode entrar na área de administração (/admin)
      isAdmin: isAdminUser(user),
      /// Áreas da administração a que acede (vazio = todas; só faz sentido se isAdmin)
      adminAreas: adminAreasOf(user),
      /// Há um pedido para apagar a conta (entrar de novo cancela-o)
      deletion: user.deletionScheduledFor ? { requestedAt: user.deletionRequestedAt, scheduledFor: user.deletionScheduledFor } : null,
      createdAt: user.createdAt,
      plan: {
        code: subscription.plan,
        state: subscription.state,
        /// STORE (pago) | PROMO (código) | GRANT (oferta) | DEV — null no plano grátis
        source: subscription.source,
        expirationDate: subscription.expirationDate,
        autoRenew: subscription.autoRenew,
        platform: subscription.platform,
        /// SUBSCRIPTION (renova sozinha) | ONE_TIME (paga uma vez) — e o produto da loja
        kind: subscription.kind,
        productId: subscription.productId,
        /// Há uma subscrição que ainda vai renovar (pode cancelar-se na loja)
        canCancel: subscription.canCancel,
        billingIssue: subscription.billingIssue,
        refunded: subscription.refunded,
        /// Quantas coisas ficaram fechadas por já não ter o plano com que foram criadas
        locked: subscription.locked,
        features: subscription.features,
        limits: subscription.limits,
        blockedAreas: subscription.blockedAreas,
      },
    };
  }

  async update(userId: string, dto: UpdateMeDto) {
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.bio !== undefined) data.bio = dto.bio?.trim() || null;
    if (dto.username !== undefined) {
      if (!isValidUsername(dto.username)) throw ApiException.badRequest('USERNAME_INVALID');
      const taken = await this.prisma.user.findFirst({ where: { username: dto.username, NOT: { id: userId } }, select: { id: true } });
      if (taken) throw ApiException.conflict('USERNAME_TAKEN');
      data.username = dto.username;
    }
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.birthDate !== undefined) data.birthDate = new Date(`${dto.birthDate}T00:00:00Z`);
    if (dto.country !== undefined) {
      if (!isCountry(dto.country)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'country', message: 'unknown' }]);
      data.country = dto.country;
    }
    if (dto.currency !== undefined) {
      if (!isCurrency(dto.currency)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'currency', message: 'unknown' }]);
      data.currency = dto.currency;
    }
    if (dto.language !== undefined) {
      data.language = resolveLanguage(dto.language);
      // Escolhido à mão fica (mesmo que o telemóvel mude de idioma).
      data.languageSource = dto.languageSource ?? 'manual';
    } else if (dto.languageSource !== undefined) {
      data.languageSource = dto.languageSource;
    }
    if (dto.timezone !== undefined && isValidTimezone(dto.timezone)) {
      data.timezone = dto.timezone;
    } else if (dto.country !== undefined) {
      // Mudou de país sem dizer o fuso: passa para o fuso do país novo
      // (se o atual era o do país antigo ou UTC).
      const current = await this.prisma.user.findUnique({ where: { id: userId }, select: { country: true, timezone: true } });
      const next = countryTimezone(dto.country);
      if (current && next && (current.timezone === 'UTC' || current.timezone === countryTimezone(current.country))) data.timezone = next;
    }
    if (dto.monthStartDay !== undefined) data.monthStartDay = dto.monthStartDay;
    if (dto.weekStartsOn !== undefined) data.weekStartsOn = dto.weekStartsOn;
    if (dto.notificationPrefs !== undefined) {
      const current = await this.prisma.user.findUnique({ where: { id: userId }, select: { notificationPrefs: true } });
      data.notificationPrefs = { ...((current?.notificationPrefs ?? {}) as object), ...dto.notificationPrefs };
    }
    if (Object.keys(data).length) await this.prisma.user.update({ where: { id: userId }, data });
    return this.me(userId);
  }

  async completeOnboarding(userId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { onboardedAt: new Date() } });
    return this.me(userId);
  }

  async setAvatar(userId: string, file: UploadedFileLike | undefined) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
    const saved = await this.storage.save(file as UploadedFileLike, 'avatars', { imagesOnly: true });
    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl: this.storage.publicUrl(saved.key) } });
    await this.removeOwnAvatar(user?.avatarUrl);
    return this.me(userId);
  }

  async removeAvatar(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl: null } });
    await this.removeOwnAvatar(user?.avatarUrl);
    return this.me(userId);
  }

  private async removeOwnAvatar(url: string | null | undefined) {
    const marker = '/public/';
    if (url && url.includes(`${marker}avatars/`)) await this.storage.remove(url.slice(url.indexOf(marker) + marker.length));
    else if (url && url.startsWith(this.storage.publicUrl('avatars/'))) await this.storage.remove(url.slice(url.indexOf('avatars/')));
  }

  /// Muda a palavra-passe — ou define a primeira, em contas que entraram com
  /// o Google (aí não há palavra-passe atual para confirmar).
  async changePassword(userId: string, currentPassword: string | undefined, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    if (user.passwordHash && !(currentPassword && (await bcrypt.compare(currentPassword, user.passwordHash)))) throw ApiException.badRequest('WRONG_PASSWORD');
    if (!isStrongPassword(newPassword)) throw ApiException.badRequest('WEAK_PASSWORD');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(newPassword, 11) } }),
      // Termina as sessões nos outros aparelhos.
      this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return { ok: true };
  }

  // ----------------------------------------------------------------
  // Apagar a conta (com 30 dias para voltar atrás)
  // ----------------------------------------------------------------

  /// Pedido para apagar a conta. Não se apaga logo: fica marcada, as sessões
  /// fecham-se e a pessoa recebe um email a dizer em que dia desaparece. Se
  /// voltar a entrar antes disso, o pedido é cancelado (ver cancelDeletion).
  async requestDeletion(userId: string, confirm: { password?: string; idToken?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, googleId: true, name: true, email: true, language: true, country: true, timezone: true },
    });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    if (user.passwordHash) {
      if (!confirm.password || !(await bcrypt.compare(confirm.password, user.passwordHash))) throw ApiException.badRequest('WRONG_PASSWORD');
    } else {
      // Sem palavra-passe (conta só com Google): confirma-se voltando a
      // entrar com a MESMA conta Google.
      if (!confirm.idToken) throw ApiException.badRequest('GOOGLE_CONFIRM_REQUIRED');
      const identity = await this.googleVerifier.verify(confirm.idToken);
      if (identity.sub !== user.googleId) throw ApiException.badRequest('GOOGLE_ACCOUNT_MISMATCH');
    }

    const now = new Date();
    const scheduledFor = new Date(now.getTime() + DELETION_DAYS * 86_400_000);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { deletionRequestedAt: now, deletionScheduledFor: scheduledFor } }),
      // Sai de todos os aparelhos: "entrar de novo" passa a ser um gesto claro.
      this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.pushToken.deleteMany({ where: { userId } }),
    ]);
    const lang = resolveLanguage(user.language);
    const params = { name: user.name.split(' ')[0], days: DELETION_DAYS, date: this.longDate(scheduledFor, lang, user.country, user.timezone) };
    await this.mail.send(user.email, mailText('deletion.subject', lang, params), mailText('deletion.body', lang, params));
    return { scheduled: true, days: DELETION_DAYS, deleteAt: scheduledFor };
  }

  private longDate(date: Date, lang: string, country: string, timezone: string) {
    try {
      return new Intl.DateTimeFormat([`${lang}-${country}`, lang, 'en'], { day: 'numeric', month: 'long', year: 'numeric', timeZone: timezone }).format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  /// A pessoa voltou a entrar: se havia um pedido para apagar a conta, fica
  /// cancelado. Devolve true quando cancelou alguma coisa.
  async cancelDeletion(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { deletionRequestedAt: true, name: true, email: true, language: true } });
    if (!user?.deletionRequestedAt) return false;
    await this.prisma.user.update({ where: { id: userId }, data: { deletionRequestedAt: null, deletionScheduledFor: null } });
    await this.notifications.notify(userId, 'account_deletion_cancelled', {});
    const lang = resolveLanguage(user.language);
    const params = { name: user.name.split(' ')[0] };
    await this.mail.send(user.email, mailText('deletionCancelled.subject', lang, params), mailText('deletionCancelled.body', lang, params)).catch(() => undefined);
    return true;
  }

  /// Todas as noites: apaga de vez as contas cujo prazo já passou.
  @Cron('40 3 * * *')
  async purgeJob() {
    if (!isTrue(env().JOBS_ENABLED)) return;
    await this.purgeDue();
  }

  async purgeDue(now = new Date()) {
    const due = await this.prisma.user.findMany({
      where: { deletionScheduledFor: { not: null, lte: now } },
      select: { id: true, name: true, email: true, language: true },
      take: 200,
    });
    let purged = 0;
    for (const user of due) {
      try {
        await this.purgeAccount(user.id);
        purged++;
        const lang = resolveLanguage(user.language);
        const params = { name: user.name.split(' ')[0] };
        await this.mail.send(user.email, mailText('deleted.subject', lang, params), mailText('deleted.body', lang, params)).catch(() => undefined);
      } catch (err) {
        this.logger.error(`Não foi possível apagar a conta ${user.id}: ${(err as Error).message}`);
      }
    }
    if (purged) this.logger.log(`Contas apagadas (prazo de ${DELETION_DAYS} dias): ${purged}.`);
    return purged;
  }

  /// Apaga a conta e todos os dados. Nos Spaces partilhados, as despesas
  /// ficam para os outros (sem o nome da pessoa) e, se era o dono, passa
  /// a dono quem estiver há mais tempo.
  async purgeAccount(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } });
    if (!user) return { deleted: false };
    const owned = await this.prisma.spaceMember.findMany({ where: { userId, role: 'OWNER' }, select: { spaceId: true } });
    for (const { spaceId } of owned) {
      const heir = await this.prisma.spaceMember.findFirst({
        where: { spaceId, userId: { not: userId } },
        orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      });
      if (heir) await this.prisma.spaceMember.update({ where: { id: heir.id }, data: { role: 'OWNER' } });
      else await this.prisma.space.delete({ where: { id: spaceId } });
    }
    const files = await this.prisma.attachment.findMany({ where: { userId, spaceExpenseId: null }, select: { storageKey: true } });
    await this.prisma.attachment.deleteMany({ where: { userId, spaceExpenseId: null } });
    // As mensagens que escreveu e as conversas a dois em que estava vão com a conta.
    const direct = [{ directKey: { startsWith: `${userId}:` } }, { directKey: { endsWith: `:${userId}` } }];
    await this.prisma.message.deleteMany({ where: { OR: [{ senderId: userId }, ...direct] } });
    await this.prisma.chatRead.deleteMany({ where: { thread: { startsWith: 'direct:', contains: userId } } });
    await this.prisma.user.delete({ where: { id: userId } });
    for (const f of files) await this.storage.remove(f.storageKey);
    await this.removeOwnAvatar(user.avatarUrl);
    return { deleted: true };
  }

  // ----------------------------------------------------------------
  // Histórico de entradas e sessões
  // ----------------------------------------------------------------

  /// Onde a conta está aberta agora (`sessions`) e as últimas entradas —
  /// incluindo as tentativas falhadas (`history`).
  async logins(userId: string, currentSessionId: string | null, limit = 40) {
    const now = new Date();
    const [events, tokens] = await Promise.all([
      this.prisma.loginEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(limit, 1), 100) }),
      this.prisma.refreshToken.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: now }, sessionId: { not: null } },
        select: { sessionId: true, createdAt: true, userAgent: true, ip: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const active = new Map<string, (typeof tokens)[number]>();
    for (const t of tokens) if (t.sessionId && !active.has(t.sessionId)) active.set(t.sessionId, t);
    const startedAt = new Map(events.filter((e) => e.sessionId).map((e) => [e.sessionId as string, e]));
    return {
      sessions: [...active.entries()]
        .map(([sessionId, t]) => ({
          sessionId,
          current: sessionId === currentSessionId,
          device: deviceInfo(t.userAgent),
          ip: t.ip,
          /// Quando esta sessão começou (null = antes de haver histórico)
          startedAt: startedAt.get(sessionId)?.createdAt ?? null,
          method: startedAt.get(sessionId)?.method ?? null,
          lastSeenAt: t.createdAt,
        }))
        .sort((a, b) => (a.current === b.current ? b.lastSeenAt.getTime() - a.lastSeenAt.getTime() : a.current ? -1 : 1)),
      history: events.map((e) => ({
        id: e.id,
        method: e.method,
        success: e.success,
        createdAt: e.createdAt,
        device: deviceInfo(e.userAgent),
        ip: e.ip,
        active: !!e.sessionId && active.has(e.sessionId),
        current: !!e.sessionId && e.sessionId === currentSessionId,
      })),
    };
  }

  /// Termina a sessão num aparelho (deixa de conseguir renovar o acesso).
  /// Os tokens apagam-se — não ficam "revogados" — para que o aparelho, ao
  /// tentar renovar, só perca a sessão dele (um token revogado que volta a
  /// aparecer é tratado como roubo e fecha TODAS as sessões).
  async revokeSession(userId: string, sessionId: string, currentSessionId: string | null) {
    const active = await this.prisma.refreshToken.count({ where: { userId, sessionId, revokedAt: null } });
    if (!active) throw ApiException.notFound('SESSION_NOT_FOUND');
    await this.prisma.refreshToken.deleteMany({ where: { userId, sessionId } });
    return this.logins(userId, currentSessionId);
  }

  /// Termina a sessão em todos os outros aparelhos.
  async revokeOtherSessions(userId: string, currentSessionId: string | null) {
    // Sem saber qual é a sessão atual não se fecha nada (fechava-se esta também).
    if (currentSessionId) {
      await this.prisma.refreshToken.deleteMany({ where: { userId, OR: [{ sessionId: null }, { sessionId: { not: currentSessionId } }] } });
    }
    return this.logins(userId, currentSessionId);
  }

  /// Todos os dados da pessoa (RGPD).
  async exportData(userId: string) {
    const [user, accounts, categories, transactions, recurring, budgets, goals, plans, rules, filters, prices, spaces, loans, monthlyPlans, sharing, logins, fundDeposits, messages] = await Promise.all([
      this.me(userId),
      this.prisma.account.findMany({ where: { userId } }),
      this.prisma.category.findMany({ where: { userId } }),
      this.prisma.transaction.findMany({ where: { userId }, orderBy: { date: 'asc' } }),
      this.prisma.recurringRule.findMany({ where: { userId } }),
      this.prisma.budget.findMany({ where: { userId } }),
      this.prisma.goal.findMany({ where: { userId }, include: { contributions: true, steps: true } }),
      this.prisma.plan.findMany({ where: { userId }, include: { items: true } }),
      this.prisma.categoryRule.findMany({ where: { userId } }),
      this.prisma.savedFilter.findMany({ where: { userId } }),
      this.prisma.priceRecord.findMany({ where: { userId } }),
      this.prisma.spaceMember.findMany({ where: { userId }, include: { space: { select: { id: true, name: true, currency: true } } } }),
      this.prisma.loan.findMany({ where: { userId }, include: { payments: true } }),
      this.prisma.monthlyPlan.findMany({ where: { userId }, include: { lines: true } }),
      this.prisma.sharedAccess.findMany({ where: { OR: [{ ownerId: userId }, { viewerId: userId }] }, include: { notes: { where: { authorId: userId } } } }),
      this.prisma.loginEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { method: true, success: true, userAgent: true, ip: true, createdAt: true } }),
      // O que pus e tirei dos fundos comuns, e as mensagens que escrevi
      this.prisma.spaceDeposit.findMany({ where: { userId }, orderBy: { date: 'asc' }, select: { spaceId: true, amount: true, currency: true, date: true, note: true, goalId: true } }),
      this.prisma.message.findMany({ where: { senderId: userId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { spaceId: true, directKey: true, text: true, createdAt: true } }),
    ]);
    const plain = (rows: unknown) => JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    return {
      exportedAt: new Date().toISOString(),
      user,
      accounts: plain(accounts),
      categories: plain(categories),
      transactions: plain(transactions.map((t) => ({ ...t, date: fromDbDate(t.date), amount: num(t.amount) }))),
      recurring: plain(recurring),
      budgets: plain(budgets),
      goals: plain(goals),
      plans: plain(plans),
      rules: plain(rules),
      savedFilters: plain(filters),
      prices: plain(prices),
      spaces: plain(spaces.map((m) => ({ role: m.role, joinedAt: m.joinedAt, space: m.space }))),
      loans: plain(loans),
      monthlyPlans: plain(monthlyPlans),
      sharing: plain(sharing),
      logins: plain(logins),
      spaceDeposits: plain(fundDeposits.map((d) => ({ ...d, date: fromDbDate(d.date), amount: num(d.amount) }))),
      messages: plain(messages),
    };
  }

  async registerPushToken(userId: string, token: string, platform: string) {
    await this.prisma.pushToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
    return { ok: true };
  }

  async removePushToken(userId: string, token: string) {
    await this.prisma.pushToken.deleteMany({ where: { userId, token } });
    return { ok: true };
  }

  // ----------------------------------------------------------------
  // Pedidos à espera da minha resposta
  // ----------------------------------------------------------------

  /// Tudo o que outras pessoas me pediram e ainda não respondi, num sítio só:
  /// convites para Spaces, convites para acompanhar gastos, empréstimos por
  /// confirmar e planos do mês que me enviaram.
  async requests(userId: string) {
    const now = new Date();
    const [spaces, shares, loans, offers, sentItems] = await Promise.all([
      this.prisma.spaceInvitation.findMany({
        where: { inviteeId: userId, status: 'PENDING', expiresAt: { gt: now } },
        include: { inviter: { select: personCard }, space: { select: { id: true, name: true, type: true, icon: true, color: true, currency: true, _count: { select: { members: true } } } } },
        take: 30,
      }),
      this.prisma.sharedAccess.findMany({ where: { viewerId: userId, status: 'PENDING' }, include: { owner: { select: personCard } }, take: 30 }),
      this.prisma.loan.findMany({ where: { counterpartId: userId, linkStatus: 'PENDING', status: 'OPEN' }, include: { user: { select: personCard } }, take: 30 }),
      this.prisma.monthlyPlanOffer.findMany({ where: { toUserId: userId, status: 'PENDING' }, include: { from: { select: personCard } }, take: 30 }),
      this.prisma.itemOffer.findMany({ where: { toUserId: userId, status: 'PENDING' }, include: { from: { select: personCard } }, take: 30 }),
    ]);
    const items = [
      ...spaces.map((i) => ({
        kind: 'space' as const,
        id: i.id,
        createdAt: i.createdAt,
        from: i.inviter,
        space: { id: i.space.id, name: i.space.name, type: i.space.type, icon: i.space.icon, color: i.space.color, currency: i.space.currency, membersCount: i.space._count.members },
      })),
      ...shares.map((a) => ({ kind: 'sharing' as const, id: a.id, createdAt: a.createdAt, from: a.owner, scope: a.scope, sections: a.sections })),
      ...loans.map((l) => ({
        kind: 'loan' as const,
        id: l.id,
        createdAt: l.createdAt,
        from: l.user,
        // Do meu lado: se a pessoa emprestou, eu devo.
        direction: l.direction === 'LENT' ? ('BORROWED' as const) : ('LENT' as const),
        amount: num(l.amount),
        currency: l.currency,
      })),
      ...offers.map((o) => ({ kind: 'plan' as const, id: o.id, createdAt: o.createdAt, from: o.from, periodKey: o.periodKey, proposal: o.accessId !== null, note: o.note })),
      // Objetivos, planos e limites que me enviaram como modelo
      ...sentItems.map((o) => ({ kind: 'item' as const, id: o.id, createdAt: o.createdAt, from: o.from, itemKind: o.kind, title: o.title, note: o.note })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { count: items.length, items };
  }

  // ----------------------------------------------------------------
  // Outras pessoas: procurar e ver o perfil
  // ----------------------------------------------------------------

  /// Procura uma pessoa pelo username exato (para convidar, emprestar…).
  async findByUsername(username: string) {
    const user = await this.prisma.user.findFirst({
      where: { username: username.trim().toLowerCase().replace(/^@/, ''), deletionRequestedAt: null },
      select: personCard,
    });
    if (!user) throw ApiException.notFound('USER_NOT_FOUND');
    return user;
  }

  /// As pessoas com quem já tenho alguma coisa em comum: Spaces,
  /// acompanhamento de gastos ou empréstimos ligados.
  async contactIds(userId: string): Promise<Set<string>> {
    const [spaces, shares, loans] = await Promise.all([
      this.prisma.spaceMember.findMany({ where: { space: { members: { some: { userId } } }, userId: { not: userId } }, select: { userId: true }, take: 500 }),
      this.prisma.sharedAccess.findMany({ where: { status: { in: ['ACTIVE', 'PENDING'] }, OR: [{ ownerId: userId }, { viewerId: userId }] }, select: { ownerId: true, viewerId: true } }),
      this.prisma.loan.findMany({ where: { counterpartId: { not: null }, OR: [{ userId }, { counterpartId: userId }] }, select: { userId: true, counterpartId: true }, take: 500 }),
    ]);
    const ids = new Set<string>();
    for (const m of spaces) ids.add(m.userId);
    for (const a of shares) for (const id of [a.ownerId, a.viewerId]) if (id) ids.add(id);
    for (const l of loans) for (const id of [l.userId, l.counterpartId]) if (id) ids.add(id);
    ids.delete(userId);
    return ids;
  }

  /// Sugestões enquanto se escreve um nome: primeiro quem já conheço (pelo
  /// nome ou username); de fora, só quem tem exatamente esse @username —
  /// não se anda a listar desconhecidos.
  async search(userId: string, q: string) {
    const term = q.trim().replace(/^@/, '');
    const contacts = await this.contactIds(userId);
    const known = contacts.size
      ? await this.prisma.user.findMany({
          where: {
            id: { in: [...contacts] },
            deletionRequestedAt: null,
            ...(term ? { OR: [{ name: { contains: term, mode: 'insensitive' } }, { username: { contains: term.toLowerCase() } }] } : {}),
          },
          select: personCard,
          orderBy: { name: 'asc' },
          take: 8,
        })
      : [];
    const items = known.map((u) => ({ ...u, known: true }));
    if (term && isValidUsername(term.toLowerCase())) {
      const exact = await this.prisma.user.findFirst({ where: { username: term.toLowerCase(), deletionRequestedAt: null, id: { not: userId } }, select: personCard });
      if (exact && !items.some((u) => u.id === exact.id)) items.unshift({ ...exact, known: contacts.has(exact.id) });
    }
    return items.slice(0, 8);
  }

  /// O perfil de outra pessoa: quem é e o que temos em comum (Spaces,
  /// empréstimos ligados, acompanhamento). Nunca mostra email, telefone ou saldos.
  async profile(viewerId: string, userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { ...personCard, bio: true, createdAt: true } });
    if (!user) throw ApiException.notFound('USER_NOT_FOUND');
    const isMe = viewerId === userId;
    const [spaces, loans, shares] = isMe
      ? [[], [], []]
      : await Promise.all([
          this.prisma.space.findMany({
            where: { archivedAt: null, AND: [{ members: { some: { userId: viewerId } } }, { members: { some: { userId } } }] },
            select: { id: true, name: true, icon: true, color: true, type: true },
            orderBy: { createdAt: 'asc' },
            take: 20,
          }),
          this.prisma.loan.findMany({
            where: { status: 'OPEN', linkStatus: 'ACCEPTED', OR: [{ userId: viewerId, counterpartId: userId }, { userId, counterpartId: viewerId }] },
            include: { payments: { select: { amount: true } } },
            orderBy: { createdAt: 'desc' },
            take: 20,
          }),
          this.prisma.sharedAccess.findMany({
            where: { status: 'ACTIVE', OR: [{ ownerId: viewerId, viewerId: userId }, { ownerId: userId, viewerId }] },
            select: { id: true, ownerId: true, sections: true, manageSections: true, hiddenCategoryIds: true },
          }),
        ]);
    return {
      id: user.id,
      name: user.name,
      username: user.username,
      avatarUrl: user.avatarUrl,
      memberSince: user.createdAt,
      /// "Sobre mim"
      bio: user.bio,
      isMe,
      /// Spaces onde estamos os dois
      spaces,
      /// Empréstimos em aberto entre nós (do meu ponto de vista)
      loans: loans.map((l) => ({
        id: l.id,
        // LENT = a pessoa deve-me; BORROWED = eu devo-lhe
        direction: l.userId === viewerId ? l.direction : l.direction === 'LENT' ? 'BORROWED' : 'LENT',
        remaining: round2(Math.max(0, num(l.amount) - l.payments.reduce((acc, p) => acc + num(p.amount), 0))),
        currency: l.currency,
      })),
      sharing: {
        /// Eu vejo os gastos desta pessoa (id do acesso, para abrir)
        iFollow: shares.find((a) => a.ownerId === userId)?.id ?? null,
        /// Esta pessoa vê os meus gastos
        followsMe: shares.find((a) => a.ownerId === viewerId)?.id ?? null,
        /// Onde eu posso ajudar esta pessoa a gerir
        iCanHelp: helpOf(shares.find((a) => a.ownerId === userId)),
        /// Onde esta pessoa me pode ajudar a gerir
        theyCanHelp: helpOf(shares.find((a) => a.ownerId === viewerId)),
      },
    };
  }

  async touch(userId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { lastActiveAt: new Date() } }).catch(() => undefined);
  }
}
