import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { PendingService } from './pending.service';
import { PendingController, WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

@Module({ imports: [AiModule, TransactionsModule], controllers: [WhatsappController, PendingController], providers: [WhatsappService, PendingService], exports: [PendingService] })
export class WhatsappModule {}
