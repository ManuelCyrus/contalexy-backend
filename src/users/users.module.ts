import { Module } from '@nestjs/common';
import { UsersController, UsersLookupController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController, UsersLookupController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
