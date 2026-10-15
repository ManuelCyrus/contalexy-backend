import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';

@Module({ imports: [AiModule, TransactionsModule], controllers: [ImportController], providers: [ImportService], exports: [ImportService] })
export class ImportModule {}
