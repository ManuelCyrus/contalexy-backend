import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { ItemOffersService } from './item-offers.service';
import { AcceptItemDto, acceptItemSchema, SendItemDto, sendItemSchema } from './item-offers.dto';

/// Objetivos, planos e limites enviados entre pessoas ("usa este como modelo").
@Controller('offers')
export class ItemOffersController {
  constructor(private readonly offers: ItemOffersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.offers.list(user.userId);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  send(@CurrentUser() user: AuthUser, @Body(new ZodBody(sendItemSchema)) dto: SendItemDto) {
    return this.offers.send(user.userId, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.offers.get(user.userId, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(acceptItemSchema)) dto: AcceptItemDto) {
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
