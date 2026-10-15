import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';

/// Envio de emails pelo Resend (API simples). Sem RESEND_API_KEY, o
/// email aparece no log (útil em desenvolvimento).
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  async send(to: string, subject: string, text: string): Promise<boolean> {
    const key = env().RESEND_API_KEY;
    if (!key) {
      this.logger.log(`[email simulado] Para ${to}: ${subject}\n${text}`);
      return true;
    }
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env().MAIL_FROM, to: [to], subject, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return true;
    } catch (err) {
      this.logger.error(`Falhou o email para ${to}: ${(err as Error).message}`);
      return false;
    }
  }
}
