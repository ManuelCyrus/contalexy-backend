import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { AccountsService } from './accounts.service';
import { adjustBalanceSchema, createAccountSchema, CreateAccountDto, reorderSchema, updateAccountSchema, UpdateAccountDto } from './accounts.dto';
import { Help } from '../sharing/help';

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Help(['transactions', 'recurring', 'plans', 'goals'])
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('archived') archived?: string) {
    const result = await this.accounts.list(user.userId, archived === 'true');
    if (!user.help) return result;
    // Quem ajuda a gerir escolhe a conta, mas não vê saldos.
    return {
      accounts: result.accounts.map((a) => ({ ...a, balance: null, convertedBalance: null, initialBalance: null, availableCredit: null, creditLimit: null })),
      total: null,
      currency: result.currency,
      unconverted: [],
      balancesHidden: true,
    };
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBody(createAccountSchema)) dto: CreateAccountDto) {
    return this.accounts.create(user.userId, dto);
  }

  @Post('reorder')
  @HttpCode(200)
  reorder(@CurrentUser() user: AuthUser, @Body(new ZodBody(reorderSchema)) dto: z.infer<typeof reorderSchema>) {
    return this.accounts.reorder(user.userId, dto.ids);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.get(user.userId, id);
  }

  @Get(':id/history')
  history(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('months') months?: string) {
    return this.accounts.history(user.userId, id, Number(months) || 6);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updateAccountSchema)) dto: UpdateAccountDto) {
    return this.accounts.update(user.userId, id, dto);
  }

  @Post(':id/adjust')
  @HttpCode(200)
  adjust(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(adjustBalanceSchema)) dto: z.infer<typeof adjustBalanceSchema>) {
    return this.accounts.adjustBalance(user.userId, id, dto.balance, dto.date);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('force') force?: string) {
    return this.accounts.remove(user.userId, id, force === 'true');
  }
}
