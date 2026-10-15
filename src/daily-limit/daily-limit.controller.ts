import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { DailyLimitService } from './daily-limit.service';
import { Help } from '../sharing/help';

const dailyLimitSchema = z.object({
  /// null = tirar o limite (no "só hoje": volta a valer o de todos os dias)
  amount: z.number().finite().min(0).max(1e12).nullable(),
  /// true = este valor vale só para hoje
  onlyToday: z.boolean().optional(),
});

/// Limite de gastos por dia ("hoje podes gastar X, faltam Y").
@Controller('daily-limit')
export class DailyLimitController {
  constructor(private readonly daily: DailyLimitService) {}

  /// ?week=true junta os últimos 7 dias · ?suggest=true junta a sugestão do plano do mês
  @Help('budgets')
  @Get()
  get(@CurrentUser() user: AuthUser, @Query('week') week?: string, @Query('suggest') suggest?: string) {
    return this.daily.get(user.userId, { week: week === 'true', suggest: suggest === 'true' });
  }

  @Help('budgets', true)
  @Put()
  set(@CurrentUser() user: AuthUser, @Body(new ZodBody(dailyLimitSchema)) dto: z.infer<typeof dailyLimitSchema>) {
    return this.daily.set(user.userId, dto);
  }
}
