import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { PlansService } from './plans.service';
import { LockableItems } from '../billing/lock.guard';
import { checkoutSchema, CheckoutDto, createPlanSchema, CreatePlanDto, duplicatePlanSchema, DuplicatePlanDto, payItemSchema, PayItemDto, planItemSchema, PlanItemDto, updatePlanItemSchema, UpdatePlanItemDto, updatePlanSchema, UpdatePlanDto, PLAN_TYPES } from './plans.dto';
import { Help } from '../sharing/help';

@Controller('plans')
@LockableItems('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Help('plans')
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Query('period') period?: string, @Query('type') type?: string) {
    return this.plans.list(user.userId, status, period && /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? period : undefined, { teasers: true, type: type && (PLAN_TYPES as readonly string[]).includes(type) ? type : undefined });
  }

  @Help('plans', true)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBody(createPlanSchema)) dto: CreatePlanDto) {
    return this.plans.create(user.userId, dto);
  }

  @Help('plans')
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.plans.get(user.userId, id);
  }

  @Help('plans', true)
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updatePlanSchema)) dto: UpdatePlanDto) {
    return this.plans.update(user.userId, id, dto);
  }

  @Help('plans', true)
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.plans.remove(user.userId, id);
  }

  @Help('plans', true)
  @Post(':id/duplicate')
  @HttpCode(200)
  duplicate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(duplicatePlanSchema)) dto: DuplicatePlanDto) {
    return this.plans.duplicate(user.userId, id, dto.periodKey);
  }

  /// "Fiz as compras": valores reais dos itens + uma despesa com o total.
  @Help('plans', true)
  @Post(':id/checkout')
  @HttpCode(200)
  checkout(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(checkoutSchema)) dto: CheckoutDto) {
    return this.plans.checkout(user.userId, id, dto);
  }

  @Help('plans', true)
  @Post(':id/items')
  addItem(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(planItemSchema)) dto: PlanItemDto) {
    return this.plans.addItem(user.userId, id, dto);
  }

  @Help('plans', true)
  @Patch(':id/items/:itemId')
  updateItem(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body(new ZodBody(updatePlanItemSchema)) dto: UpdatePlanItemDto) {
    return this.plans.updateItem(user.userId, id, itemId, dto);
  }

  @Help('plans', true)
  @Delete(':id/items/:itemId')
  removeItem(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.plans.removeItem(user.userId, id, itemId);
  }

  @Help('plans', true)
  @Post(':id/items/:itemId/pay')
  @HttpCode(200)
  payItem(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body(new ZodBody(payItemSchema)) dto: PayItemDto) {
    return this.plans.payItem(user.userId, id, itemId, dto);
  }
}
