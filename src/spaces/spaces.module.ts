import { Module } from '@nestjs/common';
import { SpacesController, SpaceInvitationsController } from './spaces.controller';
import { SpacesService } from './spaces.service';
import { SpaceExpensesService } from './space-expenses.service';
import { SpaceFundService } from './space-fund.service';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [TransactionsModule],
  controllers: [SpacesController, SpaceInvitationsController],
  providers: [SpacesService, SpaceExpensesService, SpaceFundService],
  exports: [SpacesService],
})
export class SpacesModule {}
