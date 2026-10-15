import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SpacesService } from '../spaces/spaces.service';
import { UsersService } from '../users/users.service';
import { ApiException } from '../common/errors/api.exception';
import { Prisma } from '../generated/prisma/client';
import { MessagesQuery } from './chat.dto';

const personCard = { id: true, name: true, username: true, avatarUrl: true } as const;
const messageInclude = { sender: { select: personCard } } satisfies Prisma.MessageInclude;
type MessageWithSender = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

/// O que vai no aviso (a mensagem inteira lê-se na conversa).
const PREVIEW_MAX = 140;

/// A conversa entre duas pessoas tem sempre a mesma chave, seja quem for a escrever.
export function directKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export const spaceThread = (spaceId: string) => `space:${spaceId}`;
export const directThread = (a: string, b: string) => `direct:${directKey(a, b)}`;

/// Mensagens rápidas (como um SMS): a conversa de cada Space e conversas
/// a dois entre pessoas que já têm alguma coisa em comum na app.
@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpacesService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
  ) {}

  private dto(m: MessageWithSender, userId: string) {
    return {
      id: m.id,
      senderId: m.senderId,
      sender: m.sender,
      /// Uma mensagem apagada fica no sítio, sem o texto
      text: m.deletedAt ? null : m.text,
      deleted: !!m.deletedAt,
      mine: m.senderId === userId,
      at: m.createdAt,
    };
  }

  private preview(text: string) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
  }

  /// Abrir (ou escrever em) uma conversa dá-a por lida.
  private async markRead(userId: string, thread: string) {
    const readAt = new Date();
    await this.prisma.chatRead.upsert({ where: { userId_thread: { userId, thread } }, create: { userId, thread, readAt }, update: { readAt } });
    await this.notifications.readThread(userId, thread);
  }

  /// Uma página da conversa, sempre da mais antiga para a mais recente.
  private async page(where: Prisma.MessageWhereInput, userId: string, q: MessagesQuery) {
    if (q.after) {
      const after = new Date(q.after);
      const [fresh, gone] = await Promise.all([
        // "gte": duas mensagens no mesmo milissegundo não se perdem (a app ignora a que já tem).
        this.prisma.message.findMany({ where: { ...where, createdAt: { gte: after } }, include: messageInclude, orderBy: { createdAt: 'asc' }, take: 100 }),
        // As que foram apagadas entretanto (para a app as tirar do ecrã)
        this.prisma.message.findMany({ where: { ...where, deletedAt: { gt: after } }, select: { id: true }, take: 100 }),
      ]);
      return { messages: fresh.map((m) => this.dto(m, userId)), hasMore: false, deletedIds: gone.map((m) => m.id) };
    }
    const rows = await this.prisma.message.findMany({
      where: { ...where, ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}) },
      include: messageInclude,
      orderBy: { createdAt: 'desc' },
      take: q.limit + 1,
    });
    return { messages: rows.slice(0, q.limit).reverse().map((m) => this.dto(m, userId)), hasMore: rows.length > q.limit, deletedIds: [] as string[] };
  }

  // ----------------------------------------------------------------
  // A conversa de um Space
  // ----------------------------------------------------------------

  async spaceMessages(userId: string, spaceId: string, q: MessagesQuery) {
    const me = await this.spaces.membership(userId, spaceId);
    const thread = spaceThread(spaceId);
    const page = await this.page({ spaceId }, userId, q);
    await this.markRead(userId, thread);
    return { thread, kind: 'space' as const, space: { id: me.space.id, name: me.space.name, icon: me.space.icon, color: me.space.color, type: me.space.type }, canSend: this.spaces.can(me).chat, ...page };
  }

  async sendToSpace(userId: string, spaceId: string, text: string) {
    const me = await this.spaces.membership(userId, spaceId);
    if (!this.spaces.can(me).chat) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
    const thread = spaceThread(spaceId);
    const message = await this.prisma.message.create({ data: { spaceId, senderId: userId, text }, include: messageInclude });
    await this.markRead(userId, thread);
    const others = await this.prisma.spaceMember.findMany({ where: { spaceId, userId: { not: userId } }, select: { userId: true } });
    const data = { thread, spaceId, space: me.space.name, from: message.sender?.name ?? '', text: this.preview(text) };
    await Promise.all(others.map((m) => this.notifications.notify(m.userId, 'chat_message', data, undefined, { collapse: thread })));
    return this.dto(message, userId);
  }

  // ----------------------------------------------------------------
  // Conversas a dois
  // ----------------------------------------------------------------

  private async peer(userId: string, otherId: string) {
    if (otherId === userId) throw ApiException.badRequest('CHAT_SELF');
    const other = await this.prisma.user.findFirst({ where: { id: otherId, deletionRequestedAt: null }, select: personCard });
    if (!other) throw ApiException.notFound('USER_NOT_FOUND');
    return other;
  }

  /// Só se escreve a quem já se conhece na app: alguém de um Space meu, com
  /// quem partilho gastos, ou com quem tenho um empréstimo ligado.
  private async canWrite(userId: string, otherId: string) {
    return (await this.users.contactIds(userId)).has(otherId);
  }

  async directMessages(userId: string, otherId: string, q: MessagesQuery) {
    const other = await this.peer(userId, otherId);
    const thread = directThread(userId, otherId);
    const page = await this.page({ directKey: directKey(userId, otherId) }, userId, q);
    await this.markRead(userId, thread);
    return { thread, kind: 'direct' as const, user: other, canSend: await this.canWrite(userId, otherId), ...page };
  }

  async sendDirect(userId: string, otherId: string, text: string) {
    await this.peer(userId, otherId);
    if (!(await this.canWrite(userId, otherId))) throw ApiException.forbidden('CHAT_NOT_ALLOWED');
    const thread = directThread(userId, otherId);
    const message = await this.prisma.message.create({ data: { directKey: directKey(userId, otherId), senderId: userId, text }, include: messageInclude });
    await this.markRead(userId, thread);
    await this.notifications.notify(otherId, 'chat_direct', { thread, userId, from: message.sender?.name ?? '', text: this.preview(text) }, undefined, { collapse: thread });
    return this.dto(message, userId);
  }

  // ----------------------------------------------------------------
  // Todas as conversas
  // ----------------------------------------------------------------

  /// As minhas conversas (as dos Spaces e as a dois), a mais recente primeiro,
  /// cada uma com a última mensagem e quantas tenho por ler.
  async threads(userId: string) {
    const [memberships, reads, groups] = await Promise.all([
      this.prisma.spaceMember.findMany({
        where: { userId, space: { archivedAt: null } },
        include: { space: { select: { id: true, name: true, icon: true, color: true, type: true, _count: { select: { members: true } } } } },
      }),
      this.prisma.chatRead.findMany({ where: { userId }, select: { thread: true, readAt: true } }),
      this.prisma.message.groupBy({
        by: ['directKey'],
        where: { OR: [{ directKey: { startsWith: `${userId}:` } }, { directKey: { endsWith: `:${userId}` } }] },
        _max: { createdAt: true },
      }),
    ]);
    const readAt = new Map(reads.map((r) => [r.thread, r.readAt]));
    const fromOthers = { deletedAt: null, OR: [{ senderId: null }, { senderId: { not: userId } }] } satisfies Prisma.MessageWhereInput;

    const spaceItems = await Promise.all(
      memberships.map(async (m) => {
        const [last, unread] = await Promise.all([
          this.prisma.message.findFirst({ where: { spaceId: m.spaceId }, include: messageInclude, orderBy: { createdAt: 'desc' } }),
          this.spaces.unreadMessages(m.spaceId, userId, m.joinedAt),
        ]);
        return {
          thread: spaceThread(m.spaceId),
          kind: 'space' as const,
          space: { id: m.space.id, name: m.space.name, icon: m.space.icon, color: m.space.color, type: m.space.type, membersCount: m.space._count.members },
          user: null as { id: string; name: string; username: string | null; avatarUrl: string | null } | null,
          last: last ? this.dto(last, userId) : null,
          unread,
          at: last?.createdAt ?? m.joinedAt,
        };
      }),
    );

    const keys = groups.map((g) => g.directKey).filter((k): k is string => !!k);
    const otherOf = (key: string) => key.split(':').find((id) => id !== userId) ?? '';
    const people = keys.length ? await this.prisma.user.findMany({ where: { id: { in: keys.map(otherOf) } }, select: personCard }) : [];
    const byId = new Map(people.map((p) => [p.id, p]));
    const directItems = await Promise.all(
      keys.map(async (key) => {
        const other = byId.get(otherOf(key));
        if (!other) return null;
        const thread = `direct:${key}`;
        const since = readAt.get(thread);
        const [last, unread] = await Promise.all([
          this.prisma.message.findFirst({ where: { directKey: key }, include: messageInclude, orderBy: { createdAt: 'desc' } }),
          this.prisma.message.count({ where: { directKey: key, ...fromOthers, ...(since ? { createdAt: { gt: since } } : {}) } }),
        ]);
        if (!last) return null;
        return { thread, kind: 'direct' as const, space: null, user: other, last: this.dto(last, userId), unread, at: last.createdAt };
      }),
    );

    const items = [...spaceItems, ...directItems.filter((t): t is NonNullable<typeof t> => t !== null)].sort((a, b) => b.at.getTime() - a.at.getTime());
    return { unread: items.reduce((acc, t) => acc + t.unread, 0), threads: items };
  }

  /// Quantas mensagens tenho por ler ao todo (para o número no ícone).
  async unread(userId: string) {
    return { count: (await this.threads(userId)).unread };
  }

  /// O que há por ver, num só pedido (a app pergunta de poucos em poucos
  /// segundos enquanto está aberta): avisos e mensagens por ler e o mais recente.
  async inbox(userId: string) {
    const [inbox, threads, pending] = await Promise.all([this.notifications.inbox(userId), this.threads(userId), this.prisma.pendingTransaction.count({ where: { userId, status: 'PENDING' } })]);
    /// `pending`: movimentos por confirmar (vindos do WhatsApp)
    return { notifications: inbox.notifications, messages: threads.unread, latest: inbox.latest, pending };
  }

  /// Apagar uma mensagem: quem a escreveu, ou um admin na conversa de um Space.
  async remove(userId: string, messageId: string) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId }, include: { sender: { select: { name: true } } } });
    if (!message) throw ApiException.notFound('MESSAGE_NOT_FOUND');
    if (message.senderId !== userId) {
      // Numa conversa a dois, só quem está nela sabe que a mensagem existe.
      if (!message.spaceId) throw message.directKey?.split(':').includes(userId) ? ApiException.forbidden() : ApiException.notFound('MESSAGE_NOT_FOUND');
      const me = await this.spaces.membership(userId, message.spaceId).catch(() => null);
      if (!me) throw ApiException.notFound('MESSAGE_NOT_FOUND');
      if (!this.spaces.can(me).editAny) throw ApiException.forbidden('SPACE_ADMIN_REQUIRED');
      if (!message.deletedAt) await this.spaces.log(message.spaceId, userId, 'message_deleted', { name: message.sender?.name ?? '' });
    }
    // O texto sai mesmo da base de dados; fica só o lugar da mensagem.
    if (!message.deletedAt) await this.prisma.message.update({ where: { id: messageId }, data: { deletedAt: new Date(), text: '' } });
    return { deleted: true };
  }
}
