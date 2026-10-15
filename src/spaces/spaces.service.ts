import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { ApiException } from '../common/errors/api.exception';
import { formatMoney, num, round2 } from '../common/utils/money';
import { legacyColumns, permissionsFor, resolvePrivileges, SpacePrivileges, SPACE_PERMISSIONS } from './privileges';
import { Space, SpaceMember, SpaceRole } from '../generated/prisma/client';
import { computeBalances } from './split';
import { computePot } from './pot';
import { CreateSpaceDto, InviteDto, UpdateSpaceDto } from './spaces.dto';
import { isCurrency } from '../meta/countries.data';
import { resolveLanguage } from '../common/i18n/messages';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_DAYS = 30;
const SPACE_ICONS: Record<string, string> = { HOUSEHOLD: 'home', COUPLE: 'favorite', TRIP: 'flight', FRIENDS: 'groups', PROJECT: 'construction', OTHER: 'group' };

export function inviteCode(): string {
  return Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

const memberUser = { select: { id: true, name: true, username: true, avatarUrl: true } } as const;

const INVITE_MAIL: Record<string, { subject: string; body: string }> = {
  pt: { subject: '{from} convidou-te para um Space no Contalexy', body: 'Olá!\n\n{from} convidou-te para o Space "{space}" no Contalexy, para dividirem despesas.\n\nCria a tua conta com este email e o convite aparece logo. Ou entra com o código: {code}' },
  en: { subject: '{from} invited you to a Space on Contalexy', body: 'Hi!\n\n{from} invited you to the Space "{space}" on Contalexy to split expenses.\n\nCreate your account with this email and the invitation will be waiting. Or join with the code: {code}' },
  fr: { subject: '{from} t’a invité dans un espace sur Contalexy', body: 'Bonjour !\n\n{from} t’a invité dans l’espace « {space} » sur Contalexy pour partager les dépenses.\n\nCrée ton compte avec cet e-mail et l’invitation t’attendra. Ou rejoins avec le code : {code}' },
  de: { subject: '{from} hat dich in einen Space auf Contalexy eingeladen', body: 'Hallo!\n\n{from} hat dich in den Space „{space}“ auf Contalexy eingeladen, um Ausgaben zu teilen.\n\nErstelle dein Konto mit dieser E-Mail, dann wartet die Einladung auf dich. Oder tritt mit dem Code bei: {code}' },
};

/// Spaces: grupos para casa, casal, viagens, amigos ou projetos — com
/// convites, papéis (dono/admin/membro) e despesas partilhadas.
@Injectable()
export class SpacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  async membership(userId: string, spaceId: string): Promise<SpaceMember & { space: Space }> {
    const member = await this.prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId } },
      include: { space: true },
    });
    if (!member) {
      const exists = await this.prisma.space.findUnique({ where: { id: spaceId }, select: { id: true } });
      throw exists ? ApiException.forbidden('NOT_SPACE_MEMBER') : ApiException.notFound('SPACE_NOT_FOUND');
    }
    return member;
  }

  isAdmin(role: SpaceRole) {
    return role === 'OWNER' || role === 'ADMIN';
  }

  /// Privilégios: o que este membro pode fazer neste Space, pelo papel e
  /// pela matriz guardada pelo dono (ver privileges.ts).
  can(member: { role: SpaceRole; space: Pick<Space, 'inviteBy' | 'expensesBy' | 'editBy' | 'privileges'> }) {
    return permissionsFor(member.role, resolvePrivileges(member.space));
  }

  /// Regista no histórico do Space o que alguém mudou ou apagou ("quem
  /// apagou o quê"). Nunca estraga a ação que o originou.
  async log(spaceId: string, actorId: string, type: string, data: Record<string, unknown> = {}) {
    try {
      const actor = await this.prisma.user.findUnique({ where: { id: actorId }, select: { name: true } });
      await this.prisma.spaceActivity.create({ data: { spaceId, actorId, actorName: actor?.name ?? '', type, data: data as object } });
    } catch {
      // o registo é um extra
    }
  }

  async requireAdmin(userId: string, spaceId: string) {
    const m = await this.membership(userId, spaceId);
    if (!this.isAdmin(m.role)) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    return m;
  }

  private async ownerId(spaceId: string) {
    const owner = await this.prisma.spaceMember.findFirst({ where: { spaceId, role: 'OWNER' }, select: { userId: true } });
    return owner?.userId ?? null;
  }

  /// O limite de membros é o do plano do DONO do Space.
  private async assertRoomFor(spaceId: string, extra = 1) {
    const ownerId = await this.ownerId(spaceId);
    if (!ownerId) return;
    const count = await this.prisma.spaceMember.count({ where: { spaceId } });
    await this.entitlements.assertLimit(ownerId, 'spaceMembers', count + extra - 1);
  }

  private async assertCanJoinAnother(userId: string) {
    const count = await this.prisma.spaceMember.count({ where: { userId, space: { archivedAt: null } } });
    await this.entitlements.assertLimit(userId, 'spaces', count);
  }

  private async memberNet(spaceId: string, userId: string) {
    const [expenses, settlements] = await Promise.all([
      // As despesas pagas com o fundo comum não criam dívidas entre as pessoas.
      this.prisma.spaceExpense.findMany({ where: { spaceId, fromPot: false }, select: { paidById: true, amount: true, shares: { select: { userId: true, amount: true } } } }),
      this.prisma.spaceSettlement.findMany({ where: { spaceId }, select: { fromUserId: true, toUserId: true, amount: true } }),
    ]);
    return computeBalances(expenses, settlements).find((b) => b.userId === userId)?.net ?? 0;
  }

  /// As contas do fundo comum do Space (quem pôs, o que se gastou de lá, o que cabe a cada um).
  async pot(spaceId: string, memberIds: string[] = []) {
    const [deposits, potExpenses] = await Promise.all([
      this.prisma.spaceDeposit.findMany({ where: { spaceId }, select: { userId: true, amount: true, goalId: true, goal: { select: { status: true } } } }),
      this.prisma.spaceExpense.findMany({ where: { spaceId, fromPot: true }, select: { amount: true, shares: { select: { userId: true, amount: true } } } }),
    ]);
    // O dinheiro de uma meta arquivada ("usar o dinheiro") volta a ficar livre.
    const labelled = deposits.map((d) => ({ userId: d.userId, amount: d.amount, goalId: d.goal && d.goal.status !== 'ARCHIVED' ? d.goalId : null }));
    return computePot(labelled, potExpenses, memberIds);
  }

  /// Mensagens da conversa do Space que eu ainda não li (só as de depois de eu entrar).
  async unreadMessages(spaceId: string, userId: string, joinedAt?: Date) {
    const read = await this.prisma.chatRead.findUnique({ where: { userId_thread: { userId, thread: `space:${spaceId}` } }, select: { readAt: true } });
    const since = read && (!joinedAt || read.readAt > joinedAt) ? read.readAt : (joinedAt ?? null);
    return this.prisma.message.count({
      where: { spaceId, deletedAt: null, OR: [{ senderId: null }, { senderId: { not: userId } }], ...(since ? { createdAt: { gt: since } } : {}) },
    });
  }

  async list(userId: string) {
    const memberships = await this.prisma.spaceMember.findMany({
      where: { userId, space: { archivedAt: null } },
      include: { space: { include: { _count: { select: { members: true } } } } },
      orderBy: { joinedAt: 'asc' },
    });
    const out = [];
    for (const m of memberships) {
      const [net, spent, pot, unread] = await Promise.all([
        this.memberNet(m.spaceId, userId),
        this.prisma.spaceExpense.aggregate({ where: { spaceId: m.spaceId }, _sum: { amount: true } }),
        this.pot(m.spaceId),
        this.unreadMessages(m.spaceId, userId, m.joinedAt),
      ]);
      out.push({
        id: m.space.id,
        name: m.space.name,
        type: m.space.type,
        description: m.space.description,
        icon: m.space.icon,
        color: m.space.color,
        currency: m.space.currency,
        role: m.role,
        membersCount: m.space._count.members,
        myBalance: round2(net),
        totalSpent: num(spent._sum.amount),
        /// O que está no fundo comum e as mensagens por ler
        potBalance: pot.balance,
        unreadMessages: unread,
        createdAt: m.space.createdAt,
      });
    }
    return out;
  }

  async get(userId: string, spaceId: string) {
    const me = await this.membership(userId, spaceId);
    const members = await this.prisma.spaceMember.findMany({ where: { spaceId }, include: { user: memberUser }, orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }] });
    const [pot, unread, goalsCount] = await Promise.all([
      this.pot(spaceId, members.map((m) => m.userId)),
      this.unreadMessages(spaceId, userId, me.joinedAt),
      this.prisma.spaceGoal.count({ where: { spaceId, status: { not: 'ARCHIVED' } } }),
    ]);
    const [expenses, settlements, spent, pendingInvites] = await Promise.all([
      this.prisma.spaceExpense.findMany({ where: { spaceId, fromPot: false }, select: { paidById: true, amount: true, shares: { select: { userId: true, amount: true } } } }),
      this.prisma.spaceSettlement.findMany({ where: { spaceId }, select: { fromUserId: true, toUserId: true, amount: true } }),
      this.prisma.spaceExpense.aggregate({ where: { spaceId }, _sum: { amount: true }, _count: { _all: true } }),
      this.isAdmin(me.role)
        ? this.prisma.spaceInvitation.findMany({
            where: { spaceId, status: 'PENDING', expiresAt: { gt: new Date() } },
            include: { invitee: memberUser },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
    ]);
    const balances = computeBalances(expenses, settlements, members.map((m) => m.userId));
    const byUser = new Map(balances.map((b) => [b.userId, b]));
    return {
      id: me.space.id,
      name: me.space.name,
      type: me.space.type,
      description: me.space.description,
      icon: me.space.icon,
      color: me.space.color,
      currency: me.space.currency,
      inviteCode: me.space.inviteCode,
      role: me.role,
      /// Privilégios do Space e o que EU posso fazer nele
      settings: { inviteBy: me.space.inviteBy, expensesBy: me.space.expensesBy, editBy: me.space.editBy },
      /// A matriz completa, por papel (só o dono a muda)
      privileges: resolvePrivileges(me.space),
      can: this.can(me),
      createdAt: me.space.createdAt,
      totalSpent: num(spent._sum.amount),
      expensesCount: spent._count._all,
      myBalance: round2(byUser.get(userId)?.net ?? 0),
      /// O fundo comum: o que lá está e a minha parte
      pot: { balance: pot.balance, earmarked: pot.earmarked, free: pot.free, myStake: pot.members.find((m) => m.userId === userId)?.stake ?? 0 },
      goalsCount,
      unreadMessages: unread,
      members: members.map((m) => ({
        userId: m.userId,
        name: m.user.name,
        username: m.user.username,
        avatarUrl: m.user.avatarUrl,
        role: m.role,
        joinedAt: m.joinedAt,
        isMe: m.userId === userId,
        balance: round2(byUser.get(m.userId)?.net ?? 0),
      })),
      // Um convite feito por email só mostra o email: não se revela a quem
      // pertence (nome/username) antes de a pessoa aceitar.
      pendingInvitations: pendingInvites.map((i) => ({
        id: i.id,
        email: i.email,
        user: i.email ? null : i.invitee,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
      })),
    };
  }

  async create(userId: string, dto: CreateSpaceDto) {
    await this.assertCanJoinAnother(userId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true } });
    const currency = dto.currency ?? user?.currency ?? 'EUR';
    if (!isCurrency(currency)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'currency', message: 'unknown' }]);
    const space = await this.prisma.space.create({
      data: {
        name: dto.name,
        type: dto.type,
        description: dto.description ?? null,
        icon: dto.icon ?? SPACE_ICONS[dto.type] ?? 'group',
        color: dto.color ?? '#2D4BE0',
        currency,
        inviteCode: inviteCode(),
        createdById: userId,
        members: { create: { userId, role: 'OWNER' } },
      },
    });
    return this.get(userId, space.id);
  }

  async update(userId: string, spaceId: string, dto: UpdateSpaceDto) {
    const me = await this.requireAdmin(userId, spaceId);
    const privileges = (['inviteBy', 'expensesBy', 'editBy'] as const).filter((k) => dto[k] !== undefined && dto[k] !== me.space[k]);
    // A matriz nova: junta-se por cima da que está guardada (e das colunas antigas).
    let matrix: SpacePrivileges | null = null;
    if (dto.privileges) {
      const current = resolvePrivileges(me.space);
      matrix = { ADMIN: { ...current.ADMIN }, MEMBER: { ...current.MEMBER } };
      for (const role of ['ADMIN', 'MEMBER'] as const) {
        for (const key of SPACE_PERMISSIONS) {
          const v = dto.privileges[role]?.[key];
          if (typeof v === 'boolean') matrix[role][key] = v;
        }
      }
      if (JSON.stringify(matrix) === JSON.stringify(current)) matrix = null;
    }
    // Os privilégios são do dono; o resto (nome, ícone…) também é dos admins.
    if ((privileges.length || matrix) && me.role !== 'OWNER') throw ApiException.forbidden('SPACE_OWNER_REQUIRED');
    if (dto.currency) {
      if (!isCurrency(dto.currency)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'currency', message: 'unknown' }]);
      const space = await this.prisma.space.findUnique({ where: { id: spaceId }, select: { currency: true } });
      if (space?.currency !== dto.currency && (await this.prisma.spaceExpense.count({ where: { spaceId } }))) {
        throw ApiException.conflict('ACCOUNT_CURRENCY_LOCKED');
      }
    }
    await this.prisma.space.update({
      where: { id: spaceId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.inviteBy !== undefined ? { inviteBy: dto.inviteBy } : {}),
        ...(dto.expensesBy !== undefined ? { expensesBy: dto.expensesBy } : {}),
        ...(dto.editBy !== undefined ? { editBy: dto.editBy } : {}),
        ...(matrix ? { privileges: matrix as object, ...legacyColumns(matrix) } : {}),
      },
    });
    if (dto.name !== undefined && dto.name !== me.space.name) await this.log(spaceId, userId, 'space_updated', { from: me.space.name, to: dto.name });
    if (privileges.length || matrix) {
      await this.log(spaceId, userId, 'privileges_changed', { ...Object.fromEntries(privileges.map((k) => [k, dto[k]])), ...(matrix ? { matrix: true } : {}) });
    }
    return this.get(userId, spaceId);
  }

  async remove(userId: string, spaceId: string) {
    const m = await this.membership(userId, spaceId);
    if (m.role !== 'OWNER') throw ApiException.forbidden('SPACE_OWNER_REQUIRED');
    await this.prisma.space.delete({ where: { id: spaceId } });
    return { deleted: true };
  }

  async regenerateCode(userId: string, spaceId: string) {
    await this.requireAdmin(userId, spaceId);
    await this.prisma.space.update({ where: { id: spaceId }, data: { inviteCode: inviteCode() } });
    return this.get(userId, spaceId);
  }

  // ----------------------------------------------------------------
  // Convites
  // ----------------------------------------------------------------

  async invite(userId: string, spaceId: string, dto: InviteDto) {
    const me = await this.membership(userId, spaceId);
    if (!this.can(me).invite) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    await this.assertRoomFor(spaceId);
    const inviter = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, language: true } });

    const target = dto.username
      ? await this.prisma.user.findUnique({ where: { username: dto.username.replace(/^@/, '') }, select: { id: true, email: true } })
      : await this.prisma.user.findUnique({ where: { email: dto.email! }, select: { id: true, email: true } });
    if (dto.username && !target) throw ApiException.notFound('USER_NOT_FOUND');
    if (target?.id === userId) throw ApiException.badRequest('CANNOT_INVITE_SELF');
    if (target) {
      const already = await this.prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId: target.id } }, select: { id: true } });
      if (already) throw ApiException.conflict('ALREADY_MEMBER');
    }

    const existing = await this.prisma.spaceInvitation.findFirst({
      where: { spaceId, status: 'PENDING', expiresAt: { gt: new Date() }, ...(target ? { inviteeId: target.id } : { email: dto.email }) },
    });
    if (existing) return { id: existing.id, status: existing.status, inviteeId: existing.email ? null : existing.inviteeId, email: existing.email };

    const invitation = await this.prisma.spaceInvitation.create({
      data: {
        spaceId,
        inviterId: userId,
        inviteeId: target?.id ?? null,
        email: dto.username ? null : (dto.email ?? null),
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
      },
    });
    if (target) {
      await this.notifications.notify(target.id, 'space_invite', { invitationId: invitation.id, spaceId, space: me.space.name, from: inviter?.name ?? '', fromId: userId });
    } else if (dto.email) {
      // Ainda não tem conta: email com o convite e o código (no idioma de quem convida).
      const lang = resolveLanguage(inviter?.language);
      const tpl = INVITE_MAIL[lang] ?? INVITE_MAIL.en;
      const fill = (t: string) => t.replace('{from}', inviter?.name ?? '').replace('{space}', me.space.name).replace('{code}', me.space.inviteCode);
      await this.mail.send(dto.email, fill(tpl.subject), fill(tpl.body));
    }
    return { id: invitation.id, status: invitation.status, inviteeId: invitation.email ? null : invitation.inviteeId, email: invitation.email };
  }

  async receivedInvitations(userId: string) {
    const invitations = await this.prisma.spaceInvitation.findMany({
      where: { inviteeId: userId, status: 'PENDING', expiresAt: { gt: new Date() } },
      include: { space: { include: { _count: { select: { members: true } } } }, inviter: memberUser },
      orderBy: { createdAt: 'desc' },
    });
    return invitations.map((i) => ({
      id: i.id,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      inviter: i.inviter,
      space: { id: i.space.id, name: i.space.name, type: i.space.type, icon: i.space.icon, color: i.space.color, currency: i.space.currency, membersCount: i.space._count.members },
    }));
  }

  private async join(userId: string, spaceId: string) {
    const already = await this.prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId } }, select: { id: true } });
    if (already) return;
    await this.assertCanJoinAnother(userId);
    await this.assertRoomFor(spaceId);
    await this.prisma.spaceMember.create({ data: { spaceId, userId, role: 'MEMBER' } });
    const [space, user, others] = await Promise.all([
      this.prisma.space.findUnique({ where: { id: spaceId }, select: { name: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
      this.prisma.spaceMember.findMany({ where: { spaceId, userId: { not: userId } }, select: { userId: true } }),
    ]);
    for (const o of others) {
      await this.notifications.notify(o.userId, 'space_joined', { spaceId, space: space?.name ?? '', from: user?.name ?? '' });
    }
  }

  async accept(userId: string, invitationId: string) {
    const invitation = await this.prisma.spaceInvitation.findFirst({ where: { id: invitationId, inviteeId: userId } });
    if (!invitation) throw ApiException.notFound('INVITATION_NOT_FOUND');
    if (invitation.status !== 'PENDING' || invitation.expiresAt < new Date()) throw ApiException.badRequest('INVITATION_CLOSED');
    await this.join(userId, invitation.spaceId);
    await this.prisma.spaceInvitation.update({ where: { id: invitationId }, data: { status: 'ACCEPTED', respondedAt: new Date() } });
    return this.get(userId, invitation.spaceId);
  }

  async decline(userId: string, invitationId: string) {
    const result = await this.prisma.spaceInvitation.updateMany({
      where: { id: invitationId, inviteeId: userId, status: 'PENDING' },
      data: { status: 'DECLINED', respondedAt: new Date() },
    });
    if (!result.count) throw ApiException.notFound('INVITATION_NOT_FOUND');
    return { declined: true };
  }

  async cancelInvitation(userId: string, spaceId: string, invitationId: string) {
    const me = await this.membership(userId, spaceId);
    if (!this.can(me).manageMembers) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    const result = await this.prisma.spaceInvitation.updateMany({
      where: { id: invitationId, spaceId, status: 'PENDING' },
      data: { status: 'CANCELLED', respondedAt: new Date() },
    });
    if (!result.count) throw ApiException.notFound('INVITATION_NOT_FOUND');
    return { cancelled: true };
  }

  async joinByCode(userId: string, code: string) {
    const space = await this.prisma.space.findUnique({ where: { inviteCode: code.toUpperCase() }, select: { id: true, archivedAt: true } });
    if (!space || space.archivedAt) throw ApiException.notFound('INVITE_CODE_INVALID');
    await this.join(userId, space.id);
    await this.prisma.spaceInvitation.updateMany({
      where: { spaceId: space.id, inviteeId: userId, status: 'PENDING' },
      data: { status: 'ACCEPTED', respondedAt: new Date() },
    });
    return this.get(userId, space.id);
  }

  // ----------------------------------------------------------------
  // Membros
  // ----------------------------------------------------------------

  /// Sair: só com as contas acertadas. Se for o dono, passa para o
  /// admin (ou membro) mais antigo; se não sobrar ninguém, o Space acaba.
  async leave(userId: string, spaceId: string) {
    const me = await this.membership(userId, spaceId);
    const net = await this.memberNet(spaceId, userId);
    if (Math.abs(net) >= 0.01) {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { language: true, country: true } });
      throw ApiException.conflict('SPACE_BALANCE_NOT_SETTLED', { amount: formatMoney(net, me.space.currency, user?.language, user?.country) });
    }
    // E com a sua parte do fundo levantada (ou reposta, se gastou mais do que pôs).
    const stake = (await this.pot(spaceId)).members.find((m) => m.userId === userId)?.stake ?? 0;
    if (Math.abs(stake) >= 0.01) {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { language: true, country: true } });
      throw ApiException.conflict('SPACE_POT_NOT_SETTLED', { amount: formatMoney(stake, me.space.currency, user?.language, user?.country) });
    }
    await this.prisma.spaceMember.delete({ where: { id: me.id } });
    await this.log(spaceId, userId, 'member_left');
    if (me.role === 'OWNER') {
      const heir = await this.prisma.spaceMember.findFirst({ where: { spaceId }, orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }] });
      if (heir) await this.prisma.spaceMember.update({ where: { id: heir.id }, data: { role: 'OWNER' } });
      else await this.prisma.space.delete({ where: { id: spaceId } });
    }
    return { left: true };
  }

  async removeMember(userId: string, spaceId: string, memberUserId: string) {
    const me = await this.membership(userId, spaceId);
    if (memberUserId !== userId && !this.can(me).manageMembers) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    if (memberUserId === userId) return this.leave(userId, spaceId);
    const target = await this.prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId: memberUserId } } });
    if (!target) throw ApiException.notFound('USER_NOT_FOUND');
    if (target.role === 'OWNER') throw ApiException.forbidden('CANNOT_REMOVE_OWNER');
    if (target.role === 'ADMIN' && me.role !== 'OWNER') throw ApiException.forbidden('SPACE_OWNER_REQUIRED');
    await this.prisma.spaceMember.delete({ where: { id: target.id } });
    const [removed, actor] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: memberUserId }, select: { name: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);
    await this.log(spaceId, userId, 'member_removed', { userId: memberUserId, name: removed?.name ?? '' });
    await this.notifications.notify(memberUserId, 'space_removed', { space: me.space.name, from: actor?.name ?? '' });
    return this.get(userId, spaceId);
  }

  /// Só o dono muda papéis. Passar a dono a outra pessoa torna-te admin.
  async setRole(userId: string, spaceId: string, memberUserId: string, role: SpaceRole) {
    const me = await this.membership(userId, spaceId);
    if (me.role !== 'OWNER') throw ApiException.forbidden('SPACE_OWNER_REQUIRED');
    if (memberUserId === userId) throw ApiException.badRequest('INVALID_REQUEST');
    const target = await this.prisma.spaceMember.findUnique({ where: { spaceId_userId: { spaceId, userId: memberUserId } } });
    if (!target) throw ApiException.notFound('USER_NOT_FOUND');
    if (role === 'OWNER') {
      await this.prisma.$transaction([
        this.prisma.spaceMember.update({ where: { id: target.id }, data: { role: 'OWNER' } }),
        this.prisma.spaceMember.update({ where: { id: me.id }, data: { role: 'ADMIN' } }),
      ]);
    } else {
      await this.prisma.spaceMember.update({ where: { id: target.id }, data: { role } });
    }
    if (role !== target.role) {
      const [changed, actor] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: memberUserId }, select: { name: true } }),
        this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
      ]);
      await this.log(spaceId, userId, 'role_changed', { userId: memberUserId, name: changed?.name ?? '', from: target.role, to: role });
      await this.notifications.notify(memberUserId, 'space_role', { spaceId, space: me.space.name, from: actor?.name ?? '', role });
    }
    return this.get(userId, spaceId);
  }
}
