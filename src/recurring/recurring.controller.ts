import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { RecurringService } from './recurring.service';
import { LockableItems } from '../billing/lock.guard';
import { createRecurringSchema, CreateRecurringDto, payRecurringSchema, updateRecurringSchema, UpdateRecurringDto } from './recurring.dto';
import { Help } from '../sharing/help';

@Controller('recurring')
@LockableItems('recurring')
export class RecurringController {
  constructor(private readonly recurring: RecurringService) {}

  @Help('recurring')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.recurring.list(user.userId, { teasers: true });
  }

  @Help('recurring')
  @Get('upcoming')
  upcoming(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    return this.recurring.upcoming(user.userId, Number(days) || 30);
  }

  @Help('recurring', true)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBody(createRecurringSchema)) dto: CreateRecurringDto) {
    return this.recurring.create(user.userId, dto);
  }

  @Help('recurring', true)
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updateRecurringSchema)) dto: UpdateRecurringDto) {
    return this.recurring.update(user.userId, id, dto);
  }

  @Help('recurring', true)
  @Post(':id/pay')
  @HttpCode(200)
  pay(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(payRecurringSchema)) dto: z.infer<typeof payRecurringSchema>) {
    return this.recurring.pay(user.userId, id, dto);
  }

  @Help('recurring', true)
  @Post(':id/skip')
  @HttpCode(200)
  skip(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.recurring.skip(user.userId, id);
  }

  @Help('recurring', true)
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.recurring.remove(user.userId, id);
  }
}
