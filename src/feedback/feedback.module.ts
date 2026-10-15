import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

@Module({ imports: [MailModule], controllers: [FeedbackController], providers: [FeedbackService], exports: [FeedbackService] })
export class FeedbackModule {}
