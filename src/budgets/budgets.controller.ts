import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { parseOrThrow, ZodBody } from '../common/pipes/zod-validation.pipe';
import { BudgetsService } from './budgets.service';
import { LockableItems } from '../billing/lock.guard';
import { createBudgetSchema, CreateBudgetDto, updateBudgetSchema, UpdateBudgetDto } from './budgets.dto';
import { dateOnly } from '../accounts/accounts.dto';
import { Help } from '../sharing/help';

@Controller('budgets')
@LockableItems('budgets')
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Help('budgets')
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('date') date?: string) {
    return this.budgets.list(user.userId, date ? parseOrThrow(dateOnly, date) : undefined, { teasers: true });
  }

  @Help('budgets', true)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBody(createBudgetSchema)) dto: CreateBudgetDto) {
    return this.budgets.create(user.userId, dto);
  }

  @Help('budgets')
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('date') date?: string) {
    return this.budgets.get(user.userId, id, date ? parseOrThrow(dateOnly, date) : undefined);
  }

  @Help('budgets')
  @Get(':id/history')
  history(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('periods') periods?: string) {
    return this.budgets.history(user.userId, id, Number(periods) || 6);
  }

  @Help('budgets', true)
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updateBudgetSchema)) dto: UpdateBudgetDto) {
    return this.budgets.update(user.userId, id, dto);
  }

  @Help('budgets', true)
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.remove(user.userId, id);
  }
}
