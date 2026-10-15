import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiException } from '../common/errors/api.exception';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { EntitlementsService } from './entitlements.service';
import { AreaKey } from './plans.catalog';

/// A área da app a que cada rota pertence (só as que um código pode fechar).
const ROUTE_AREAS: [RegExp, AreaKey][] = [
  [/^\/v1\/spaces?(\/|$)|^\/v1\/space-invitations/, 'spaces'],
  [/^\/v1\/loans(\/|$)/, 'loans'],
  [/^\/v1\/sharing(\/|$)/, 'sharing'],
  [/^\/v1\/plans(\/|$)/, 'plans'],
  [/^\/v1\/goals(\/|$)/, 'goals'],
  [/^\/v1\/budgets(\/|$)/, 'budgets'],
  [/^\/v1\/recurring(\/|$)/, 'recurring'],
  [/^\/v1\/simulator(\/|$)/, 'simulator'],
  [/^\/v1\/ai(\/|$)/, 'ai'],
  [/^\/v1\/prices(\/|$)/, 'prices'],
  [/^\/v1\/rules(\/|$)/, 'rules'],
  [/^\/v1\/reports(\/|$)|^\/v1\/insights(\/|$)/, 'reports'],
  [/^\/v1\/chats(\/|$)/, 'chat'],
  [/^\/v1\/offers(\/|$)|^\/v1\/plan-offers(\/|$)/, 'offers'],
  [/^\/v1\/shopping-lists(\/|$)/, 'shopping'],
  [/^\/v1\/investments(\/|$)/, 'investments'],
  [/^\/v1\/import(\/|$)/, 'import'],
  [/^\/v1\/whatsapp(\/|$)/, 'whatsapp'],
];

export function areaOfPath(path: string): AreaKey | null {
  const clean = path.split('?')[0];
  for (const [re, area] of ROUTE_AREAS) if (re.test(clean)) return area;
  return null;
}

/// Recusa (AREA_BLOCKED) as rotas das áreas que o código promocional da
/// pessoa deixa fechadas. Vem depois da sessão; as rotas públicas passam.
@Injectable()
export class AreaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest();
    const userId = req.user?.userId as string | undefined;
    if (!userId) return true;
    const area = areaOfPath(req.originalUrl ?? req.url ?? '');
    if (!area) return true;
    const ent = await this.entitlements.forUser(userId);
    if (ent.blockedAreas.includes(area)) throw ApiException.forbidden('AREA_BLOCKED', { area }, { area });
    return true;
  }
}
