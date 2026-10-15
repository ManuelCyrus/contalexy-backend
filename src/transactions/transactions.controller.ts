import { Throttle } from '@nestjs/throttler';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, StreamableFile } from '@nestjs/common';
import { z } from 'zod';
import { THROTTLE } from '../common/throttles';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { parseOrThrow, ZodBody } from '../common/pipes/zod-validation.pipe';
import { TransactionsService } from './transactions.service';
import { createTransactionSchema, CreateTransactionDto, filterSchema, savedFilterSchema, updateTransactionSchema, UpdateTransactionDto } from './transactions.dto';
import { dateOnly } from '../accounts/accounts.dto';
import { ApiException } from '../common/errors/api.exception';
import { Help } from '../sharing/help';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    return this.transactions.list(user.userId, parseOrThrow(filterSchema, query));
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    return this.transactions.summary(user.userId, parseOrThrow(filterSchema, query));
  }

  @Throttle(THROTTLE.heavy)
  @Get('export')
  async export(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    const file = await this.transactions.exportCsv(user.userId, parseOrThrow(filterSchema, query));
    return new StreamableFile(file.content, { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${file.filename}"` });
  }

  @Help('transactions')
  @Throttle(THROTTLE.search)
  @Get('suggest')
  suggest(@CurrentUser() user: AuthUser, @Query('description') description = '', @Query('type') type?: string) {
    return this.transactions.suggest(user.userId, description, type === 'INCOME' ? 'INCOME' : 'EXPENSE');
  }

  @Help('transactions')
  @Throttle(THROTTLE.search)
  @Get('descriptions')
  descriptions(@CurrentUser() user: AuthUser, @Query('q') q = '') {
    return this.transactions.descriptions(user.userId, q);
  }

  @Help('transactions')
  @Get('tags')
  tags(@CurrentUser() user: AuthUser) {
    return this.transactions.tags(user.userId);
  }

  @Get('saved-filters')
  savedFilters(@CurrentUser() user: AuthUser) {
    return this.transactions.savedFilters(user.userId);
  }

  @Post('saved-filters')
  saveFilter(@CurrentUser() user: AuthUser, @Body(new ZodBody(savedFilterSchema)) dto: z.infer<typeof savedFilterSchema>) {
    return this.transactions.saveFilter(user.userId, dto.name, dto.filters);
  }

  @Delete('saved-filters/:id')
  removeFilter(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.transactions.removeFilter(user.userId, id);
  }

  @Help('transactions', true)
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body(new ZodBody(createTransactionSchema)) dto: CreateTransactionDto) {
    await this.incomeGuard(user, undefined, dto.type);
    return this.transactions.create(user.userId, dto);
  }

  @Help('transactions')
  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.incomeGuard(user, id);
    return this.transactions.get(user.userId, id);
  }

  @Help('transactions', true)
  @Patch(':id')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updateTransactionSchema)) dto: UpdateTransactionDto) {
    await this.incomeGuard(user, id, dto.type);
    return this.transactions.update(user.userId, id, dto);
  }

  @Help('transactions', true)
  @Post(':id/duplicate')
  @HttpCode(200)
  async duplicate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: { date?: string }) {
    await this.incomeGuard(user, id);
    const date = body?.date ? parseOrThrow(dateOnly, body.date) : undefined;
    return this.transactions.duplicate(user.userId, id, date);
  }

  @Help('transactions', true)
  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.incomeGuard(user, id);
    return this.transactions.remove(user.userId, id);
  }

  /// Quem ajuda a gerir sem ver o que entra não mexe em receitas.
  private async incomeGuard(user: AuthUser, id?: string, type?: string) {
    if (!user.help || user.help.income) return;
    if (type === 'INCOME') throw ApiException.forbidden('SHARE_SECTION_HIDDEN');
    if (id && (await this.transactions.typeOf(user.userId, id)) === 'INCOME') throw ApiException.notFound('TRANSACTION_NOT_FOUND');
  }
}
