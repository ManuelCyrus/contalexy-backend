import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { AiModule } from '../ai/ai.module';
import { InstitutionsModule } from '../institutions/institutions.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { UsersModule } from '../users/users.module';

@Module({ imports: [AiModule, InstitutionsModule, FeedbackModule, UsersModule], controllers: [AdminController], providers: [AdminService, AdminGuard] })
export class AdminModule {}
