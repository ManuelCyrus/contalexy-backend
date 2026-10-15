import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import { RedisService } from '../../infra/redis.service';

const TTL_SECONDS = 24 * 3600;

/// Pedidos que criam ou mudam coisas (POST, PUT, PATCH) com a chave
/// `X-Idempotency-Key`: a resposta fica guardada 24 h por pessoa e chave, e
/// repetir o pedido (a app sem rede tenta outra vez) devolve a mesma resposta
/// sem criar nada de novo. As rotas de IA têm ainda a sua própria memória.
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const key = (req.headers['x-idempotency-key'] as string | undefined)?.trim();
    const userId = req.user?.userId as string | undefined;
    if (!key || !userId || !['POST', 'PUT', 'PATCH'].includes(req.method) || key.length > 120) return next.handle();
    const storeKey = `idem:${userId}:${key}`;
    return from(this.redis.get(storeKey).catch(() => null)).pipe(
      switchMap((cached) => {
        if (cached) {
          try {
            return of(JSON.parse(cached));
          } catch {
            /* cache estragada: corre o pedido */
          }
        }
        return next.handle().pipe(
          tap((result) => {
            if (result && typeof result === 'object' && !('pipe' in (result as object))) {
              this.redis.set(storeKey, JSON.stringify(result), TTL_SECONDS).catch(() => undefined);
            }
          }),
        );
      }),
    );
  }
}
