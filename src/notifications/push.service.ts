import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { App, cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { PrismaService } from '../database/prisma.service';
import { env } from '../config/env';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/// Notificações push pelo Firebase (FCM). Sem FIREBASE_SERVICE_ACCOUNT_JSON
/// fica desligado (as notificações continuam a aparecer dentro da app).
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private app: App | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const raw = env().FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      this.logger.log('Push desligado (sem FIREBASE_SERVICE_ACCOUNT_JSON).');
      return;
    }
    try {
      this.app = initializeApp({ credential: cert(JSON.parse(raw)) }, 'rumo-push');
      this.logger.log('Push ligado (Firebase).');
    } catch (err) {
      this.logger.error(`Firebase inválido: ${(err as Error).message}`);
    }
  }

  get enabled() {
    return this.app !== null;
  }

  async sendToUser(userId: string, message: PushMessage): Promise<number> {
    if (!this.app) return 0;
    const tokens = await this.prisma.pushToken.findMany({ where: { userId }, select: { token: true } });
    if (!tokens.length) return 0;
    try {
      const result = await getMessaging(this.app).sendEachForMulticast({
        tokens: tokens.map((t) => t.token),
        notification: { title: message.title, body: message.body },
        data: message.data ?? {},
        android: { priority: 'high', notification: { channelId: 'rumo_default' } },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      // Tokens que já não existem (app desinstalada, etc.) saem da lista.
      const dead: string[] = [];
      result.responses.forEach((r, i) => {
        const code = r.error?.code ?? '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token') || code.includes('invalid-argument')) {
          dead.push(tokens[i].token);
        }
      });
      if (dead.length) await this.prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
      return result.successCount;
    } catch (err) {
      this.logger.warn(`Falhou o push: ${(err as Error).message}`);
      return 0;
    }
  }
}
