import { Module } from '@nestjs/common';
import { TransactionsModule } from '../transactions/transactions.module';
import { InvestmentsController } from './investments.controller';
import { InvestmentsService } from './investments.service';

@Module({ imports: [TransactionsModule], controllers: [InvestmentsController], providers: [InvestmentsService] })
export class InvestmentsModule {}
