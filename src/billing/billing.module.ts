import { Global, Module } from '@nestjs/common';
import { QuotaService } from './quota.service';
import { CreditsService } from './credits.service';
import { EntitlementsService } from './entitlements.service';
import { SubscriptionsService } from './subscriptions.service';
import { PromoService } from './promo.service';
import { BillingController } from './billing.controller';
import { LocksService } from './locks.service';
import { LockGuard } from './lock.guard';

@Global()
@Module({
  controllers: [BillingController],
  providers: [EntitlementsService, SubscriptionsService, PromoService, LocksService, LockGuard, QuotaService, CreditsService],
  exports: [EntitlementsService, SubscriptionsService, PromoService, LocksService, LockGuard, QuotaService, CreditsService],
})
export class BillingModule {}
