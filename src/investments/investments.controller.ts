import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { InvestmentsService } from './investments.service';
import { createInvestmentSchema, CreateInvestmentDto, dividendSchema, DividendDto, projectDividendsSchema, ProjectDividendsDto, updateInvestmentSchema, UpdateInvestmentDto } from './investments.dto';
import { dateOnly, positiveMoney, uuid } from '../accounts/accounts.dto';

const confirmSchema = z.object({ amount: positiveMoney.optional(), date: dateOnly.optional(), accountId: uuid.nullable().optional(), categoryId: uuid.nullable().optional() });

@Controller('investments')
export class InvestmentsController {
  constructor(private readonly investments: InvestmentsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.investments.list(user.userId);
  }

  /// Dividendos por mês (recebidos vs previstos). ?months=12
  @Get('dividends')
  dividends(@CurrentUser() user: AuthUser, @Query('months') months?: string) {
    const n = Number(months);
    return this.investments.dividendsByMonth(user.userId, Number.isInteger(n) && n > 0 ? Math.min(n, 60) : 12);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBody(createInvestmentSchema)) dto: CreateInvestmentDto) {
    return this.investments.create(user.userId, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.investments.get(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updateInvestmentSchema)) dto: UpdateInvestmentDto) {
    return this.investments.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.investments.remove(user.userId, id);
  }

  @Post(':id/dividends')
  addDividend(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(dividendSchema)) dto: DividendDto) {
    return this.investments.addDividend(user.userId, id, dto);
  }

  /// Projeção: X por mês/trimestre/ano durante N meses (substitui a anterior).
  @Post(':id/dividends/project')
  @HttpCode(200)
  project(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(projectDividendsSchema)) dto: ProjectDividendsDto) {
    return this.investments.project(user.userId, id, dto);
  }

  @Post(':id/dividends/:dividendId/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('dividendId', ParseUUIDPipe) dividendId: string, @Body(new ZodBody(confirmSchema)) dto: z.infer<typeof confirmSchema>) {
    return this.investments.confirmDividend(user.userId, id, dividendId, dto);
  }

  @Delete(':id/dividends/:dividendId')
  removeDividend(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('dividendId', ParseUUIDPipe) dividendId: string) {
    return this.investments.removeDividend(user.userId, id, dividendId);
  }
}
