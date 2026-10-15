import { Body, Headers, Controller, Get, HttpCode, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { AiService, chatSchema, forecastSchema, planDraftSchema, PlanDraftInput } from './ai.service';
import { UploadedFileLike } from '../storage/storage.service';
import { env } from '../config/env';

const aiThrottle = { default: { limit: 20, ttl: 60_000 } };
const upload = () => FileInterceptor('file', { limits: { fileSize: env().MAX_UPLOAD_MB * 1024 * 1024 } });

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('usage')
  usage(@CurrentUser() user: AuthUser) {
    return this.ai.usage(user.userId);
  }

  @Throttle(aiThrottle)
  @Post('chat')
  @HttpCode(200)
  chat(@CurrentUser() user: AuthUser, @Body(new ZodBody(chatSchema)) dto: z.infer<typeof chatSchema>, @Headers('x-idempotency-key') requestKey?: string) {
    return this.ai.chat(user.userId, dto.messages, requestKey);
  }

  /// Previsão completa (conta para o limite mensal de previsões).
  @Throttle(aiThrottle)
  @Post('forecast')
  @HttpCode(200)
  forecast(@CurrentUser() user: AuthUser, @Body(new ZodBody(forecastSchema)) dto: z.infer<typeof forecastSchema>, @Headers('x-idempotency-key') requestKey?: string) {
    return this.ai.forecast(user.userId, dto.question, requestKey);
  }

  @Throttle(aiThrottle)
  @Post('insights')
  @HttpCode(200)
  insights(@CurrentUser() user: AuthUser, @Headers('x-idempotency-key') requestKey?: string) {
    return this.ai.insights(user.userId, requestKey);
  }

  @Throttle(aiThrottle)
  @Post('plan')
  @HttpCode(200)
  plan(@CurrentUser() user: AuthUser, @Body(new ZodBody(planDraftSchema)) dto: PlanDraftInput, @Headers('x-idempotency-key') requestKey?: string) {
    return this.ai.planDraft(user.userId, dto, requestKey);
  }

  @Throttle(aiThrottle)
  @Post('scan/receipt')
  @HttpCode(200)
  @UseInterceptors(upload())
  scanReceipt(@CurrentUser() user: AuthUser, @UploadedFile() file: UploadedFileLike, @Headers('x-idempotency-key') requestKey?: string) {
    return this.ai.scanReceipt(user.userId, file, requestKey);
  }

  @Throttle(aiThrottle)
  @Post('scan/price')
  @HttpCode(200)
  @UseInterceptors(upload())
  scanPrice(@CurrentUser() user: AuthUser, @UploadedFile() file: UploadedFileLike, @Headers('x-idempotency-key') requestKey?: string) {
    return this.ai.scanPrice(user.userId, file, requestKey);
  }
}
