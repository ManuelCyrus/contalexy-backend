import { Module } from '@nestjs/common';
import { SimulatorController } from './simulator.controller';
import { SimulatorService } from './simulator.service';
import { RecurringModule } from '../recurring/recurring.module';
import { GoalsModule } from '../goals/goals.module';
import { LoansModule } from '../loans/loans.module';
import { MonthlyPlansModule } from '../monthly-plans/monthly-plans.module';

@Module({
  imports: [RecurringModule, GoalsModule, LoansModule, MonthlyPlansModule],
  controllers: [SimulatorController],
  providers: [SimulatorService],
  exports: [SimulatorService],
})
export class SimulatorModule {}
