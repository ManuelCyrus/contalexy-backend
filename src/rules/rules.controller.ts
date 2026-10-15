import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { RuleDto, ruleSchema, RulesService, updateRuleSchema } from './rules.service';
import { LockableItems } from '../billing/lock.guard';

@Controller('rules')
@LockableItems('rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.rules.list(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBody(ruleSchema)) dto: RuleDto) {
    return this.rules.create(user.userId, dto);
  }

  @Post('apply')
  @HttpCode(200)
  apply(@CurrentUser() user: AuthUser) {
    return this.rules.applyToPast(user.userId);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updateRuleSchema)) dto: Partial<RuleDto>) {
    return this.rules.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.rules.remove(user.userId, id);
  }
}
