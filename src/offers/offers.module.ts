import { Module } from '@nestjs/common';
import { GoalsModule } from '../goals/goals.module';
import { PlansModule } from '../plans/plans.module';
import { ItemOffersController } from './item-offers.controller';
import { ItemOffersService } from './item-offers.service';

@Module({
  imports: [GoalsModule, PlansModule],
  controllers: [ItemOffersController],
  providers: [ItemOffersService],
  exports: [ItemOffersService],
})
export class OffersModule {}
