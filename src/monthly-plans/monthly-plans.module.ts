import { Global, Module } from '@nestjs/common';
import { MonthlyPlansController } from './monthly-plans.controller';
import { MonthlyPlansService } from './monthly-plans.service';
import { PlanOffersController } from './plan-offers.controller';
import { PlanOffersService } from './plan-offers.service';

/// Global: os movimentos avisam o plano do mês depois de cada despesa.
@Global()
@Module({
  controllers: [MonthlyPlansController, PlanOffersController],
  providers: [MonthlyPlansService, PlanOffersService],
  exports: [MonthlyPlansService, PlanOffersService],
})
export class MonthlyPlansModule {}
