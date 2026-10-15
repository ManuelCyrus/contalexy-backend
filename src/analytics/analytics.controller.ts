import { Controller, Get, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { parseOrThrow } from '../common/pipes/zod-validation.pipe';
import { dateOnly } from '../accounts/accounts.dto';
import { AnalyticsService } from './analytics.service';

const optDate = (value?: string) => (value ? parseOrThrow(dateOnly, value) : undefined);

@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('dashboard')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.analytics.dashboard(user.userId);
  }

  @Get('periods')
  periods(@CurrentUser() user: AuthUser) {
    return this.analytics.periods(user.userId);
  }

  @Get('reports/overview')
  overview(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.overview(user.userId, optDate(from), optDate(to));
  }

  @Get('reports/trend')
  trend(@CurrentUser() user: AuthUser, @Query('months') months?: string) {
    return this.analytics.trend(user.userId, Number(months) || 6);
  }

  @Get('reports/net-worth')
  netWorth(@CurrentUser() user: AuthUser, @Query('months') months?: string) {
    return this.analytics.netWorth(user.userId, Number(months) || 12);
  }

  @Get('reports/merchants')
  merchants(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.merchants(user.userId, optDate(from), optDate(to));
  }

  @Get('reports/tags')
  tags(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.tags(user.userId, optDate(from), optDate(to));
  }

  @Get('calendar')
  calendar(@CurrentUser() user: AuthUser, @Query('month') month?: string) {
    return this.analytics.calendar(user.userId, month);
  }
}
