import { Throttle } from '@nestjs/throttler';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { THROTTLE } from '../common/throttles';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { UsersService } from './users.service';
import { changePasswordSchema, deleteAccountSchema, pushTokenSchema, updateMeSchema, UpdateMeDto } from './users.dto';
import { UploadedFileLike } from '../storage/storage.service';
import { env } from '../config/env';

@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    this.users.touch(user.userId);
    return this.users.me(user.userId);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body(new ZodBody(updateMeSchema)) dto: UpdateMeDto) {
    return this.users.update(user.userId, dto);
  }

  @Post('onboarding')
  @HttpCode(200)
  onboarding(@CurrentUser() user: AuthUser) {
    return this.users.completeOnboarding(user.userId);
  }

  @Throttle(THROTTLE.uploads)
  @Post('avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: env().MAX_UPLOAD_MB * 1024 * 1024 } }))
  avatar(@CurrentUser() user: AuthUser, @UploadedFile() file: UploadedFileLike) {
    return this.users.setAvatar(user.userId, file);
  }

  @Delete('avatar')
  removeAvatar(@CurrentUser() user: AuthUser) {
    return this.users.removeAvatar(user.userId);
  }

  @Throttle(THROTTLE.strict)
  @Post('password')
  @HttpCode(200)
  changePassword(@CurrentUser() user: AuthUser, @Body(new ZodBody(changePasswordSchema)) dto: z.infer<typeof changePasswordSchema>) {
    return this.users.changePassword(user.userId, dto.currentPassword, dto.newPassword);
  }

  /// Pedir para apagar a conta (pede a palavra-passe ou, em contas só com
  /// Google, confirmar com a conta Google). A conta só desaparece 30 dias
  /// depois; entrar de novo antes disso cancela o pedido.
  @Throttle(THROTTLE.strict)
  @Post('delete')
  @HttpCode(200)
  deleteAccount(@CurrentUser() user: AuthUser, @Body(new ZodBody(deleteAccountSchema)) dto: z.infer<typeof deleteAccountSchema>) {
    return this.users.requestDeletion(user.userId, dto);
  }

  /// Pedidos de outras pessoas à espera de resposta (convites, empréstimos, planos).
  @Get('requests')
  requests(@CurrentUser() user: AuthUser) {
    return this.users.requests(user.userId);
  }

  /// Onde a conta está aberta e as últimas entradas (com as tentativas falhadas).
  @Get('logins')
  logins(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.users.logins(user.userId, user.sessionId, limit ? Number(limit) || 40 : 40);
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  revokeOthers(@CurrentUser() user: AuthUser) {
    return this.users.revokeOtherSessions(user.userId, user.sessionId);
  }

  @Delete('sessions/:sessionId')
  revokeSession(@CurrentUser() user: AuthUser, @Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.users.revokeSession(user.userId, sessionId, user.sessionId);
  }

  @Throttle(THROTTLE.heavy)
  @Get('export')
  exportData(@CurrentUser() user: AuthUser) {
    return this.users.exportData(user.userId);
  }

  @Post('push-tokens')
  @HttpCode(200)
  pushToken(@CurrentUser() user: AuthUser, @Body(new ZodBody(pushTokenSchema)) dto: z.infer<typeof pushTokenSchema>) {
    return this.users.registerPushToken(user.userId, dto.token, dto.platform);
  }

  @Delete('push-tokens')
  removePushToken(@CurrentUser() user: AuthUser, @Query('token') token = '') {
    return this.users.removePushToken(user.userId, token);
  }
}

@Controller('users')
export class UsersLookupController {
  constructor(private readonly users: UsersService) {}

  @Throttle(THROTTLE.search)
  @Get('lookup')
  lookup(@Query('username') username = '') {
    return this.users.findByUsername(username);
  }

  /// Sugestões de pessoas enquanto se escreve (quem já conheço + um @username exato).
  @Throttle(THROTTLE.search)
  @Get('search')
  search(@CurrentUser() user: AuthUser, @Query('q') q = '') {
    return this.users.search(user.userId, q.slice(0, 60));
  }

  /// O perfil de outra pessoa e o que temos em comum.
  @Get(':id')
  profile(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.profile(user.userId, id);
  }
}
