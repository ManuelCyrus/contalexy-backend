import { Module } from '@nestjs/common';
import { SharingController } from './sharing.controller';
import { SharingService } from './sharing.service';
import { TransactionsModule } from '../transactions/transactions.module';
import { GoalsModule } from '../goals/goals.module';
import { MonthlyPlansModule } from '../monthly-plans/monthly-plans.module';
import { PlansModule } from '../plans/plans.module';
import { RecurringModule } from '../recurring/recurring.module';
import { DailyLimitModule } from '../daily-limit/daily-limit.module';

@Module({
  imports: [TransactionsModule, GoalsModule, MonthlyPlansModule, PlansModule, RecurringModule, DailyLimitModule],
  controllers: [SharingController],
  providers: [SharingService],
  exports: [SharingService],
})
export class SharingModule {}
