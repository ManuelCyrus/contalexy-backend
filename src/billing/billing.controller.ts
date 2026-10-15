import { Body, Query, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../common/decorators/public.decorator';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { EntitlementsService } from './entitlements.service';
import { SubscriptionsService } from './subscriptions.service';
import { PromoService } from './promo.service';
import { CreditsService, creditProducts } from './credits.service';
import { paymentMethodsFor } from './payment-methods';
import { FEATURES } from './plans.catalog';
import { env, isTrue } from '../config/env';
import { ApiException } from '../common/errors/api.exception';

const redeemSchema = z.object({ code: z.string().trim().min(3).max(40) });

const devGrantSchema = z.object({
  plan: z.string().min(1),
  days: z.number().int().min(1).max(365).default(30),
});

@Controller('billing')
export class BillingController {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly promo: PromoService,
    private readonly credits: CreditsService,
  ) {}

  /// Os planos, benefícios e limites (para a página Premium). Os preços
  /// reais vêm da loja (RevenueCat) na app.
  @Public()
  @Get('plans')
  async plans() {
    const plans = await this.entitlements.listPlans();
    return {
      plans: plans.map((p) => ({
        code: p.code,
        rank: p.rank,
        features: p.features,
        limits: p.limits,
        entitlementId: p.entitlementId,
        /// Subscrições (renovam sozinhas) e compras de uma só vez ({ produto: dias; null = para sempre })
        productIds: p.productIds,
        oneTimeProducts: p.oneTimeProducts,
      })),
      allFeatures: Object.values(FEATURES),
    };
  }

  @Get('subscription')
  subscription(@CurrentUser() user: AuthUser) {
    return this.subscriptions.summary(user.userId);
  }

  /// Confirmar o plano junto da loja. Com limite: cada pedido é uma chamada
  /// ao RevenueCat (ninguém precisa de mais do que isto à mão).
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Post('sync')
  @HttpCode(200)
  sync(@CurrentUser() user: AuthUser) {
    return this.subscriptions.syncFromRevenueCat(user.userId);
  }

  /// Usar um código promocional (dá o plano sem pagamento). Poucas
  /// tentativas por minuto, para ninguém andar a adivinhar códigos.
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post('redeem')
  @HttpCode(200)
  redeem(@CurrentUser() user: AuthUser, @Body(new ZodBody(redeemSchema)) body: z.infer<typeof redeemSchema>) {
    return this.promo.redeem(user.userId, body.code);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('dev/grant')
  @HttpCode(200)
  devGrant(@CurrentUser() user: AuthUser, @Body(new ZodBody(devGrantSchema)) body: z.infer<typeof devGrantSchema>) {
    return this.subscriptions.devGrant(user.userId, body.plan, body.days);
  }

  /// Créditos de IA: saldo, pacotes à venda (compra única na loja) e histórico.
  @Get('credits')
  async creditsInfo(@CurrentUser() user: AuthUser) {
    return { credits: await this.credits.balance(user.userId), products: creditProducts(), history: await this.credits.history(user.userId) };
  }

  /// Só em desenvolvimento (BILLING_DEV_GRANTS=true): juntar créditos sem comprar.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('dev/credits')
  @HttpCode(200)
  async devCredits(@CurrentUser() user: AuthUser, @Body(new ZodBody(z.object({ credits: z.number().int().min(1).max(10_000) }))) body: { credits: number }) {
    if (env().NODE_ENV === 'production' || !isTrue(env().BILLING_DEV_GRANTS)) throw ApiException.forbidden();
    return this.credits.add(user.userId, body.credits, 'GRANT', { note: 'dev' });
  }

  /// Formas de pagamento que a loja do aparelho aceita no país da pessoa
  /// (informativo: quem cobra é sempre a App Store ou a Google Play).
  @Get('methods')
  async methods(@CurrentUser() user: AuthUser, @Query('country') country?: string, @Query('platform') platform?: string) {
    return paymentMethodsFor({ country: country ?? (await this.subscriptions.countryOf(user.userId)), platform });
  }

  /// Webhook do RevenueCat (configurar no painel com o mesmo
  /// "Authorization header" que REVENUECAT_WEBHOOK_AUTH).
  @Public()
  @Post('webhooks/revenuecat')
  @HttpCode(200)
  webhook(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    this.subscriptions.verifyWebhookAuth(authorization);
    return this.subscriptions.handleRevenueCatWebhook(body as { event?: never });
  }
}
