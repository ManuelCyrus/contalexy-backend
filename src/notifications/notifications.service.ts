import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PushService } from './push.service';
import { Language, notificationText, resolveLanguage } from '../common/i18n/messages';
import { ApiException } from '../common/errors/api.exception';

/// Preferências: cada tipo pertence a um grupo que a pessoa pode desligar
/// (só o push — dentro da app continua a aparecer).
const PREF_GROUP: Record<string, string> = {
  budget_alert: 'budgets',
  budget_exceeded: 'budgets',
  payment_reminder: 'reminders',
  payment_created: 'reminders',
  space_invite: 'spaces',
  space_expense: 'spaces',
  space_settlement: 'spaces',
  space_joined: 'spaces',
  goal_completed: 'goals',
  goal_almost: 'goals',
  goal_deposit_due: 'goals',
  goal_deposit_done: 'goals',
  plan_line_exceeded: 'budgets',
  loan_lent_due_soon: 'loans',
  loan_lent_due_today: 'loans',
  loan_lent_overdue: 'loans',
  loan_borrowed_due_soon: 'loans',
  loan_borrowed_due_today: 'loans',
  loan_borrowed_overdue: 'loans',
  sharing_invite: 'sharing',
  sharing_help: 'sharing',
  help_change: 'sharing',
  loan_nudge: 'loans',
  loan_note: 'loans',
  space_reminder: 'spaces',
  sharing_accepted: 'sharing',
  sharing_note: 'sharing',
  subscription_active: 'account',
  ai_credits_added: 'account',
  whatsapp_pending: 'account',
  item_offer: 'sharing',
  item_offer_accepted: 'sharing',
  item_offer_declined: 'sharing',
  daily_limit_warning: 'budgets',
  daily_limit_reached: 'budgets',
  daily_limit_exceeded: 'budgets',
  subscription_ending: 'account',
  subscription_ended: 'account',
  subscription_ended_locked: 'account',
  subscription_billing_issue: 'account',
  account_deletion_cancelled: 'account',
  loan_request_borrowed: 'loans',
  loan_request_lent: 'loans',
  loan_accepted: 'loans',
  loan_declined: 'loans',
  loan_left: 'loans',
  loan_removed: 'loans',
  loan_payment_lent: 'loans',
  loan_payment_borrowed: 'loans',
  loan_settled: 'loans',
  loan_payment_removed: 'loans',
  loan_changed: 'loans',
  loan_cancelled: 'loans',
  space_removed: 'spaces',
  space_role: 'spaces',
  space_expense_deleted: 'spaces',
  plan_offer: 'sharing',
  plan_offer_accepted: 'sharing',
  plan_offer_declined: 'sharing',
  space_pot_expense: 'spaces',
  space_deposit: 'spaces',
  space_deposit_goal: 'spaces',
  space_withdrawal: 'spaces',
  space_deposit_removed: 'spaces',
  space_goal_created: 'spaces',
  space_goal_reached: 'spaces',
  chat_message: 'messages',
  chat_direct: 'messages',
};

/// Os avisos de conversas: um por conversa (vai-se atualizando), não um por mensagem.
const CHAT_TYPES = ['chat_message', 'chat_direct'];

export interface NotifyContext {
  lang: Language;
  country: string;
  currency: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  /// Guarda a notificação e manda push (se a pessoa não desligou esse grupo).
  /// `textParams` recebe o idioma/país da pessoa — para formatar valores.
  async notify(
    userId: string,
    type: string,
    data: Record<string, unknown>,
    textParams?: (ctx: NotifyContext) => Record<string, unknown>,
    /// `collapse`: a conversa a que pertence. Enquanto a pessoa não a abrir,
    /// os avisos dessa conversa juntam-se num só (com `count`).
    /// `quietWhenCollapsed`: se já havia um aviso por abrir dessa conversa, junta-se a ele sem novo push.
    opts: { collapse?: string; quietWhenCollapsed?: boolean } = {},
  ): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { language: true, country: true, currency: true, notificationPrefs: true },
      });
      if (!user) return;
      const thread = opts.collapse;
      const pending = thread
        ? await this.prisma.notification.findFirst({ where: { userId, type, readAt: null, data: { path: ['thread'], equals: thread } }, select: { id: true, data: true } })
        : null;
      let notification: { id: string };
      if (pending) {
        const before = Number((pending.data as Record<string, unknown> | null)?.count ?? 1);
        notification = await this.prisma.notification.update({
          where: { id: pending.id },
          data: { data: { ...data, thread, count: (Number.isFinite(before) ? before : 1) + 1 } as object, createdAt: new Date() },
          select: { id: true },
        });
      } else {
        notification = await this.prisma.notification.create({ data: { userId, type, data: (thread ? { ...data, thread, count: 1 } : data) as object }, select: { id: true } });
      }

      if (pending && opts.quietWhenCollapsed) return;
      const prefs = (user.notificationPrefs ?? {}) as Record<string, unknown>;
      const group = PREF_GROUP[type];
      if (group && prefs[group] === false) return;
      if (!this.push.enabled) return;

      const ctx: NotifyContext = { lang: resolveLanguage(user.language), country: user.country, currency: user.currency };
      const params = textParams ? textParams(ctx) : data;
      const title = notificationText(type, 'title', ctx.lang, params);
      const body = notificationText(type, 'body', ctx.lang, params);
      if (!title && !body) return;
      const pushData: Record<string, string> = { type, notificationId: notification.id };
      for (const [key, value] of Object.entries(data)) {
        if (value !== null && value !== undefined && typeof value !== 'object') pushData[key] = String(value);
      }
      await this.push.sendToUser(userId, { title, body, data: pushData });
    } catch (err) {
      // Uma notificação que falha nunca estraga a ação que a originou.
      this.logger.warn(`Falhou a notificação ${type}: ${(err as Error).message}`);
    }
  }

  /// Abrir uma conversa dá por lidos os avisos dessa conversa.
  async readThread(userId: string, thread: string) {
    await this.prisma.notification
      .updateMany({ where: { userId, readAt: null, type: { in: CHAT_TYPES }, data: { path: ['thread'], equals: thread } }, data: { readAt: new Date() } })
      .catch(() => undefined);
  }

  /// A lista dos avisos. As mensagens não entram: têm o seu sítio (as
  /// conversas) e o seu próprio contador.
  async list(userId: string, limit = 30, before?: string) {
    const take = Math.min(Math.max(limit, 1), 100);
    const rows = await this.prisma.notification.findMany({
      where: { userId, type: { notIn: CHAT_TYPES }, ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
    });
    const items = rows.slice(0, take).map((n) => ({ id: n.id, type: n.type, data: n.data, readAt: n.readAt, createdAt: n.createdAt }));
    return { data: items, meta: { nextBefore: rows.length > take ? items[items.length - 1].createdAt.toISOString() : null } };
  }

  /// Avisos por ler (sem as mensagens, que se contam à parte).
  async unreadCount(userId: string) {
    return { count: await this.prisma.notification.count({ where: { userId, readAt: null, type: { notIn: CHAT_TYPES } } }) };
  }

  /// O que há por ver e o aviso mais recente (mensagens incluídas), para a
  /// app o mostrar mal chega, mesmo sem notificações push.
  async inbox(userId: string) {
    const [count, latest] = await Promise.all([
      this.prisma.notification.count({ where: { userId, readAt: null, type: { notIn: CHAT_TYPES } } }),
      this.prisma.notification.findFirst({ where: { userId, readAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, type: true, data: true, createdAt: true } }),
    ]);
    return { notifications: count, latest };
  }

  async markRead(userId: string, id: string) {
    const result = await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    if (!result.count && !(await this.prisma.notification.findFirst({ where: { id, userId }, select: { id: true } }))) {
      throw ApiException.notFound('NOTIFICATION_NOT_FOUND');
    }
    return { read: true };
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({ where: { userId, readAt: null, type: { notIn: CHAT_TYPES } }, data: { readAt: new Date() } });
    return { updated: result.count };
  }

  async remove(userId: string, id: string) {
    const result = await this.prisma.notification.deleteMany({ where: { id, userId } });
    if (!result.count) throw ApiException.notFound('NOTIFICATION_NOT_FOUND');
    return { deleted: true };
  }
}
