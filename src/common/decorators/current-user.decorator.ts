import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { HelpContext } from '../../sharing/help';

export interface AuthUser {
  userId: string;
  email: string;
  /// A sessão (aparelho) de onde vem o pedido — para a distinguir das outras
  sessionId: string | null;
  /// Pedido feito por quem ajuda a gerir: `userId` é o de quem partilha e
  /// aqui fica quem está mesmo a mexer (ver sharing/help.ts)
  help?: HelpContext;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
