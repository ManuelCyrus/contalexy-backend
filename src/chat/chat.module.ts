import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { SpacesModule } from '../spaces/spaces.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [SpacesModule, UsersModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
