import { Module } from '@nestjs/common';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';
import { RecurringModule } from '../recurring/recurring.module';

@Module({ imports: [RecurringModule], controllers: [InsightsController], providers: [InsightsService], exports: [InsightsService] })
export class InsightsModule {}
