import { Injectable, Logger } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { ApiException } from '../common/errors/api.exception';
import { env } from '../config/env';

/// O que interessa de uma conta Google depois de confirmado o token.
export interface GoogleIdentity {
  /// Identificador estável da conta Google (não muda se o email mudar)
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/// IDs de cliente OAuth aceites (GOOGLE_CLIENT_IDS, separados por vírgulas).
export function googleClientIds(raw: string = env().GOOGLE_CLIENT_IDS): string[] {
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/// Confirma junto da Google que um "ID token" é verdadeiro, não expirou e
/// foi emitido para ESTA app (um dos GOOGLE_CLIENT_IDS). A app nunca manda o
/// email à confiança: manda o token e é o servidor que o confirma.
@Injectable()
export class GoogleVerifier {
  private readonly logger = new Logger(GoogleVerifier.name);
  private readonly client = new OAuth2Client();

  get enabled() {
    return googleClientIds().length > 0;
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    const audience = googleClientIds();
    if (!audience.length) throw ApiException.unavailable('GOOGLE_NOT_CONFIGURED');
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) throw new Error('token sem identificador ou sem email');
      return {
        sub: payload.sub,
        email: payload.email.trim().toLowerCase(),
        emailVerified: payload.email_verified === true,
        name: payload.name?.trim() || null,
        picture: payload.picture ?? null,
      };
    } catch (err) {
      // O motivo fica no log (ex.: "Wrong recipient" = o client ID da app não
      // está em GOOGLE_CLIENT_IDS); a app recebe só "não foi possível".
      // A biblioteca cola o token inteiro em algumas mensagens: não vai para o log.
      const reason = String((err as Error)?.message ?? err).split(idToken).join('<token>');
      this.logger.warn(`Token Google recusado: ${reason.slice(0, 300)}`);
      throw ApiException.unauthorized('GOOGLE_TOKEN_INVALID');
    }
  }
}
