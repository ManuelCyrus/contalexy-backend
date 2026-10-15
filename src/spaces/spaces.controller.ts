import { Throttle } from '@nestjs/throttler';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { THROTTLE } from '../common/throttles';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { SpacesService } from './spaces.service';
import { SpaceExpensesService } from './space-expenses.service';
import { SpaceFundService } from './space-fund.service';
import {
  createSpaceSchema, CreateSpaceDto, DepositDto, depositSchema, expenseSchema, ExpenseDto, InviteDto, inviteSchema, joinSchema, roleSchema,
  settlementSchema, SettlementDto, SpaceGoalDto, spaceGoalSchema, SpacePlanDto, spacePlanSchema, updateExpenseSchema, UpdateExpenseDto,
  UpdateSpaceDto, UpdateSpaceGoalDto, updateSpaceGoalSchema, updateSpaceSchema, WithdrawDto, withdrawSchema,
} from './spaces.dto';

/// Lembrar alguém que me deve num Space.
const spaceRemindSchema = z.object({ userId: z.string().uuid() });

@Controller('spaces')
export class SpacesController {
  constructor(
    private readonly spaces: SpacesService,
    private readonly expenses: SpaceExpensesService,
    private readonly funds: SpaceFundService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.spaces.list(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBody(createSpaceSchema)) dto: CreateSpaceDto) {
    return this.spaces.create(user.userId, dto);
  }

  @Throttle(THROTTLE.strict)
  @Post('join')
  @HttpCode(200)
  join(@CurrentUser() user: AuthUser, @Body(new ZodBody(joinSchema)) dto: z.infer<typeof joinSchema>) {
    return this.spaces.joinByCode(user.userId, dto.code);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.spaces.get(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updateSpaceSchema)) dto: UpdateSpaceDto) {
    return this.spaces.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.spaces.remove(user.userId, id);
  }

  @Post(':id/leave')
  @HttpCode(200)
  leave(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.spaces.leave(user.userId, id);
  }

  @Post(':id/invite-code')
  @HttpCode(200)
  regenerateCode(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.spaces.regenerateCode(user.userId, id);
  }

  @Throttle(THROTTLE.social)
  @Post(':id/invitations')
  invite(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(inviteSchema)) dto: InviteDto) {
    return this.spaces.invite(user.userId, id, dto);
  }

  @Delete(':id/invitations/:invitationId')
  cancelInvitation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('invitationId', ParseUUIDPipe) invitationId: string) {
    return this.spaces.cancelInvitation(user.userId, id, invitationId);
  }

  @Delete(':id/members/:userId')
  removeMember(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) memberId: string) {
    return this.spaces.removeMember(user.userId, id, memberId);
  }

  @Patch(':id/members/:userId')
  setRole(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) memberId: string,
    @Body(new ZodBody(roleSchema)) dto: z.infer<typeof roleSchema>,
  ) {
    return this.spaces.setRole(user.userId, id, memberId, dto.role);
  }

  // ----- Despesas -----

  @Get(':id/expenses')
  expensesList(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.expenses.list(user.userId, id, Number(limit) || 30, Number(offset) || 0);
  }

  @Post(':id/expenses')
  createExpense(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(expenseSchema)) dto: ExpenseDto) {
    return this.expenses.create(user.userId, id, dto);
  }

  @Get(':id/expenses/:expenseId')
  getExpense(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('expenseId', ParseUUIDPipe) expenseId: string) {
    return this.expenses.get(user.userId, id, expenseId);
  }

  @Patch(':id/expenses/:expenseId')
  updateExpense(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('expenseId', ParseUUIDPipe) expenseId: string,
    @Body(new ZodBody(updateExpenseSchema)) dto: UpdateExpenseDto,
  ) {
    return this.expenses.update(user.userId, id, expenseId, dto);
  }

  @Delete(':id/expenses/:expenseId')
  removeExpense(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('expenseId', ParseUUIDPipe) expenseId: string) {
    return this.expenses.remove(user.userId, id, expenseId);
  }

  // ----- Saldos e acertos -----

  @Get(':id/balances')
  balances(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.balances(user.userId, id);
  }

  /// Lembrar quem me deve neste Space (um por dia a cada pessoa)
  @Throttle(THROTTLE.social)
  @Post(':id/balances/remind')
  @HttpCode(200)
  remind(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(spaceRemindSchema)) dto: z.infer<typeof spaceRemindSchema>) {
    return this.expenses.remind(user.userId, id, dto.userId);
  }

  @Post(':id/settlements')
  settle(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(settlementSchema)) dto: SettlementDto) {
    return this.expenses.settle(user.userId, id, dto);
  }

  @Delete(':id/settlements/:settlementId')
  removeSettlement(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('settlementId', ParseUUIDPipe) settlementId: string) {
    return this.expenses.removeSettlement(user.userId, id, settlementId);
  }

  @Get(':id/activity')
  activity(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string) {
    return this.expenses.activity(user.userId, id, Number(limit) || 40);
  }

  // ----- Plano em grupo: fundo comum, metas e plano de gastos -----

  @Get(':id/fund')
  fund(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.funds.fund(user.userId, id);
  }

  @Get(':id/deposits')
  deposits(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.funds.deposits(user.userId, id, Number(limit) || 30, Number(offset) || 0);
  }

  @Post(':id/deposits')
  deposit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(depositSchema)) dto: DepositDto) {
    return this.funds.deposit(user.userId, id, dto);
  }

  @Post(':id/withdrawals')
  withdraw(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(withdrawSchema)) dto: WithdrawDto) {
    return this.funds.withdraw(user.userId, id, dto);
  }

  @Delete(':id/deposits/:depositId')
  removeDeposit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('depositId', ParseUUIDPipe) depositId: string) {
    return this.funds.removeDeposit(user.userId, id, depositId);
  }

  @Post(':id/goals')
  createGoal(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(spaceGoalSchema)) dto: SpaceGoalDto) {
    return this.funds.createGoal(user.userId, id, dto);
  }

  @Patch(':id/goals/:goalId')
  updateGoal(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('goalId', ParseUUIDPipe) goalId: string,
    @Body(new ZodBody(updateSpaceGoalSchema)) dto: UpdateSpaceGoalDto,
  ) {
    return this.funds.updateGoal(user.userId, id, goalId, dto);
  }

  @Delete(':id/goals/:goalId')
  removeGoal(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('goalId', ParseUUIDPipe) goalId: string) {
    return this.funds.removeGoal(user.userId, id, goalId);
  }

  @Get(':id/plan')
  plan(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('month') month?: string) {
    return this.funds.plan(user.userId, id, month);
  }

  @Put(':id/plan')
  savePlan(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(spacePlanSchema)) dto: SpacePlanDto, @Query('month') month?: string) {
    return this.funds.savePlan(user.userId, id, dto, month);
  }
}

@Controller('space-invitations')
export class SpaceInvitationsController {
  constructor(private readonly spaces: SpacesService) {}

  @Get()
  received(@CurrentUser() user: AuthUser) {
    return this.spaces.receivedInvitations(user.userId);
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.spaces.accept(user.userId, id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.spaces.decline(user.userId, id);
  }
}
