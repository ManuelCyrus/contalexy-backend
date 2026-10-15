import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/// Respostas de sucesso: { success: true, data, meta? }. Um serviço pode
/// devolver { data, meta } (ex.: paginação) e passa como está.
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((result) => {
        if (result instanceof StreamableFile) return result;
        if (result && typeof result === 'object' && 'data' in result && Object.keys(result).every((k) => k === 'data' || k === 'meta')) {
          return { success: true, data: (result as { data: unknown }).data, meta: (result as { meta?: unknown }).meta };
        }
        return { success: true, data: result ?? null };
      }),
    );
  }
}
