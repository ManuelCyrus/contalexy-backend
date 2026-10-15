import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/// O IP de quem fez o pedido (atrás de um proxy, o Express já lê o
/// X-Forwarded-For porque `trust proxy` está ligado).
export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | null => {
  const request = ctx.switchToHttp().getRequest();
  const ip = (request.ip ?? request.socket?.remoteAddress ?? '') as string;
  // "::ffff:203.0.113.7" → "203.0.113.7"
  const clean = ip.replace(/^::ffff:/, '').slice(0, 64);
  return clean || null;
});
