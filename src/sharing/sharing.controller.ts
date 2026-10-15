import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody, ZodQuery } from '../common/pipes/zod-validation.pipe';
import { SharingService } from './sharing.service';
import { SharedTransactionsQuery, sharedTransactionsSchema, ShareInviteDto, shareInviteSchema, shareNoteSchema, ShareUpdateDto, shareUpdateSchema } from './sharing.dto';
import { PlanOffersService } from '../monthly-plans/plan-offers.service';
import { proposePlanSchema, ProposePlanDto } from '../monthly-plans/plan-offers.dto';

/// Acompanhamento: convidar alguém para ver os meus gastos do mês.
@Controller('sharing')
export class SharingController {
  constructor(
    private readonly sharing: SharingService,
    private readonly offers: PlanOffersService,
  ) {}

  /// Quem vê os meus gastos (`given`) e de quem eu vejo (`received`).
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.sharing.list(user.userId);
  }

  /// Poucos convites por minuto (não serve para andar a experimentar emails).
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('invitations')
  invite(@CurrentUser() user: AuthUser, @Body(new ZodBody(shareInviteSchema)) dto: ShareInviteDto) {
    return this.sharing.invite(user.userId, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(shareUpdateSchema)) dto: ShareUpdateDto) {
    return this.sharing.update(user.userId, id, dto);
  }

  /// Deixar de partilhar (quem partilha) ou de acompanhar (quem vê).
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sharing.remove(user.userId, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sharing.accept(user.userId, id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sharing.decline(user.userId, id);
  }

  /// ?month=AAAA-MM (por omissão, o mês atual)
  @Get(':id/overview')
  overview(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('month') month?: string) {
    return this.sharing.overview(user.userId, id, month);
  }

  /// Os planos do mês passados (e o atual): planeado vs. gasto em cada mês.
  @Get(':id/history')
  history(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string) {
    return this.sharing.history(user.userId, id, limit ? Number(limit) || 12 : 12);
  }

  /// Filtros: month | from/to, categoryId, type, q, minAmount, maxAmount, limit, offset
  @Get(':id/transactions')
  transactions(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodQuery(sharedTransactionsSchema)) query: SharedTransactionsQuery) {
    return this.sharing.transactionsOf(user.userId, id, query);
  }

  /// Quem acompanha propõe um plano do mês a quem partilha os gastos.
  @Post(':id/plan-proposal')
  proposePlan(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(proposePlanSchema)) dto: ProposePlanDto) {
    return this.offers.propose(user.userId, id, dto);
  }

  /// O que quem ajuda a gerir mudou (quem partilha vê tudo; quem ajuda vê o que fez)
  @Get(':id/activity')
  activity(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sharing.activity(user.userId, id);
  }

  @Get(':id/notes')
  notes(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sharing.notes(user.userId, id);
  }

  @Post(':id/notes')
  addNote(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(shareNoteSchema)) dto: z.infer<typeof shareNoteSchema>) {
    return this.sharing.addNote(user.userId, id, dto.text);
  }

  @Delete(':id/notes/:noteId')
  removeNote(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('noteId', ParseUUIDPipe) noteId: string) {
    return this.sharing.removeNote(user.userId, id, noteId);
  }
}
