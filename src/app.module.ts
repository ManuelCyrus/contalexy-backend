import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { HelpActivityInterceptor, HelpGuard } from './sharing/help';
import { AreaGuard } from './billing/area.guard';
import { InfraModule } from './infra/infra.module';
import { RedisThrottlerStorage } from './infra/throttler.storage';
import { InstitutionsModule } from './institutions/institutions.module';
import { FeedbackModule } from './feedback/feedback.module';
import { InvestmentsModule } from './investments/investments.module';
import { ImportModule } from './import/import.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { HealthController } from './health/health.controller';
import { BillingModule } from './billing/billing.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ExchangeModule } from './exchange/exchange.module';
import { StorageModule } from './storage/storage.module';
import { MailModule } from './mail/mail.module';
import { GoogleModule } from './google/google.module';
import { MetaModule } from './meta/meta.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { AccountsModule } from './accounts/accounts.module';
import { CategoriesModule } from './categories/categories.module';
import { TransactionsModule } from './transactions/transactions.module';
import { RecurringModule } from './recurring/recurring.module';
import { BudgetsModule } from './budgets/budgets.module';
import { GoalsModule } from './goals/goals.module';
import { PlansModule } from './plans/plans.module';
import { SpacesModule } from './spaces/spaces.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { PromotionsModule } from './promotions/promotions.module';
import { AiModule } from './ai/ai.module';
import { PricesModule } from './prices/prices.module';
import { RulesModule } from './rules/rules.module';
import { LoansModule } from './loans/loans.module';
import { MonthlyPlansModule } from './monthly-plans/monthly-plans.module';
import { DailyLimitModule } from './daily-limit/daily-limit.module';
import { OffersModule } from './offers/offers.module';
import { SimulatorModule } from './simulator/simulator.module';
import { InsightsModule } from './insights/insights.module';
import { SharingModule } from './sharing/sharing.module';
import { AdminModule } from './admin/admin.module';
import { ChatModule } from './chat/chat.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // Limite geral: 240 pedidos por minuto por IP (as rotas sensíveis têm os seus). Contado no Redis quando há.
    ThrottlerModule.forRootAsync({
      imports: [InfraModule],
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({ throttlers: [{ ttl: 60_000, limit: 240 }], storage }),
    }),
    InfraModule,
    JwtModule.register({ global: true }),
    DatabaseModule,
    MailModule,
    GoogleModule,
    BillingModule,
    NotificationsModule,
    ExchangeModule,
    StorageModule,
    MetaModule,
    UsersModule,
    AuthModule,
    AccountsModule,
    CategoriesModule,
    RulesModule,
    MonthlyPlansModule,
    DailyLimitModule,
    TransactionsModule,
    RecurringModule,
    BudgetsModule,
    GoalsModule,
    PlansModule,
    SpacesModule,
    AnalyticsModule,
    PromotionsModule,
    AiModule,
    PricesModule,
    LoansModule,
    SimulatorModule,
    InsightsModule,
    SharingModule,
    OffersModule,
    AdminModule,
    ChatModule,
    InstitutionsModule,
    FeedbackModule,
    InvestmentsModule,
    ImportModule,
    WhatsappModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Depois da sessão: quem ajuda a gerir passa a agir na conta de quem partilha.
    { provide: APP_GUARD, useClass: HelpGuard },
    // As áreas que o código promocional da pessoa deixa fechadas.
    { provide: APP_GUARD, useClass: AreaGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    // Repetir um pedido com a mesma X-Idempotency-Key devolve a mesma resposta (a app sem rede).
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: HelpActivityInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
