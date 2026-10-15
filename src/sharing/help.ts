import { CallHandler, CanActivate, ExecutionContext, Injectable, Logger, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApiException } from '../common/errors/api.exception';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { Language } from '../common/i18n/messages';

/// "Ajudar a gerir": quem acompanha (com o acesso aceite) pode usar as rotas
/// normais da app na conta de quem partilha, mandando o cabeçalho
/// `X-Contalex-Help: <id do acesso>`. Só passam as rotas marcadas com @Help e
/// só nas áreas que quem partilha deixou alterar.

export const HELP_HEADER = 'x-contalex-help';

/// Áreas onde quem acompanha pode ajudar a gerir.
export const HELP_SECTIONS = ['goals', 'budgets', 'plan', 'plans', 'recurring', 'transactions'] as const;
export type HelpSection = (typeof HELP_SECTIONS)[number];

/// O plano do mês e as despesas fixas mostram o que entra: para os gerir,
/// quem acompanha também tem de ver o que entra.
export const HELP_NEEDS_INCOME: readonly HelpSection[] = ['plan', 'recurring'];

export interface HelpRule {
  /// 'any' = serve a quem pode ajudar em alguma área (ex.: a lista de categorias)
  sections: HelpSection[] | 'any';
  write: boolean;
}

export const HELP_KEY = 'contalex:help';

/// Esta rota também serve a quem ajuda a gerir (só nas áreas indicadas).
export const Help = (sections: HelpSection | HelpSection[] | 'any', write = false) =>
  SetMetadata(HELP_KEY, { sections: sections === 'any' ? 'any' : ([] as HelpSection[]).concat(sections), write } satisfies HelpRule);

export interface HelpContext {
  accessId: string;
  /// Quem está a ajudar (a pessoa com sessão iniciada)
  actorId: string;
  actorName: string;
  /// Quem partilha vê o que entra (receitas)
  income: boolean;
  /// As áreas que pode alterar
  manage: HelpSection[];
  /// A área desta rota (null nas rotas 'any')
  section: HelpSection | null;
  write: boolean;
}

/// As áreas onde se pode mesmo ajudar: as escolhidas, que estejam à vista, sem
/// categorias reservadas e (no plano e nas despesas fixas) com o que entra à vista.
export function helpSections(access: { manageSections: string[]; sections: string[]; hiddenCategoryIds: string[] }): HelpSection[] {
  if (access.hiddenCategoryIds.length) return [];
  return HELP_SECTIONS.filter(
    (s) => access.manageSections.includes(s) && access.sections.includes(s) && (!HELP_NEEDS_INCOME.includes(s) || access.sections.includes('income')),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/// Corre depois do JwtAuthGuard: com o cabeçalho de ajuda, confirma o acesso
/// e passa a tratar o pedido como sendo de quem partilha.
@Injectable()
export class HelpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest();
    const raw = request.headers[HELP_HEADER] as string | string[] | undefined;
    if (raw === undefined || raw === '') return true;
    const user = request.user as AuthUser | undefined;
    if (!user) throw ApiException.unauthorized();
    const rule = this.reflector.getAllAndOverride<HelpRule | undefined>(HELP_KEY, [context.getHandler(), context.getClass()]);
    if (!rule) throw ApiException.forbidden('SHARE_HELP_NOT_ALLOWED');
    const accessId = (Array.isArray(raw) ? raw[0] : raw).trim();
    if (!UUID.test(accessId)) throw ApiException.notFound('SHARE_NOT_FOUND');
    const access = await this.prisma.sharedAccess.findUnique({
      where: { id: accessId },
      include: { owner: { select: { email: true, deletionRequestedAt: true } }, viewer: { select: { name: true } } },
    });
    if (!access || access.viewerId !== user.userId) throw ApiException.notFound('SHARE_NOT_FOUND');
    if (access.status !== 'ACTIVE' || access.owner.deletionRequestedAt) throw ApiException.forbidden('SHARE_NOT_ACTIVE');
    const manage = helpSections(access);
    if (!manage.length) throw ApiException.forbidden('SHARE_HELP_OFF');
    const allowed = rule.sections === 'any' ? manage : rule.sections.filter((s) => manage.includes(s));
    if (!allowed.length) throw ApiException.forbidden('SHARE_HELP_SECTION');
    const help: HelpContext = {
      accessId,
      actorId: user.userId,
      actorName: access.viewer?.name ?? '',
      income: access.sections.includes('income'),
      manage,
      section: rule.sections === 'any' ? null : allowed[0],
      write: rule.write,
    };
    request.user = { userId: access.ownerId, email: access.owner.email, sessionId: null, help } satisfies AuthUser;
    return true;
  }
}

// ------------------------------------------------------------------
// O que fica registado e o aviso a quem partilha
// ------------------------------------------------------------------

export type HelpAction = 'create' | 'update' | 'delete';

/// create = criou, remove = apagou; o resto (incluindo juntar ou tirar um
/// passo ou um item) conta como alterar.
export function helpActionOf(handler: string): HelpAction {
  if (handler === 'remove') return 'delete';
  if (handler === 'create') return 'create';
  return 'update';
}

/// O nome do que mudou, quando a resposta o traz.
export function helpLabelOf(result: unknown): string | null {
  const body = result && typeof result === 'object' && 'success' in result && 'data' in result ? (result as { data: unknown }).data : result;
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const pick = [o.name, o.description, o.title, o.merchant].find((v) => typeof v === 'string' && v.trim().length > 0) as string | undefined;
  return pick ? pick.trim().slice(0, 160) : null;
}

/// "criou um objetivo", "alterou um limite"… na língua de quem recebe o aviso.
const PHRASES: Record<Language, Record<HelpSection, Record<HelpAction, string>>> = {
  pt: {
    goals: { create: 'Criou um objetivo', update: 'Alterou um objetivo', delete: 'Apagou um objetivo' },
    budgets: { create: 'Criou um limite', update: 'Alterou um limite', delete: 'Apagou um limite' },
    plan: { create: 'Mexeu no plano do mês', update: 'Alterou o plano do mês', delete: 'Apagou o plano do mês' },
    plans: { create: 'Criou um plano', update: 'Alterou um plano', delete: 'Apagou um plano' },
    recurring: { create: 'Criou uma despesa fixa', update: 'Alterou uma despesa fixa', delete: 'Apagou uma despesa fixa' },
    transactions: { create: 'Registou um movimento', update: 'Alterou um movimento', delete: 'Apagou um movimento' },
  },
  en: {
    goals: { create: 'Created a goal', update: 'Changed a goal', delete: 'Deleted a goal' },
    budgets: { create: 'Created a limit', update: 'Changed a limit', delete: 'Deleted a limit' },
    plan: { create: 'Worked on the monthly plan', update: 'Changed the monthly plan', delete: 'Deleted the monthly plan' },
    plans: { create: 'Created a plan', update: 'Changed a plan', delete: 'Deleted a plan' },
    recurring: { create: 'Added a fixed expense', update: 'Changed a fixed expense', delete: 'Deleted a fixed expense' },
    transactions: { create: 'Added a transaction', update: 'Changed a transaction', delete: 'Deleted a transaction' },
  },
  fr: {
    goals: { create: 'A créé un objectif', update: 'A modifié un objectif', delete: 'A supprimé un objectif' },
    budgets: { create: 'A créé une limite', update: 'A modifié une limite', delete: 'A supprimé une limite' },
    plan: { create: 'A travaillé sur le plan du mois', update: 'A modifié le plan du mois', delete: 'A supprimé le plan du mois' },
    plans: { create: 'A créé un plan', update: 'A modifié un plan', delete: 'A supprimé un plan' },
    recurring: { create: 'A ajouté une dépense fixe', update: 'A modifié une dépense fixe', delete: 'A supprimé une dépense fixe' },
    transactions: { create: 'A ajouté une opération', update: 'A modifié une opération', delete: 'A supprimé une opération' },
  },
  de: {
    goals: { create: 'Hat ein Ziel erstellt', update: 'Hat ein Ziel geändert', delete: 'Hat ein Ziel gelöscht' },
    budgets: { create: 'Hat ein Limit erstellt', update: 'Hat ein Limit geändert', delete: 'Hat ein Limit gelöscht' },
    plan: { create: 'Hat am Monatsplan gearbeitet', update: 'Hat den Monatsplan geändert', delete: 'Hat den Monatsplan gelöscht' },
    plans: { create: 'Hat einen Plan erstellt', update: 'Hat einen Plan geändert', delete: 'Hat einen Plan gelöscht' },
    recurring: { create: 'Hat eine Fixausgabe hinzugefügt', update: 'Hat eine Fixausgabe geändert', delete: 'Hat eine Fixausgabe gelöscht' },
    transactions: { create: 'Hat eine Buchung hinzugefügt', update: 'Hat eine Buchung geändert', delete: 'Hat eine Buchung gelöscht' },
  },
};

export function helpPhrase(lang: Language, section: HelpSection, action: HelpAction, label: string | null): string {
  const base = (PHRASES[lang] ?? PHRASES.en)[section][action];
  return label ? `${base}: ${label}.` : `${base}.`;
}

export const HELP_PHRASES = PHRASES;

/// Depois de cada alteração feita por quem ajuda: fica registada e quem
/// partilha recebe um aviso (os seguidos juntam-se num só até o abrir).
@Injectable()
export class HelpActivityInterceptor implements NestInterceptor {
  private readonly logger = new Logger(HelpActivityInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthUser | undefined;
    const help = user?.help;
    if (!help || !help.write || !help.section || request.method === 'GET') return next.handle();
    const section = help.section;
    const action = helpActionOf(context.getHandler().name);
    return next.handle().pipe(
      tap((result) => {
        const label = action === 'delete' ? null : helpLabelOf(result);
        void this.record(user.userId, help, section, action, label);
      }),
    );
  }

  private async record(ownerId: string, help: HelpContext, section: HelpSection, action: HelpAction, label: string | null) {
    try {
      await this.prisma.sharedActivity.create({ data: { accessId: help.accessId, actorId: help.actorId, section, action, label } });
      await this.notifications.notify(
        ownerId,
        'help_change',
        { accessId: help.accessId, from: help.actorName, fromId: help.actorId, section, action, label },
        (ctx) => ({ from: help.actorName, what: helpPhrase(ctx.lang, section, action, label) }),
        { collapse: `help:${help.accessId}`, quietWhenCollapsed: true },
      );
    } catch (err) {
      this.logger.warn(`Não registei a ajuda: ${(err as Error).message}`);
    }
  }
}
