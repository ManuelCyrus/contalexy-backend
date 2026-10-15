import { Throttle } from '@nestjs/throttler';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { THROTTLE } from '../common/throttles';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { PlanOffersService } from './plan-offers.service';
import { acceptPlanOfferSchema, AcceptPlanOfferDto, sendPlanSchema, SendPlanDto } from './plan-offers.dto';

/// Planos do mês enviados entre pessoas ("usa o meu plano" / "proponho-te este plano").
@Controller('plan-offers')
export class PlanOffersController {
  constructor(private readonly offers: PlanOffersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.offers.list(user.userId);
  }

  /// Enviar o meu plano de um mês a outra pessoa.
  @Throttle(THROTTLE.social)
  @Post()
  send(@CurrentUser() user: AuthUser, @Body(new ZodBody(sendPlanSchema)) dto: SendPlanDto) {
    return this.offers.send(user.userId, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.offers.get(user.userId, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(acceptPlanOfferSchema)) dto: AcceptPlanOfferDto) {
    return this.offers.accept(user.userId, id, dto);
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.offers.decline(user.userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.offers.remove(user.userId, id);
  }
}
