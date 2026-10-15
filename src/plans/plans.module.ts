import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({ imports: [TransactionsModule], controllers: [PlansController], providers: [PlansService], exports: [PlansService] })
export class PlansModule {}
