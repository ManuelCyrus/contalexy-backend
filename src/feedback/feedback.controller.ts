import { Throttle } from '@nestjs/throttler';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { THROTTLE } from '../common/throttles';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { FeedbackService, feedbackSchema } from './feedback.service';

@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Throttle(THROTTLE.social)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBody(feedbackSchema)) dto: z.infer<typeof feedbackSchema>) {
    return this.feedback.create(user.userId, dto);
  }

  @Get()
  mine(@CurrentUser() user: AuthUser) {
    return this.feedback.mine(user.userId);
  }
}
