import { HttpException, HttpStatus } from '@nestjs/common';

/// Erro da API com um CÓDIGO estável (a app reage ao código, e a
/// mensagem sai traduzida no idioma de quem pediu — ver messages.ts).
export class ApiException extends HttpException {
  constructor(
    public readonly code: string,
    status: HttpStatus,
    public readonly params?: Record<string, unknown>,
    public readonly details?: unknown,
  ) {
    super({ code }, status);
  }

  static badRequest(code: string, params?: Record<string, unknown>, details?: unknown) {
    return new ApiException(code, HttpStatus.BAD_REQUEST, params, details);
  }
  static unauthorized(code = 'UNAUTHORIZED') {
    return new ApiException(code, HttpStatus.UNAUTHORIZED);
  }
  static forbidden(code = 'FORBIDDEN', params?: Record<string, unknown>, details?: unknown) {
    return new ApiException(code, HttpStatus.FORBIDDEN, params, details);
  }
  static notFound(code = 'NOT_FOUND') {
    return new ApiException(code, HttpStatus.NOT_FOUND);
  }
  static conflict(code: string, params?: Record<string, unknown>) {
    return new ApiException(code, HttpStatus.CONFLICT, params);
  }
  static tooManyRequests(code = 'TOO_MANY_REQUESTS', params?: Record<string, unknown>, details?: unknown) {
    return new ApiException(code, HttpStatus.TOO_MANY_REQUESTS, params, details);
  }
  static unavailable(code: string) {
    return new ApiException(code, HttpStatus.SERVICE_UNAVAILABLE);
  }
  /// Funcionalidade de um plano pago — a app abre a explicação do Premium.
  static premiumRequired(feature: string, requiredPlan: string) {
    return new ApiException('PREMIUM_REQUIRED', HttpStatus.FORBIDDEN, { feature, plan: requiredPlan }, { feature, requiredPlan });
  }
  static planLimit(limit: string, max: number, requiredPlan: string | null) {
    return new ApiException('PLAN_LIMIT_REACHED', HttpStatus.FORBIDDEN, { limit, max }, { limit, max, requiredPlan });
  }
  /// Um item criado com um plano pago que a pessoa já não tem: existe, mas
  /// fica fechado até voltar a ter o plano (a app mostra só uma amostra).
  static itemLocked(limit: string, max: number, requiredPlan: string | null) {
    return new ApiException('PLAN_ITEM_LOCKED', HttpStatus.FORBIDDEN, { limit, max }, { limit, max, requiredPlan, locked: true });
  }
}
