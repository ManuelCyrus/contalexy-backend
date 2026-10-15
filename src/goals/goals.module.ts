import { Module } from '@nestjs/common';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';
import { GoalDepositsService } from './goal-deposits.service';

@Module({ controllers: [GoalsController], providers: [GoalsService, GoalDepositsService], exports: [GoalsService, GoalDepositsService] })
export class GoalsModule {}
