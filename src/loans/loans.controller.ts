import { Throttle } from '@nestjs/throttler';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { THROTTLE } from '../common/throttles';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { LoansService } from './loans.service';
import { acceptLoanSchema, AcceptLoanDto, createLoanSchema, CreateLoanDto, linkLoanSchema, LinkLoanDto, loanPaymentSchema, LoanPaymentDto, updateLoanSchema, UpdateLoanDto, loanNudgeSchema, LoanNudgeDto } from './loans.dto';

@Controller('loans')
export class LoansController {
  constructor(private readonly loans: LoansService) {}

  /// ?status=open (por omissão) | closed | all
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.loans.list(user.userId, status === 'closed' || status === 'all' ? status : 'open');
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBody(createLoanSchema)) dto: CreateLoanDto) {
    return this.loans.create(user.userId, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.loans.get(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updateLoanSchema)) dto: UpdateLoanDto) {
    return this.loans.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('deleteTransactions') deleteTransactions?: string) {
    return this.loans.remove(user.userId, id, deleteTransactions === 'true');
  }

  /// Ligar à conta da outra pessoa (ela recebe o pedido) · desfazer a ligação
  @Throttle(THROTTLE.social)
  @Post(':id/link')
  @HttpCode(200)
  link(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(linkLoanSchema)) dto: LinkLoanDto) {
    return this.loans.link(user.userId, id, dto);
  }

  @Delete(':id/link')
  unlink(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.loans.unlink(user.userId, id);
  }

  /// A outra pessoa responde ao pedido
  @Post(':id/accept')
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(acceptLoanSchema)) dto: AcceptLoanDto) {
    return this.loans.accept(user.userId, id, dto);
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.loans.decline(user.userId, id);
  }

  @Post(':id/payments')
  @HttpCode(200)
  addPayment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(loanPaymentSchema)) dto: LoanPaymentDto) {
    return this.loans.addPayment(user.userId, id, dto);
  }

  /// Lembrete à outra pessoa (empréstimo ligado), no máximo um por dia
  @Throttle(THROTTLE.social)
  @Post(':id/nudge')
  @HttpCode(200)
  nudge(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(loanNudgeSchema)) dto: LoanNudgeDto) {
    return this.loans.nudge(user.userId, id, dto);
  }

  @Delete(':id/payments/:paymentId')
  removePayment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('paymentId', ParseUUIDPipe) paymentId: string) {
    return this.loans.removePayment(user.userId, id, paymentId);
  }
}
