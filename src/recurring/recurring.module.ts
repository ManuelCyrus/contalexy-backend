import { Module } from '@nestjs/common';
import { RecurringController } from './recurring.controller';
import { RecurringService } from './recurring.service';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [TransactionsModule],
  controllers: [RecurringController],
  providers: [RecurringService],
  exports: [RecurringService],
})
export class RecurringModule {}
