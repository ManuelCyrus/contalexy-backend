import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { AiModule } from '../ai/ai.module';
import { InstitutionsModule } from '../institutions/institutions.module';
import { FeedbackModule } from '../feedback/feedback.module';

@Module({ imports: [AiModule, InstitutionsModule, FeedbackModule], controllers: [AdminController], providers: [AdminService, AdminGuard] })
export class AdminModule {}
