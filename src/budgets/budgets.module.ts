import { Global, Module } from '@nestjs/common';
import { BudgetsController } from './budgets.controller';
import { BudgetsService } from './budgets.service';

@Global()
@Module({ controllers: [BudgetsController], providers: [BudgetsService], exports: [BudgetsService] })
export class BudgetsModule {}
