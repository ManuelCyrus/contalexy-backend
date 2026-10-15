import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { TransactionsModule } from '../transactions/transactions.module';
import { RecurringModule } from '../recurring/recurring.module';
import { GoalsModule } from '../goals/goals.module';
import { PlansModule } from '../plans/plans.module';
import { LoansModule } from '../loans/loans.module';

@Module({
  imports: [TransactionsModule, RecurringModule, GoalsModule, PlansModule, LoansModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
