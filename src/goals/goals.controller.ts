import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { GoalsService } from './goals.service';
import { GoalDepositsService } from './goal-deposits.service';
import { LockableItems } from '../billing/lock.guard';
import {
  ConfirmDepositDto, confirmDepositSchema, ContributionDto, contributionSchema, createGoalSchema, CreateGoalDto, DepositDto, depositSchema,
  GoalStepDto, goalStepSchema, UpdateDepositDto, updateDepositSchema, updateGoalSchema, UpdateGoalDto, UpdateGoalStepDto, updateGoalStepSchema,
} from './goals.dto';
import { Help } from '../sharing/help';

@Controller('goals')
@LockableItems('goals')
export class GoalsController {
  constructor(
    private readonly goals: GoalsService,
    private readonly deposits: GoalDepositsService,
  ) {}

  /// Depósitos planeados que aí vêm, de todos os objetivos (antes de ':id').
  @Get('deposits/upcoming')
  upcomingDeposits(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    return this.deposits.upcoming(user.userId, Number(days) || 30);
  }

  @Help(['goals', 'plan'])
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('archived') archived?: string) {
    return this.goals.list(user.userId, archived === 'true', { teasers: true });
  }

  @Help('goals', true)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBody(createGoalSchema)) dto: CreateGoalDto) {
    return this.goals.create(user.userId, dto);
  }

  @Help('goals')
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.deposits.detail(user.userId, id);
  }

  @Help('goals', true)
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updateGoalSchema)) dto: UpdateGoalDto) {
    return this.goals.update(user.userId, id, dto);
  }

  @Help('goals', true)
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.goals.remove(user.userId, id);
  }

  // --- Objetivos específicos (as partes do caminho)

  @Help('goals', true)
  @Post(':id/steps')
  addStep(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(goalStepSchema)) dto: GoalStepDto) {
    return this.goals.addStep(user.userId, id, dto);
  }

  @Help('goals', true)
  @Patch(':id/steps/:stepId')
  updateStep(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body(new ZodBody(updateGoalStepSchema)) dto: UpdateGoalStepDto,
  ) {
    return this.goals.updateStep(user.userId, id, stepId, dto);
  }

  @Help('goals', true)
  @Delete(':id/steps/:stepId')
  removeStep(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('stepId', ParseUUIDPipe) stepId: string) {
    return this.goals.removeStep(user.userId, id, stepId);
  }

  @Post(':id/contributions')
  contribute(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(contributionSchema)) dto: ContributionDto) {
    return this.goals.contribute(user.userId, id, dto);
  }

  @Delete(':id/contributions/:contributionId')
  removeContribution(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('contributionId', ParseUUIDPipe) contributionId: string) {
    return this.goals.removeContribution(user.userId, id, contributionId);
  }

  // ---- Depósitos planeados ----

  @Post(':id/deposits')
  addDeposit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(depositSchema)) dto: DepositDto) {
    return this.deposits.create(user.userId, id, dto);
  }

  @Patch(':id/deposits/:depositId')
  updateDeposit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('depositId', ParseUUIDPipe) depositId: string,
    @Body(new ZodBody(updateDepositSchema)) dto: UpdateDepositDto,
  ) {
    return this.deposits.update(user.userId, id, depositId, dto);
  }

  @Delete(':id/deposits/:depositId')
  removeDeposit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('depositId', ParseUUIDPipe) depositId: string) {
    return this.deposits.remove(user.userId, id, depositId);
  }

  @Post(':id/deposits/:depositId/confirm')
  @HttpCode(200)
  confirmDeposit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('depositId', ParseUUIDPipe) depositId: string,
    @Body(new ZodBody(confirmDepositSchema)) dto: ConfirmDepositDto,
  ) {
    return this.deposits.confirm(user.userId, id, depositId, dto);
  }

  @Post(':id/deposits/:depositId/skip')
  @HttpCode(200)
  skipDeposit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('depositId', ParseUUIDPipe) depositId: string) {
    return this.deposits.skip(user.userId, id, depositId);
  }
}
