import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ExchangeService } from '../exchange/exchange.service';
import { ApiException } from '../common/errors/api.exception';
import { resolveLanguage } from '../common/i18n/messages';
import { addDays, daysBetween, fromDbDate, fromDbDateOrNull, localHour, todayIn, toDbDate } from '../common/utils/dates';
import { formatDate, formatMoney, money, num, round2 } from '../common/utils/money';
import { env, isTrue } from '../config/env';
import { isCurrency } from '../meta/countries.data';
import { Loan, LoanDirection, LoanPayment } from '../generated/prisma/client';
import { AcceptLoanDto, CreateLoanDto, LinkLoanDto, LoanPaymentDto, UpdateLoanDto, LoanNudgeDto } from './loans.dto';

export interface LoanPerson {
  id: string;
  name: string;
  username: string;
  avatarUrl: string | null;
}

const person = { select: { id: true, name: true, username: true, avatarUrl: true } } as const;
/// Tudo o que é preciso para mostrar um empréstimo a qualquer um dos dois lados.
const full = { payments: true, user: person, counterpart: person } as const;

type LoanFull = Loan & { payments: LoanPayment[]; user: LoanPerson; counterpart: LoanPerson | null };

const flip = (d: LoanDirection): LoanDirection => (d === 'LENT' ? 'BORROWED' : 'LENT');
/// Uma frase citada à maneira de cada língua.
const quote = (text: string, lang: string) => (lang === 'en' ? `"${text}"` : lang === 'de' ? `„${text}“` : `«${text}»`);

/// Um empréstimo ligado conta para a outra pessoa quando ela já o aceitou.
const accepted = (loan: { counterpartId: string | null; linkStatus: string | null }) => !!loan.counterpartId && loan.linkStatus === 'ACCEPTED';

/// Dias depois da data em que se volta a lembrar (depois disso, de 14 em 14).
const OVERDUE_DAYS = [1, 3, 7, 14, 30];

/// Descrição do movimento criado na conta, no idioma da pessoa.
const TX_TEXT: Record<string, Record<string, string>> = {
  lent: { pt: 'Empréstimo a {name}', en: 'Loan to {name}', fr: 'Prêt à {name}', de: 'Darlehen an {name}' },
  borrowed: { pt: 'Empréstimo de {name}', en: 'Loan from {name}', fr: 'Emprunt à {name}', de: 'Darlehen von {name}' },
  repaidToMe: { pt: 'Devolução de {name}', en: 'Repayment from {name}', fr: 'Remboursement de {name}', de: 'Rückzahlung von {name}' },
  repaidByMe: { pt: 'Devolução a {name}', en: 'Repayment to {name}', fr: 'Remboursement à {name}', de: 'Rückzahlung an {name}' },
};

/// Quais os dias de atraso em que se lembra (1, 3, 7, 14, 30, depois de 14 em 14).
export function overdueReminderDay(daysLate: number): number | null {
  if (daysLate <= 0) return null;
  if (OVERDUE_DAYS.includes(daysLate)) return daysLate;
  if (daysLate > 30 && (daysLate - 30) % 14 === 0) return daysLate;
  return null;
}

/// O lembrete que cabe a um empréstimo hoje (ou null).
export function reminderFor(
  loan: { dueDate: string | null; remindDaysBefore: number[]; remindOnDue: boolean; remindOverdue: boolean },
  today: string,
): { kind: 'due_soon' | 'due_today' | 'overdue'; key: string; days: number } | null {
  if (!loan.dueDate) return null;
  const days = daysBetween(today, loan.dueDate);
  if (days > 0) {
    return loan.remindDaysBefore.includes(days) ? { kind: 'due_soon', key: `before:${days}:${loan.dueDate}`, days } : null;
  }
  if (days === 0) return loan.remindOnDue ? { kind: 'due_today', key: `due:${loan.dueDate}`, days: 0 } : null;
  if (!loan.remindOverdue) return null;
  const late = overdueReminderDay(-days);
  return late ? { kind: 'overdue', key: `overdue:${late}:${loan.dueDate}`, days: late } : null;
}

/// Empréstimos entre pessoas: o que emprestei (devem-me) e o que pedi
/// emprestado (devo), com data para devolver e lembretes.
///
/// Quando a outra pessoa também usa o Contalexy, o empréstimo pode ficar
/// LIGADO: ela recebe o pedido, aceita, e a partir daí os dois veem o mesmo
/// empréstimo (cada um do seu lado) e as devoluções que qualquer um registar.
@Injectable()
export class LoansService {
  private readonly logger = new Logger(LoansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
    private readonly exchange: ExchangeService,
  ) {}

  private async settings(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { timezone: true, currency: true, language: true, name: true } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    return { today: todayIn(user.timezone), currency: user.currency, lang: resolveLanguage(user.language), name: user.name };
  }

  /// O empréstimo como `viewerId` o vê: quem o criou vê-o como o escreveu;
  /// a outra pessoa vê-o ao contrário (o "emprestei" de um é o "devo" do outro).
  toDto(loan: LoanFull, today: string, viewerId: string, withPayments = false) {
    const mine = loan.userId === viewerId;
    const amount = num(loan.amount);
    const paid = round2(loan.payments.reduce((acc, p) => acc + num(p.amount), 0));
    const remaining = round2(Math.max(0, amount - paid));
    const dueDate = fromDbDateOrNull(loan.dueDate);
    const open = loan.status === 'OPEN';
    const daysUntilDue = dueDate && open ? daysBetween(today, dueDate) : null;
    const linked = !!loan.counterpartId && !!loan.linkStatus;
    return {
      id: loan.id,
      direction: mine ? loan.direction : flip(loan.direction),
      personName: mine ? loan.personName : loan.user.name,
      amount,
      currency: loan.currency,
      date: fromDbDate(loan.date),
      dueDate,
      note: loan.note,
      accountId: mine ? loan.accountId : null,
      remindDaysBefore: [...loan.remindDaysBefore].sort((a, b) => b - a),
      remindOnDue: loan.remindOnDue,
      remindOverdue: loan.remindOverdue,
      status: loan.status,
      settledAt: loan.settledAt,
      pinned: (mine ? loan.pinnedAt : loan.counterpartPinnedAt) !== null,
      paid,
      remaining,
      progress: amount > 0 ? Math.min(100, round2((paid / amount) * 100)) : 0,
      daysUntilDue,
      overdue: daysUntilDue !== null && daysUntilDue < 0,
      createdAt: loan.createdAt,
      /// Fui eu que criei (só quem cria muda os dados ou apaga)
      mine,
      /// A ligação à conta da outra pessoa (null = empréstimo só meu)
      link: linked
        ? {
            /// PENDING | ACCEPTED | DECLINED | LEFT
            status: loan.linkStatus as string,
            role: mine ? ('owner' as const) : ('counterpart' as const),
            /// A outra pessoa
            user: mine ? loan.counterpart : loan.user,
            respondedAt: loan.linkRespondedAt,
          }
        : null,
      ...(withPayments
        ? {
            payments: [...loan.payments]
              .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt.getTime() - a.createdAt.getTime()))
              .map((p) => {
                const author = p.createdById ?? loan.userId;
                return {
                  id: p.id,
                  amount: num(p.amount),
                  date: fromDbDate(p.date),
                  note: p.note,
                  /// Só quem registou vê o movimento que isso criou na sua conta
                  transactionId: author === viewerId ? p.transactionId : null,
                  /// Fui eu que registei esta devolução
                  mine: author === viewerId,
                  canRemove: mine || author === viewerId,
                  createdAt: p.createdAt,
                };
              }),
          }
        : {}),
    };
  }

  /// Os empréstimos que a pessoa vê: os que criou e os ligados que aceitou.
  private visible(userId: string) {
    return { OR: [{ userId }, { counterpartId: userId, linkStatus: 'ACCEPTED' }] };
  }

  /// status: open (por omissão) | closed | all
  async list(userId: string, status: 'open' | 'closed' | 'all' = 'open') {
    const s = await this.settings(userId);
    const [loans, requests] = await Promise.all([
      this.prisma.loan.findMany({
        where: { AND: [this.visible(userId), status === 'open' ? { status: 'OPEN' } : status === 'closed' ? { status: { not: 'OPEN' } } : {}] },
        include: full,
      }),
      // Pedidos à espera da minha resposta ("a Ana diz que te emprestou 50 €")
      this.prisma.loan.findMany({ where: { counterpartId: userId, linkStatus: 'PENDING', status: 'OPEN' }, include: full, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    const items = loans.map((l) => this.toDto(l, s.today, userId));
    // Fixados primeiro; depois os atrasados, os que vencem mais cedo, os sem data.
    const rank = (l: (typeof items)[number]) => (l.status !== 'OPEN' ? 3 : l.overdue ? 0 : l.dueDate ? 1 : 2);
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
    return { items, requests: requests.map((l) => this.toDto(l, s.today, userId)), summary: await this.summaryOf(userId, s) };
  }

  /// Totais em aberto na moeda principal (para a lista e para o Início).
  async summary(userId: string) {
    return this.summaryOf(userId, await this.settings(userId));
  }

  private async summaryOf(userId: string, s: { today: string; currency: string }) {
    const [rows, requestsCount] = await Promise.all([
      this.prisma.loan.findMany({ where: { AND: [this.visible(userId), { status: 'OPEN' }] }, include: full }),
      this.prisma.loan.count({ where: { counterpartId: userId, linkStatus: 'PENDING', status: 'OPEN' } }),
    ]);
    const open = rows.map((l) => this.toDto(l, s.today, userId));
    let owedToMe = 0;
    let iOwe = 0;
    const unconverted = new Set<string>();
    for (const l of open) {
      const value = this.exchange.convert(l.remaining, l.currency, s.currency);
      if (value === null) {
        unconverted.add(l.currency);
        continue;
      }
      if (l.direction === 'LENT') owedToMe += value;
      else iOwe += value;
    }
    const withDue = open.filter((l) => l.dueDate).sort((a, b) => ((a.dueDate as string) < (b.dueDate as string) ? -1 : 1));
    const next = withDue[0] ?? null;
    return {
      currency: s.currency,
      owedToMe: round2(owedToMe),
      iOwe: round2(iOwe),
      openCount: open.length,
      overdueCount: open.filter((l) => l.overdue).length,
      nextDue: next ? { loanId: next.id, direction: next.direction, personName: next.personName, remaining: next.remaining, currency: next.currency, dueDate: next.dueDate, daysUntilDue: next.daysUntilDue } : null,
      pinned: open.filter((l) => l.pinned).slice(0, 5),
      /// Pedidos de empréstimos ligados à espera da minha resposta
      requestsCount,
      unconverted: [...unconverted],
    };
  }

  /// Só quem criou o empréstimo (para mudar os dados, apagar ou ligar).
  private async ownedOrThrow(userId: string, id: string): Promise<LoanFull> {
    const loan = await this.prisma.loan.findFirst({ where: { id, userId }, include: full });
    if (!loan) throw ApiException.notFound('LOAN_NOT_FOUND');
    return loan;
  }

  /// Quem criou — ou a outra pessoa, se o empréstimo está ligado a ela
  /// (com o pedido aceite ou, com `pending`, ainda à espera de resposta).
  private async visibleOrThrow(userId: string, id: string, opts: { pending?: boolean } = {}): Promise<LoanFull> {
    const loan = await this.prisma.loan.findFirst({
      where: { id, OR: [{ userId }, { counterpartId: userId, linkStatus: { in: opts.pending ? ['ACCEPTED', 'PENDING'] : ['ACCEPTED'] } }] },
      include: full,
    });
    if (!loan) throw ApiException.notFound('LOAN_NOT_FOUND');
    return loan;
  }

  async get(userId: string, id: string) {
    const s = await this.settings(userId);
    return this.toDto(await this.visibleOrThrow(userId, id, { pending: true }), s.today, userId, true);
  }

  /// A pessoa a quem o empréstimo fica ligado (pelo id ou pelo @username).
  private async counterpartOf(userId: string, dto: { counterpartId?: string | null; counterpartUsername?: string | null }): Promise<LoanPerson | null> {
    if (!dto.counterpartId && !dto.counterpartUsername) return null;
    const other = await this.prisma.user.findFirst({
      where: { deletionRequestedAt: null, ...(dto.counterpartId ? { id: dto.counterpartId } : { username: (dto.counterpartUsername as string).replace(/^@/, '') }) },
      ...person,
    });
    if (!other) throw ApiException.notFound('USER_NOT_FOUND');
    if (other.id === userId) throw ApiException.badRequest('LOAN_LINK_SELF');
    return other;
  }

  /// Avisa a outra pessoa de um empréstimo ligado (se houver e já contar para ela).
  private async tell(target: string | null, type: string, data: Record<string, unknown> & { amount?: number; remaining?: number; currency: string }) {
    if (!target) return;
    await this.notifications.notify(target, type, data, (ctx) => ({
      ...data,
      ...(data.amount !== undefined ? { amount: formatMoney(data.amount, data.currency, ctx.lang, ctx.country) } : {}),
      ...(data.remaining !== undefined ? { remaining: formatMoney(data.remaining, data.currency, ctx.lang, ctx.country) } : {}),
    }));
  }

  /// O pedido que a outra pessoa recebe: "a Ana registou que te emprestou 50 €".
  private async sendRequest(loan: { id: string; userId: string; direction: LoanDirection; amount: unknown; currency: string }, counterpartId: string, from: string) {
    // Visto do lado de quem recebe: se eu emprestei, a pessoa pediu emprestado.
    const theirs = flip(loan.direction);
    await this.tell(counterpartId, theirs === 'BORROWED' ? 'loan_request_borrowed' : 'loan_request_lent', {
      loanId: loan.id,
      from,
      fromId: loan.userId,
      direction: theirs,
      amount: num(loan.amount as never),
      currency: loan.currency,
    });
  }

  private async accountOrThrow(userId: string, accountId: string) {
    const account = await this.prisma.account.findFirst({ where: { id: accountId, userId }, select: { id: true, currency: true } });
    if (!account) throw ApiException.notFound('ACCOUNT_NOT_FOUND');
    return account;
  }

  private text(key: keyof typeof TX_TEXT, lang: string, name: string) {
    return (TX_TEXT[key][lang] ?? TX_TEXT[key].en).replace('{name}', name);
  }

  async create(userId: string, dto: CreateLoanDto) {
    const s = await this.settings(userId);
    await this.entitlements.assertLimit(userId, 'loans', await this.prisma.loan.count({ where: { userId, status: 'OPEN' } }));
    const counterpart = await this.counterpartOf(userId, dto);
    const personName = dto.personName ?? counterpart?.name;
    if (!personName) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'personName', message: 'required' }]);
    const account = dto.accountId ? await this.accountOrThrow(userId, dto.accountId) : null;
    // Com conta, a moeda é a da conta (o movimento tem de bater com ela).
    const currency = account && dto.registerTransaction ? account.currency : (dto.currency ?? account?.currency ?? s.currency);
    if (!isCurrency(currency)) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'currency', message: 'unknown' }]);
    const date = dto.date ?? s.today;
    if (dto.dueDate && dto.dueDate < date) throw ApiException.badRequest('DATE_RANGE_INVALID');

    const loan = await this.prisma.$transaction(async (tx) => {
      const created = await tx.loan.create({
        data: {
          userId,
          direction: dto.direction,
          personName: personName.slice(0, 60),
          counterpartId: counterpart?.id ?? null,
          linkStatus: counterpart ? 'PENDING' : null,
          amount: money(dto.amount),
          currency,
          date: toDbDate(date),
          dueDate: dto.dueDate ? toDbDate(dto.dueDate) : null,
          note: dto.note ?? null,
          accountId: account?.id ?? null,
          remindDaysBefore: dto.remindDaysBefore ? [...new Set(dto.remindDaysBefore)] : [3, 1],
          remindOnDue: dto.remindOnDue ?? true,
          remindOverdue: dto.remindOverdue ?? true,
          pinnedAt: dto.pinned ? new Date() : null,
        },
      });
      if (account && dto.registerTransaction) {
        // Emprestar tira dinheiro da conta; pedir emprestado põe dinheiro na
        // conta. Não é despesa nem receita — fica fora dos relatórios.
        await tx.transaction.create({
          data: {
            userId,
            type: dto.direction === 'LENT' ? 'EXPENSE' : 'INCOME',
            amount: money(dto.amount),
            currency,
            accountId: account.id,
            date: toDbDate(date),
            description: this.text(dto.direction === 'LENT' ? 'lent' : 'borrowed', s.lang, personName),
            excludeFromReports: true,
            loanId: created.id,
          },
        });
      }
      return created;
    });
    if (counterpart) await this.sendRequest(loan, counterpart.id, s.name);
    return this.get(userId, loan.id);
  }

  // ------------------------------------------------------------------
  // Empréstimos ligados: pedir, aceitar, recusar, deixar
  // ------------------------------------------------------------------

  /// Liga um empréstimo que já existia à conta da outra pessoa (ela recebe o pedido).
  async link(userId: string, id: string, dto: LinkLoanDto) {
    const s = await this.settings(userId);
    const loan = await this.ownedOrThrow(userId, id);
    if (loan.status !== 'OPEN') throw ApiException.badRequest('LOAN_CLOSED');
    if (accepted(loan)) throw ApiException.conflict('LOAN_ALREADY_LINKED');
    const counterpart = (await this.counterpartOf(userId, dto)) as LoanPerson;
    await this.prisma.loan.update({ where: { id }, data: { counterpartId: counterpart.id, linkStatus: 'PENDING', linkRespondedAt: null, counterpartPinnedAt: null } });
    await this.sendRequest(loan, counterpart.id, s.name);
    return this.get(userId, id);
  }

  /// Quem criou desfaz a ligação (ou desiste do pedido): o empréstimo volta a ser só seu.
  async unlink(userId: string, id: string) {
    const s = await this.settings(userId);
    const loan = await this.ownedOrThrow(userId, id);
    if (!loan.counterpartId) throw ApiException.badRequest('LOAN_NOT_LINKED');
    await this.prisma.loan.update({ where: { id }, data: { counterpartId: null, linkStatus: null, linkRespondedAt: null, counterpartPinnedAt: null } });
    if (accepted(loan)) await this.tell(loan.counterpartId, 'loan_removed', { from: s.name, amount: num(loan.amount), currency: loan.currency });
    return this.get(userId, id);
  }

  private async requestOrThrow(userId: string, id: string): Promise<LoanFull> {
    const loan = await this.prisma.loan.findFirst({ where: { id, counterpartId: userId }, include: full });
    if (!loan) throw ApiException.notFound('LOAN_NOT_FOUND');
    if (loan.linkStatus !== 'PENDING') throw ApiException.badRequest('LOAN_REQUEST_CLOSED');
    return loan;
  }

  /// A outra pessoa confirma: o empréstimo passa a aparecer também na conta
  /// dela. Pode logo registar o dinheiro numa conta sua.
  async accept(userId: string, id: string, dto: AcceptLoanDto) {
    const s = await this.settings(userId);
    const loan = await this.requestOrThrow(userId, id);
    const account = dto.accountId ? await this.accountOrThrow(userId, dto.accountId) : null;
    if (account && account.currency !== loan.currency) throw ApiException.badRequest('LOAN_CURRENCY_MISMATCH');
    // Do meu lado: se a pessoa me emprestou, entrou dinheiro; se lhe emprestei, saiu.
    const myDirection = flip(loan.direction);
    await this.prisma.$transaction(async (tx) => {
      await tx.loan.update({ where: { id }, data: { linkStatus: 'ACCEPTED', linkRespondedAt: new Date() } });
      if (account) {
        await tx.transaction.create({
          data: {
            userId,
            type: myDirection === 'LENT' ? 'EXPENSE' : 'INCOME',
            amount: loan.amount,
            currency: loan.currency,
            accountId: account.id,
            date: loan.date,
            description: this.text(myDirection === 'LENT' ? 'lent' : 'borrowed', s.lang, loan.user.name),
            excludeFromReports: true,
            loanId: loan.id,
          },
        });
      }
    });
    await this.tell(loan.userId, 'loan_accepted', { loanId: id, from: s.name, amount: num(loan.amount), currency: loan.currency });
    return this.get(userId, id);
  }

  async decline(userId: string, id: string) {
    const s = await this.settings(userId);
    const loan = await this.requestOrThrow(userId, id);
    await this.prisma.loan.update({ where: { id }, data: { linkStatus: 'DECLINED', linkRespondedAt: new Date() } });
    await this.tell(loan.userId, 'loan_declined', { loanId: id, from: s.name, amount: num(loan.amount), currency: loan.currency });
    return { declined: true };
  }

  /// A outra pessoa deixa de acompanhar o empréstimo (para quem criou, continua lá).
  private async leave(loan: LoanFull, from: string) {
    await this.prisma.loan.update({ where: { id: loan.id }, data: { linkStatus: 'LEFT', linkRespondedAt: new Date(), counterpartPinnedAt: null } });
    await this.tell(loan.userId, 'loan_left', { loanId: loan.id, from, amount: num(loan.amount), currency: loan.currency });
    return { deleted: true, left: true };
  }

  async update(userId: string, id: string, dto: UpdateLoanDto) {
    const s = await this.settings(userId);
    const loan = await this.visibleOrThrow(userId, id);
    if (loan.userId !== userId) {
      // Do outro lado só se mexe no que é de cada um: fixar no Início.
      const { pinned, ...rest } = dto;
      if (pinned === undefined || Object.values(rest).some((v) => v !== undefined)) throw ApiException.forbidden('LOAN_OWNER_ONLY');
      await this.prisma.loan.update({ where: { id }, data: { counterpartPinnedAt: pinned ? (loan.counterpartPinnedAt ?? new Date()) : null } });
      return this.get(userId, id);
    }
    const paid = loan.payments.reduce((acc, p) => acc + num(p.amount), 0);
    if (dto.amount !== undefined && dto.amount + 0.005 < paid) throw ApiException.badRequest('LOAN_AMOUNT_BELOW_PAID');
    const date = dto.date ?? fromDbDate(loan.date);
    const due = dto.dueDate === undefined ? fromDbDateOrNull(loan.dueDate) : dto.dueDate;
    if (due && due < date) throw ApiException.badRequest('DATE_RANGE_INVALID');
    const amount = dto.amount ?? num(loan.amount);

    // Estado: fechar à mão (perdoar), reabrir, ou acompanhar o que já foi devolvido.
    let status = loan.status;
    let settledAt = loan.settledAt;
    if (dto.status === 'CANCELLED') {
      status = 'CANCELLED';
      settledAt = new Date();
    } else if (dto.status === 'OPEN' || dto.amount !== undefined) {
      const settled = paid + 0.005 >= amount;
      status = settled ? 'SETTLED' : 'OPEN';
      settledAt = settled ? (loan.settledAt ?? new Date()) : null;
    }
    await this.prisma.loan.update({
      where: { id },
      data: {
        personName: dto.personName,
        amount: dto.amount !== undefined ? money(dto.amount) : undefined,
        date: dto.date ? toDbDate(dto.date) : undefined,
        dueDate: dto.dueDate === undefined ? undefined : dto.dueDate ? toDbDate(dto.dueDate) : null,
        note: dto.note,
        remindDaysBefore: dto.remindDaysBefore ? [...new Set(dto.remindDaysBefore)] : undefined,
        remindOnDue: dto.remindOnDue,
        remindOverdue: dto.remindOverdue,
        pinnedAt: dto.pinned === undefined ? undefined : dto.pinned ? (loan.pinnedAt ?? new Date()) : null,
        status,
        settledAt,
      },
    });
    // Mudou a data: os lembretes antigos deixam de valer.
    if (dto.dueDate !== undefined) await this.prisma.loanReminder.deleteMany({ where: { loanId: id } });
    // Num empréstimo ligado, a outra pessoa fica a saber do que mudou.
    const changed = (dto.amount !== undefined && Math.abs(dto.amount - num(loan.amount)) >= 0.005) || (dto.dueDate !== undefined && dto.dueDate !== fromDbDateOrNull(loan.dueDate)) || (dto.status !== undefined && status !== loan.status);
    if (changed && accepted(loan)) {
      await this.tell(loan.counterpartId, status === 'CANCELLED' ? 'loan_cancelled' : 'loan_changed', { loanId: id, from: s.name, amount, currency: loan.currency });
    }
    return this.get(userId, id);
  }

  /// Apaga o empréstimo. Os movimentos que ele criou nas contas ficam (para
  /// os saldos não mudarem sozinhos), a não ser que se peça para os apagar.
  async remove(userId: string, id: string, deleteTransactions = false) {
    const s = await this.settings(userId);
    const loan = await this.visibleOrThrow(userId, id);
    // Quem está do outro lado não apaga o empréstimo: só deixa de o acompanhar.
    if (loan.userId !== userId) return this.leave(loan, s.name);
    if (deleteTransactions) await this.prisma.transaction.deleteMany({ where: { userId, loanId: id } });
    await this.prisma.loan.delete({ where: { id } });
    if (loan.counterpartId && (loan.linkStatus === 'ACCEPTED' || loan.linkStatus === 'PENDING')) {
      await this.tell(loan.counterpartId, 'loan_removed', { from: s.name, amount: num(loan.amount), currency: loan.currency });
    }
    return { deleted: true };
  }

  /// Regista uma devolução (total ou parcial).
  async addPayment(userId: string, id: string, dto: LoanPaymentDto) {
    const s = await this.settings(userId);
    const loan = await this.visibleOrThrow(userId, id);
    if (loan.status === 'CANCELLED') throw ApiException.badRequest('LOAN_CLOSED');
    const mine = loan.userId === userId;
    // O empréstimo visto do meu lado, e como se chama a outra pessoa para mim.
    const myDirection = mine ? loan.direction : flip(loan.direction);
    const otherName = mine ? loan.personName : loan.user.name;
    const paid = loan.payments.reduce((acc, p) => acc + num(p.amount), 0);
    const remaining = round2(num(loan.amount) - paid);
    if (dto.amount > remaining + 0.005) throw ApiException.badRequest('LOAN_PAYMENT_TOO_HIGH', { max: formatMoney(remaining, loan.currency, s.lang) });
    const account = dto.accountId ? await this.accountOrThrow(userId, dto.accountId) : null;
    if (account && account.currency !== loan.currency) throw ApiException.badRequest('LOAN_CURRENCY_MISMATCH');
    const date = dto.date ?? s.today;

    await this.prisma.$transaction(async (tx) => {
      let transactionId: string | null = null;
      if (account) {
        const created = await tx.transaction.create({
          data: {
            userId,
            // Devolveram-me → entra dinheiro; devolvi → sai dinheiro.
            type: myDirection === 'LENT' ? 'INCOME' : 'EXPENSE',
            amount: money(dto.amount),
            currency: loan.currency,
            accountId: account.id,
            date: toDbDate(date),
            description: this.text(myDirection === 'LENT' ? 'repaidToMe' : 'repaidByMe', s.lang, otherName),
            excludeFromReports: true,
            loanId: loan.id,
          },
        });
        transactionId = created.id;
      }
      await tx.loanPayment.create({ data: { loanId: loan.id, amount: money(dto.amount), date: toDbDate(date), note: dto.note ?? null, transactionId, createdById: userId } });
      if (dto.amount + 0.005 >= remaining) await tx.loan.update({ where: { id: loan.id }, data: { status: 'SETTLED', settledAt: new Date() } });
    });
    // Empréstimo ligado: a outra pessoa vê logo o que foi devolvido e o que falta.
    if (accepted(loan)) {
      const left = round2(Math.max(0, remaining - dto.amount));
      const other = mine ? loan.counterpartId : loan.userId;
      // Do lado de quem recebe o aviso: é quem emprestou ou quem deve?
      const theirs = flip(myDirection);
      await this.tell(other, left <= 0 ? 'loan_settled' : theirs === 'LENT' ? 'loan_payment_lent' : 'loan_payment_borrowed', {
        loanId: loan.id,
        from: s.name,
        amount: dto.amount,
        remaining: left,
        currency: loan.currency,
      });
    }
    return this.get(userId, id);
  }

  /// Um lembrete à outra pessoa de um empréstimo ligado: quem emprestou lembra
  /// quanto falta devolver; quem pediu emprestado dá notícias (ex.: quando
  /// conta devolver). Um por dia, de cada lado.
  async nudge(userId: string, id: string, dto: LoanNudgeDto) {
    const loan = await this.visibleOrThrow(userId, id);
    if (!accepted(loan)) throw ApiException.badRequest('LOAN_NOT_LINKED');
    if (loan.status !== 'OPEN') throw ApiException.badRequest('LOAN_CLOSED');
    const s = await this.settings(userId);
    const view = this.toDto(loan, s.today, userId);
    if (view.remaining <= 0) throw ApiException.badRequest('LOAN_CLOSED');
    const mine = loan.userId === userId;
    const target = mine ? (loan.counterpartId as string) : loan.userId;
    try {
      await this.prisma.loanReminder.create({ data: { loanId: loan.id, key: `nudge:${userId}:${s.today}` } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw ApiException.conflict('REMINDER_SENT_TODAY');
      throw err;
    }
    const message = dto.message?.trim() || null;
    const type = view.direction === 'LENT' ? 'loan_nudge' : 'loan_note';
    const data = { loanId: loan.id, from: s.name, fromId: userId, remaining: view.remaining, currency: loan.currency, message: message ?? '' };
    await this.notifications.notify(target, type, data, (ctx) => ({
      from: s.name,
      remaining: formatMoney(view.remaining, loan.currency, ctx.lang, ctx.country),
      note: message ? ` ${quote(message, ctx.lang)}` : '',
    }));
    return { sent: true, to: target };
  }

  async removePayment(userId: string, id: string, paymentId: string) {
    const s = await this.settings(userId);
    const loan = await this.visibleOrThrow(userId, id);
    const payment = loan.payments.find((p) => p.id === paymentId);
    if (!payment) throw ApiException.notFound('LOAN_PAYMENT_NOT_FOUND');
    const mine = loan.userId === userId;
    // Quem criou o empréstimo anula qualquer devolução; a outra pessoa, só as que registou.
    if (!mine && (payment.createdById ?? loan.userId) !== userId) throw ApiException.forbidden('LOAN_OWNER_ONLY');
    await this.prisma.$transaction(async (tx) => {
      // Só se apaga o movimento de quem está a anular (nunca o da conta de outra pessoa).
      if (payment.transactionId) await tx.transaction.deleteMany({ where: { id: payment.transactionId, userId } });
      await tx.loanPayment.delete({ where: { id: paymentId } });
      if (loan.status === 'SETTLED') await tx.loan.update({ where: { id }, data: { status: 'OPEN', settledAt: null } });
    });
    if (accepted(loan)) {
      await this.tell(mine ? loan.counterpartId : loan.userId, 'loan_payment_removed', { loanId: id, from: s.name, amount: num(payment.amount), currency: loan.currency });
    }
    return this.get(userId, id);
  }

  // ------------------------------------------------------------------
  // Lembretes
  // ------------------------------------------------------------------

  @Cron('12 * * * *')
  async hourlyJob() {
    if (!isTrue(env().JOBS_ENABLED)) return;
    await this.sendReminders();
  }

  /// Avisa X dias antes, no dia e (se a pessoa quiser) depois de passar a data.
  /// Cada aviso só sai uma vez (LoanReminder) e nunca de madrugada.
  async sendReminders(now = new Date()) {
    const horizon = toDbDate(addDays(fromDbDate(now), 92));
    const loans = await this.prisma.loan.findMany({
      where: { status: 'OPEN', dueDate: { not: null, lte: horizon } },
      include: { ...full, user: { select: { ...person.select, timezone: true } } },
      take: 5000,
    });
    let sent = 0;
    for (const loan of loans) {
      const hour = localHour(loan.user.timezone, now);
      if (hour < 9 || hour > 20) continue;
      const today = todayIn(loan.user.timezone, now);
      const dto = this.toDto(loan, today, loan.userId);
      if (dto.remaining <= 0) continue;
      const reminder = reminderFor(dto, today);
      if (!reminder) continue;
      try {
        await this.prisma.loanReminder.create({ data: { loanId: loan.id, key: reminder.key } });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') continue; // já foi enviado
        throw err;
      }
      const type = `loan_${loan.direction === 'LENT' ? 'lent' : 'borrowed'}_${reminder.kind}`;
      const data = { loanId: loan.id, direction: loan.direction as LoanDirection, person: loan.personName, amount: dto.remaining, currency: loan.currency, dueDate: dto.dueDate as string, days: reminder.days };
      await this.notifications.notify(loan.userId, type, data, (ctx) => ({
        ...data,
        amount: formatMoney(data.amount, data.currency, ctx.lang, ctx.country),
        date: formatDate(data.dueDate, ctx.lang, ctx.country),
      }));
      // Num empréstimo ligado, a outra pessoa também é lembrada — do lado dela.
      if (accepted(loan) && loan.counterpartId) {
        const theirs = flip(loan.direction);
        const mirrored = { ...data, direction: theirs, person: loan.user.name };
        await this.notifications.notify(loan.counterpartId, `loan_${theirs === 'LENT' ? 'lent' : 'borrowed'}_${reminder.kind}`, mirrored, (ctx) => ({
          ...mirrored,
          amount: formatMoney(mirrored.amount, mirrored.currency, ctx.lang, ctx.country),
          date: formatDate(mirrored.dueDate, ctx.lang, ctx.country),
        }));
      }
      sent++;
    }
    if (sent) this.logger.log(`Empréstimos: ${sent} lembrete(s) enviados.`);
    return sent;
  }
}
