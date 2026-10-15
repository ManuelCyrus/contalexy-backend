import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody, ZodQuery } from '../common/pipes/zod-validation.pipe';
import { ChatService } from './chat.service';
import { MessageDto, messageSchema, MessagesQuery, messagesQuerySchema } from './chat.dto';

/// Escrever tem um limite por minuto (ninguém escreve 30 mensagens num minuto à mão).
const sending = { default: { limit: 30, ttl: 60_000 } };

@Controller()
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('chats')
  threads(@CurrentUser() user: AuthUser) {
    return this.chat.threads(user.userId);
  }

  @Get('chats/unread')
  unread(@CurrentUser() user: AuthUser) {
    return this.chat.unread(user.userId);
  }

  /// Avisos e mensagens por ler, e o mais recente (para os números e o aviso no topo da app).
  @Get('inbox')
  inbox(@CurrentUser() user: AuthUser) {
    return this.chat.inbox(user.userId);
  }

  @Get('spaces/:id/messages')
  spaceMessages(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodQuery(messagesQuerySchema)) q: MessagesQuery) {
    return this.chat.spaceMessages(user.userId, id, q);
  }

  @Post('spaces/:id/messages')
  @Throttle(sending)
  sendToSpace(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(messageSchema)) dto: MessageDto) {
    return this.chat.sendToSpace(user.userId, id, dto.text);
  }

  @Get('chats/direct/:userId')
  directMessages(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) otherId: string, @Query(new ZodQuery(messagesQuerySchema)) q: MessagesQuery) {
    return this.chat.directMessages(user.userId, otherId, q);
  }

  @Post('chats/direct/:userId')
  @Throttle(sending)
  sendDirect(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) otherId: string, @Body(new ZodBody(messageSchema)) dto: MessageDto) {
    return this.chat.sendDirect(user.userId, otherId, dto.text);
  }

  @Delete('chats/messages/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.remove(user.userId, id);
  }
}
