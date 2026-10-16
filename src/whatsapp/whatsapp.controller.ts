import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { THROTTLE } from '../common/throttles';
import { confirmPendingSchema, ConfirmPendingDto, PendingService } from './pending.service';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsappController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly pending: PendingService,
  ) {}

  /// Estado da ligação (número, código por mandar, por confirmar).
  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.whatsapp.status(user.userId);
  }

  /// Gerar o código para mandar por WhatsApp (vale 15 minutos).
  @Throttle(THROTTLE.strict)
  @Post('link')
  @HttpCode(200)
  link(@CurrentUser() user: AuthUser) {
    return this.whatsapp.startLink(user.userId);
  }

  @Delete('link')
  unlink(@CurrentUser() user: AuthUser) {
    return this.whatsapp.unlink(user.userId);
  }

  /// Confirmação do endereço pela Meta.
  @Public()
  @Get('webhook')
  /// A Meta espera o hub.challenge em texto simples (sem o envelope { success, data }).
  verify(@Res() res: Response, @Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string) {
    res.status(200).type('text/plain').send(this.whatsapp.verify(mode, token, challenge));
  }

  /// Mensagens recebidas (assinadas com o App Secret).
  @Public()
  @Post('webhook')
  @HttpCode(200)
  webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-hub-signature-256') signature?: string, @Body() body?: unknown) {
    this.whatsapp.verifySignature(req.rawBody, signature);
    return this.whatsapp.handleWebhook(body);
  }
}

/// Movimentos por confirmar (do WhatsApp).
@Controller('pending-transactions')
export class PendingController {
  constructor(private readonly pending: PendingService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.pending.list(user.userId);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(confirmPendingSchema)) dto: ConfirmPendingDto) {
    return this.pending.confirm(user.userId, id, dto);
  }

  @Post(':id/discard')
  @HttpCode(200)
  discard(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pending.discard(user.userId, id);
  }
}
