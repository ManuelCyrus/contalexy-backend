import { Global, Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { BalancesService } from './balances.service';

@Global()
@Module({
  controllers: [AccountsController],
  providers: [AccountsService, BalancesService],
  exports: [AccountsService, BalancesService],
})
export class AccountsModule {}
