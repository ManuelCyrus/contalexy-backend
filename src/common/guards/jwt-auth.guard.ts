import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiException } from '../errors/api.exception';
import { env } from '../../config/env';

/// Todas as rotas precisam de sessão, exceto as marcadas com @Public().
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest();
    const header = request.headers['authorization'] as string | undefined;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      if (isPublic) return true;
      throw ApiException.unauthorized();
    }
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; email: string; sid?: string }>(token, { secret: env().JWT_ACCESS_SECRET });
      request.user = { userId: payload.sub, email: payload.email, sessionId: payload.sid ?? null };
      return true;
    } catch {
      // Rotas públicas continuam a funcionar com um token velho.
      if (isPublic) return true;
      throw ApiException.unauthorized('SESSION_EXPIRED');
    }
  }
}
