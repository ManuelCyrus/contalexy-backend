import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { MonthlyPlansService } from './monthly-plans.service';
import { MonthlyPlanDto, MonthlyPlanLineFlagsDto, monthlyPlanLineFlagsSchema, monthlyPlanSchema } from './monthly-plans.dto';
import { Help } from '../sharing/help';

/// Plano mensal. `:key` é o mês financeiro "AAAA-MM" (ver GET /periods).
@Controller('monthly-plans')
export class MonthlyPlansController {
  constructor(private readonly plans: MonthlyPlansService) {}

  @Help('plan')
  @Get()
  history(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.plans.history(user.userId, limit ? Number(limit) || 12 : 12);
  }

  /// O plano do mês atual (ou uma sugestão, se ainda não houver).
  @Help('plan')
  @Get('current')
  current(@CurrentUser() user: AuthUser) {
    return this.plans.current(user.userId);
  }

  @Help('plan')
  @Get(':key')
  get(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.plans.get(user.userId, key);
  }

  @Help('plan', true)
  @Put(':key')
  save(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body(new ZodBody(monthlyPlanSchema)) dto: MonthlyPlanDto) {
    return this.plans.save(user.userId, key, dto);
  }

  @Help('plan', true)
  @Post(':key/copy-previous')
  @HttpCode(200)
  copyPrevious(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.plans.copyPrevious(user.userId, key);
  }

  /// Reutilizar um plano antigo: copia o plano do mês `source` para o mês `key`.
  @Help('plan', true)
  @Post(':key/copy-from/:source')
  @HttpCode(200)
  copyFrom(@CurrentUser() user: AuthUser, @Param('key') key: string, @Param('source') source: string) {
    return this.plans.copyFrom(user.userId, key, source);
  }

  /// Escolher se uma linha tem "o que vou comprar" (numa mensalidade não faz sentido).
  @Help('plan', true)
  @Patch(':key/lines/:lineId')
  lineFlags(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body(new ZodBody(monthlyPlanLineFlagsSchema)) dto: MonthlyPlanLineFlagsDto,
  ) {
    return this.plans.setLineFlags(user.userId, key, lineId, dto);
  }

  @Help('plan', true)
  @Delete(':key')
  remove(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.plans.remove(user.userId, key);
  }
}
