import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { CreatePriceDto, createPriceSchema, PricesService } from './prices.service';

@Controller('prices')
export class PricesController {
  constructor(private readonly prices: PricesService) {}

  @Get()
  products(@CurrentUser() user: AuthUser, @Query('q') q?: string) {
    return this.prices.products(user.userId, q);
  }

  /// Sem o plano: só quantos produtos estão guardados e o nome de alguns.
  @Get('teaser')
  teaser(@CurrentUser() user: AuthUser) {
    return this.prices.teaser(user.userId);
  }

  @Get('history')
  history(@CurrentUser() user: AuthUser, @Query('name') name = '') {
    return this.prices.history(user.userId, name);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBody(createPriceSchema)) dto: CreatePriceDto) {
    return this.prices.create(user.userId, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.prices.remove(user.userId, id);
  }
}
