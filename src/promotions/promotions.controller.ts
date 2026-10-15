import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { PromotionsService } from './promotions.service';

@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  /// GET /promotions/next?placement=DASHBOARD → uma promoção ou null.
  @Get('next')
  next(@CurrentUser() user: AuthUser, @Query('placement') placement = 'DASHBOARD', @Query('context') context?: string) {
    return this.promotions.next(user.userId, placement.toUpperCase(), context);
  }

  @Post(':key/seen')
  @HttpCode(200)
  seen(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.promotions.seen(user.userId, key);
  }

  @Post(':key/dismiss')
  @HttpCode(200)
  dismiss(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.promotions.dismiss(user.userId, key);
  }

  @Post(':key/click')
  @HttpCode(200)
  click(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.promotions.click(user.userId, key);
  }
}
