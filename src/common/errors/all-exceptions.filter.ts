import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiException } from './api.exception';
import { errorMessage, resolveLanguage } from '../i18n/messages';

interface ErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown };
  requestId?: string;
}

const STATUS_CODES: Record<number, string> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'FILE_TOO_LARGE',
  429: 'TOO_MANY_REQUESTS',
};

/// Todas as respostas de erro têm o mesmo formato:
/// { success: false, error: { code, message, details? } } — a mensagem no
/// idioma pedido em Accept-Language (a app envia o seu).
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const lang = resolveLanguage(request.headers['accept-language'] as string | undefined);
    const requestId = request.headers['x-request-id'] as string | undefined;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let params: Record<string, unknown> | undefined;
    let details: unknown;
    let fallback: string | undefined;

    if (exception instanceof ApiException) {
      status = exception.getStatus();
      code = exception.code;
      params = exception.params;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST');
      const body = exception.getResponse();
      if (typeof body === 'string') fallback = body;
      else if (body && typeof body === 'object' && 'message' in body) {
        const m = (body as { message?: unknown }).message;
        fallback = Array.isArray(m) ? m.join(', ') : typeof m === 'string' ? m : undefined;
      }
      // Ficheiro grande demais (multer)
      if (status === HttpStatus.PAYLOAD_TOO_LARGE) code = 'FILE_TOO_LARGE';
    } else if (isPrismaError(exception)) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        code = 'CONFLICT';
        fallback = 'Duplicate value.';
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        code = 'NOT_FOUND';
      } else {
        this.logger.error(`Prisma ${exception.code}: ${exception.message}`);
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    }

    if (status >= 500) this.logger.error(`[${requestId ?? '-'}] ${request.method} ${request.url} → ${code}`);

    const message = errorMessage(code, lang, params) ?? fallback ?? errorMessage('INTERNAL_ERROR', lang) ?? 'Error';
    const body: ErrorBody = { success: false, error: { code, message, ...(details !== undefined ? { details } : {}) }, requestId };
    response.status(status).json(body);
  }
}

function isPrismaError(e: unknown): e is { code: string; message: string } {
  return !!e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' && /^P\d{4}$/.test((e as { code: string }).code);
}
