import { Global, Module } from '@nestjs/common';
import { DailyLimitController } from './daily-limit.controller';
import { DailyLimitService } from './daily-limit.service';

@Global()
@Module({
  controllers: [DailyLimitController],
  providers: [DailyLimitService],
  exports: [DailyLimitService],
})
export class DailyLimitModule {}
