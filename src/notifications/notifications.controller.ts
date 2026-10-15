import { Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('limit') limit?: string, @Query('before') before?: string) {
    return this.notifications.list(user.userId, Number(limit) || 30, before);
  }

  @Get('unread-count')
  unread(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.userId);
  }

  @Post('read-all')
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.userId);
  }

  @Post(':id/read')
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.remove(user.userId, id);
  }
}
