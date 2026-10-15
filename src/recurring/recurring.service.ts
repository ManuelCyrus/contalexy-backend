import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { LocksService } from '../billing/locks.service';
import { ExchangeService } from '../exchange/exchange.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TransactionsService } from '../transactions/transactions.service';
import { ApiException } from '../common/errors/api.exception';
import { env, isTrue } from '../config/env';
import { addDays, daysBetween, fromDbDate, fromDbDateOrNull, nextOccurrence, occurrencesBetween, RecurrenceFrequency, todayIn, toDbDate } from '../common/utils/dates';
import { formatDate, formatMoney, money, num, round2 } from '../common/utils/money';
import { Prisma, RecurringRule } from '../generated/prisma/client';
import { toCategoryDto } from '../categories/categories.service';
import { CreateRecurringDto, UpdateRecurringDto } from './recurring.dto';

const include = {
  account: { select: { id: true, name: true, color: true, icon: true, type: true, currency: true } },
  toAccount: { select: { id: true, name: true, color: true, icon: true, type: true, currency: true } },
  category: true,
} satisfies Prisma.RecurringRuleInclude;
type RuleWithRelations = Prisma.RecurringRuleGetPayload<{ include: typeof include }>;

/// Quanto custa por mês (para "compromissos mensais").
export function monthlyEquivalent(amount: number, frequency: RecurrenceFrequency, interval: number): number {
  const i = Math.max(1, interval);
  switch (frequency) {
    case 'DAILY':
      return round2((amount * 30.4375) / i);
    case 'WEEKLY':
      return round2((amount * 4.348125) / i);
    case 'MONTHLY':
      return round2(amount / i);
    case 'YEARLY':
      return round2(amount / 12 / i);
  }
}

function localHour(timezone: string, now = new Date()): number {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }).format(now));
  } catch {
    return now.getUTCHours();
  }
}

/// Pagamentos recorrentes: salário, renda, Netflix… Criam o movimento
/// sozinhos no dia (ou só lembram), e aparecem em "Próximos pagamentos".
@Injectable()
export class RecurringService {
  private readonly logger = new Logger(RecurringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly exchange: ExchangeService,
    private readonly notifications: NotificationsService,
    private readonly transactions: TransactionsService,
    private readonly locks: LocksService,
  ) {}

  private toDto(rule: RuleWithRelations) {
    const amount = num(rule.amount);
    return {
      id: rule.id,
      type: rule.type,
      amount,
      currency: rule.account.currency,
      account: rule.account,
      toAccount: rule.toAccount,
      category: rule.category ? toCategoryDto(rule.category) : null,
      description: rule.description,
      merchant: rule.merchant,
      frequency: rule.frequency,
      interval: rule.interval,
      startDate: fromDbDate(rule.startDate),
      endDate: fromDbDateOrNull(rule.endDate),
      nextDate: fromDbDate(rule.nextDate),
      autoCreate: rule.autoCreate,
      remindDaysBefore: rule.remindDaysBefore,
      kind: rule.kind,
      isActive: rule.isActive,
      monthlyEquivalent: monthlyEquivalent(amount, rule.frequency, rule.interval),
      lastRunAt: rule.lastRunAt,
      /// Fechada: criada com um plano pago que a pessoa já não tem (ver LocksService)
      locked: false,
      createdAt: rule.createdAt,
    };
  }

  /// A amostra de uma despesa/receita fixa fechada: o que é e de quanto em
  /// quanto tempo — sem o valor, a categoria nem o comerciante.
  private teaser(rule: RuleWithRelations) {
    return { ...this.toDto(rule), amount: 0, monthlyEquivalent: 0, category: null, merchant: null, toAccount: null, autoCreate: false, remindDaysBefore: 0, lastRunAt: null, locked: true };
  }

  private async user(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true, timezone: true } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    return user;
  }

  /// Por omissão, as fixas fechadas ficam de fora (e não entram nos totais do
  /// mês); com `teasers`, vêm no fim como amostra — é o que a lista da app pede.
  async list(userId: string, opts: { teasers?: boolean } = {}) {
    const [rules, user, locked] = await Promise.all([
      this.prisma.recurringRule.findMany({ where: { userId }, include, orderBy: [{ isActive: 'desc' }, { nextDate: 'asc' }] }),
      this.user(userId),
      this.locks.lockedIds(userId, 'recurring'),
    ]);
    const items: Array<ReturnType<RecurringService['toDto']>> = rules.filter((r) => !locked.has(r.id)).map((r) => this.toDto(r));
    if (opts.teasers) items.push(...rules.filter((r) => locked.has(r.id)).map((r) => this.teaser(r)));
    let monthlyExpenses = 0;
    let monthlyIncome = 0;
    for (const r of items.filter((i) => i.isActive && !i.locked)) {
      const value = this.exchange.convert(r.monthlyEquivalent, r.currency, user.currency) ?? 0;
      if (r.type === 'EXPENSE') monthlyExpenses += value;
      else if (r.type === 'INCOME') monthlyIncome += value;
    }
    return { items, currency: user.currency, monthlyExpenses: round2(monthlyExpenses), monthlyIncome: round2(monthlyIncome) };
  }

  async ownedOrThrow(userId: string, id: string) {
    const rule = await this.prisma.recurringRule.findFirst({ where: { id, userId }, include });
    if (!rule) throw ApiException.notFound('RECURRING_NOT_FOUND');
    return rule;
  }

  private async validate(userId: string, dto: { type: string; accountId: string; toAccountId?: string | null; categoryId?: string | null }) {
    const account = await this.prisma.account.findFirst({ where: { id: dto.accountId, userId }, select: { id: true } });
    if (!account) throw ApiException.notFound('ACCOUNT_NOT_FOUND');
    if (dto.type === 'TRANSFER') {
      if (!dto.toAccountId) throw ApiException.badRequest('TRANSFER_TARGET_REQUIRED');
      if (dto.toAccountId === dto.accountId) throw ApiException.badRequest('SAME_ACCOUNT_TRANSFER');
      const target = await this.prisma.account.findFirst({ where: { id: dto.toAccountId, userId }, select: { id: true } });
      if (!target) throw ApiException.notFound('ACCOUNT_NOT_FOUND');
    }
    if (dto.categoryId && dto.type !== 'TRANSFER') {
      const category = await this.prisma.category.findFirst({ where: { id: dto.categoryId, userId }, select: { type: true } });
      if (!category) throw ApiException.notFound('CATEGORY_NOT_FOUND');
      if (category.type !== dto.type) throw ApiException.badRequest('CATEGORY_TYPE_MISMATCH');
    }
  }

  async create(userId: string, dto: CreateRecurringDto) {
    await this.entitlements.assertLimit(userId, 'recurring', await this.prisma.recurringRule.count({ where: { userId, isActive: true } }));
    await this.validate(userId, dto);
    if (dto.endDate && dto.endDate < dto.startDate) throw ApiException.badRequest('DATE_RANGE_INVALID');
    const user = await this.user(userId);
    const today = todayIn(user.timezone);
    // Não cria movimentos do passado: começa na próxima ocorrência a partir de hoje.
    const next = nextOccurrence(dto.startDate, dto.frequency, dto.interval, today, true);
    const rule = await this.prisma.recurringRule.create({
      data: {
        userId,
        type: dto.type,
        amount: money(dto.amount),
        accountId: dto.accountId,
        toAccountId: dto.type === 'TRANSFER' ? (dto.toAccountId ?? null) : null,
        categoryId: dto.type === 'TRANSFER' ? null : (dto.categoryId ?? null),
        description: dto.description,
        merchant: dto.merchant ?? null,
        frequency: dto.frequency,
        interval: dto.interval,
        startDate: toDbDate(dto.startDate),
        endDate: dto.endDate ? toDbDate(dto.endDate) : null,
        nextDate: toDbDate(next),
        autoCreate: dto.autoCreate,
        remindDaysBefore: dto.remindDaysBefore,
        kind: dto.kind,
        isActive: dto.isActive ?? true,
      },
      include,
    });
    // Se calha hoje, cria já (não espera pela tarefa da noite).
    if (rule.autoCreate && fromDbDate(rule.nextDate) <= today) await this.processRule(rule, today);
    return this.toDto(await this.ownedOrThrow(userId, rule.id));
  }

  async update(userId: string, id: string, dto: UpdateRecurringDto) {
    const rule = await this.ownedOrThrow(userId, id);
    const merged = {
      type: dto.type ?? rule.type,
      accountId: dto.accountId ?? rule.accountId,
      toAccountId: dto.toAccountId !== undefined ? dto.toAccountId : rule.toAccountId,
      categoryId: dto.categoryId !== undefined ? dto.categoryId : rule.categoryId,
    };
    await this.validate(userId, merged);
    if (dto.isActive && !rule.isActive) {
      await this.entitlements.assertLimit(userId, 'recurring', await this.prisma.recurringRule.count({ where: { userId, isActive: true } }));
    }
    const startDate = dto.startDate ?? fromDbDate(rule.startDate);
    const frequency = dto.frequency ?? rule.frequency;
    const interval = dto.interval ?? rule.interval;
    const endDate = dto.endDate !== undefined ? dto.endDate : fromDbDateOrNull(rule.endDate);
    if (endDate && endDate < startDate) throw ApiException.badRequest('DATE_RANGE_INVALID');
    const scheduleChanged = dto.startDate !== undefined || dto.frequency !== undefined || dto.interval !== undefined;
    const user = await this.user(userId);
    const today = todayIn(user.timezone);
    await this.prisma.recurringRule.update({
      where: { id },
      data: {
        type: merged.type,
        accountId: merged.accountId,
        toAccountId: merged.type === 'TRANSFER' ? merged.toAccountId : null,
        categoryId: merged.type === 'TRANSFER' ? null : merged.categoryId,
        ...(dto.amount !== undefined ? { amount: money(dto.amount) } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.merchant !== undefined ? { merchant: dto.merchant } : {}),
        frequency,
        interval,
        startDate: toDbDate(startDate),
        endDate: endDate ? toDbDate(endDate) : null,
        ...(scheduleChanged ? { nextDate: toDbDate(nextOccurrence(startDate, frequency, interval, today, true)) } : {}),
        ...(dto.autoCreate !== undefined ? { autoCreate: dto.autoCreate } : {}),
        ...(dto.remindDaysBefore !== undefined ? { remindDaysBefore: dto.remindDaysBefore } : {}),
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    return this.toDto(await this.ownedOrThrow(userId, id));
  }

  async remove(userId: string, id: string) {
    await this.ownedOrThrow(userId, id);
    await this.prisma.recurringRule.delete({ where: { id } });
    return { deleted: true };
  }

  /// Próximos pagamentos/recebimentos (e os em atraso, nos que só lembram).
  async upcoming(userId: string, days = 30) {
    const user = await this.user(userId);
    const today = todayIn(user.timezone);
    const until = addDays(today, Math.min(Math.max(days, 1), 366));
    // As fixas fechadas (sem o plano pago) ficam paradas: não aparecem no que aí vem.
    const locked = await this.locks.lockedIds(userId, 'recurring');
    const rules = (await this.prisma.recurringRule.findMany({ where: { userId, isActive: true }, include })).filter((r) => !locked.has(r.id));
    const items: Array<ReturnType<RecurringService['occurrenceDto']>> = [];
    for (const rule of rules) {
      // A ocorrência pendente é sempre `nextDate` (mesmo em atraso); as
      // seguintes contam-se a partir do início da regra.
      const next = fromDbDate(rule.nextDate);
      const end = fromDbDateOrNull(rule.endDate);
      if (next > until || (end && next > end)) continue;
      const dates = [next, ...occurrencesBetween(fromDbDate(rule.startDate), rule.frequency, rule.interval, addDays(next, 1), until, end, 60)];
      for (const date of dates) items.push(this.occurrenceDto(rule, date, today));
    }
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let expenses = 0;
    let income = 0;
    for (const item of items) {
      const value = this.exchange.convert(item.amount, item.currency, user.currency) ?? 0;
      if (item.type === 'EXPENSE') expenses += value;
      else if (item.type === 'INCOME') income += value;
    }
    return { items, currency: user.currency, from: today, to: until, totalExpenses: round2(expenses), totalIncome: round2(income) };
  }

  occurrenceDto(rule: RuleWithRelations, date: string, today: string) {
    return {
      ruleId: rule.id,
      date,
      daysUntil: daysBetween(today, date),
      overdue: date < today,
      type: rule.type,
      amount: num(rule.amount),
      currency: rule.account.currency,
      description: rule.description,
      kind: rule.kind,
      autoCreate: rule.autoCreate,
      account: rule.account,
      category: rule.category ? toCategoryDto(rule.category) : null,
    };
  }

  /// "Paguei": cria o movimento da próxima ocorrência e avança.
  async pay(userId: string, id: string, input: { date?: string; amount?: number }) {
    const rule = await this.ownedOrThrow(userId, id);
    const occurrence = fromDbDate(rule.nextDate);
    const transaction = await this.transactions.create(
      userId,
      {
        type: rule.type,
        amount: input.amount ?? num(rule.amount),
        accountId: rule.accountId,
        toAccountId: rule.toAccountId,
        categoryId: rule.categoryId,
        date: input.date ?? occurrence,
        description: rule.description,
        merchant: rule.merchant,
      },
      { recurringRuleId: rule.id },
    );
    await this.advance(rule, occurrence);
    return { transaction, rule: this.toDto(await this.ownedOrThrow(userId, id)) };
  }

  /// "Saltar esta vez".
  async skip(userId: string, id: string) {
    const rule = await this.ownedOrThrow(userId, id);
    await this.advance(rule, fromDbDate(rule.nextDate));
    return this.toDto(await this.ownedOrThrow(userId, id));
  }

  private async advance(rule: RecurringRule, after: string) {
    const next = nextOccurrence(fromDbDate(rule.startDate), rule.frequency, rule.interval, after, false);
    const ended = rule.endDate && next > fromDbDate(rule.endDate);
    await this.prisma.recurringRule.update({
      where: { id: rule.id },
      data: { nextDate: toDbDate(next), lastRunAt: new Date(), ...(ended ? { isActive: false } : {}) },
    });
  }

  /// Cria os movimentos em dia (até 31 de atraso) de uma regra automática.
  async processRule(rule: RecurringRule, today: string): Promise<number> {
    let created = 0;
    let current = rule;
    let last: { date: string; transactionId: string } | null = null;
    while (current.isActive && current.autoCreate && fromDbDate(current.nextDate) <= today && created < 31) {
      const date = fromDbDate(current.nextDate);
      if (current.endDate && date > fromDbDate(current.endDate)) {
        await this.prisma.recurringRule.update({ where: { id: current.id }, data: { isActive: false } });
        break;
      }
      try {
        const tx = await this.transactions.createFromRecurring(current, date);
        last = { date, transactionId: tx.id };
        created++;
      } catch (err) {
        this.logger.warn(`Regra ${current.id}: não foi possível criar o movimento (${(err as Error).message}). Fica pausada.`);
        await this.prisma.recurringRule.update({ where: { id: current.id }, data: { isActive: false } });
        break;
      }
      await this.advance(current, date);
      const refreshed = await this.prisma.recurringRule.findUnique({ where: { id: current.id } });
      if (!refreshed) break;
      current = refreshed;
    }
    if (last) {
      const account = await this.prisma.account.findUnique({ where: { id: rule.accountId }, select: { currency: true } });
      const data = { ruleId: rule.id, transactionId: last.transactionId, description: rule.description, amount: num(rule.amount), currency: account?.currency ?? 'EUR', date: last.date };
      await this.notifications.notify(rule.userId, 'payment_created', data, (ctx) => ({
        ...data,
        amount: formatMoney(data.amount, data.currency, ctx.lang, ctx.country),
      }));
    }
    return created;
  }

  /// De hora a hora: cria os movimentos em dia e manda os lembretes.
  @Cron('5 * * * *')
  async hourlyJob() {
    if (!isTrue(env().JOBS_ENABLED)) return;
    await this.runDue();
    await this.sendReminders();
  }

  async runDue(now = new Date()) {
    // Margem de um dia (fusos): cada regra confirma o "hoje" da sua pessoa.
    const horizon = toDbDate(addDays(fromDbDate(now), 1));
    const rules = await this.prisma.recurringRule.findMany({
      where: { isActive: true, autoCreate: true, nextDate: { lte: horizon } },
      include: { user: { select: { timezone: true } } },
      take: 2000,
    });
    let total = 0;
    const isLocked = this.locks.checker('recurring');
    for (const rule of rules) {
      // Fechada: não cria movimentos sozinha até a pessoa voltar ao plano.
      if (await isLocked(rule.userId, rule.id)) continue;
      total += await this.processRule(rule, todayIn(rule.user.timezone, now));
    }
    if (total) this.logger.log(`Pagamentos recorrentes: ${total} movimento(s) criados.`);
    return total;
  }

  async sendReminders(now = new Date()) {
    const horizon = toDbDate(addDays(fromDbDate(now), 31));
    const rules = await this.prisma.recurringRule.findMany({
      where: { isActive: true, remindDaysBefore: { gt: 0 }, nextDate: { lte: horizon } },
      include: { user: { select: { timezone: true } }, account: { select: { currency: true } } },
      take: 5000,
    });
    let sent = 0;
    const isLocked = this.locks.checker('recurring');
    for (const rule of rules) {
      if (await isLocked(rule.userId, rule.id)) continue;
      const today = todayIn(rule.user.timezone, now);
      const next = fromDbDate(rule.nextDate);
      const hour = localHour(rule.user.timezone, now);
      if (hour < 9 || hour > 20) continue; // nada de lembretes de madrugada
      if (rule.lastReminderFor && fromDbDate(rule.lastReminderFor) === next) continue;
      const inWindow = today >= addDays(next, -rule.remindDaysBefore) && today <= next;
      const overdueManual = !rule.autoCreate && next < today;
      if (!inWindow && !overdueManual) continue;
      const data = { ruleId: rule.id, description: rule.description, amount: num(rule.amount), currency: rule.account.currency, date: next };
      await this.notifications.notify(rule.userId, 'payment_reminder', data, (ctx) => ({
        ...data,
        amount: formatMoney(data.amount, data.currency, ctx.lang, ctx.country),
        date: formatDate(data.date, ctx.lang, ctx.country),
      }));
      await this.prisma.recurringRule.update({ where: { id: rule.id }, data: { lastReminderFor: rule.nextDate } });
      sent++;
    }
    return sent;
  }
}
