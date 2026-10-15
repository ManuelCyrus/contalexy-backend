import { Body, Controller, Delete, Headers, HttpCode, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { THROTTLE } from '../common/throttles';
import { UploadedFileLike } from '../storage/storage.service';
import { commitSchema, CommitDto, ImportService, mappingSchema } from './import.service';

@Controller('import')
export class ImportController {
  constructor(private readonly imports: ImportService) {}

  /// Passo 1: carregar o CSV/XLSX (campo "file"); devolve o mapeamento adivinhado e a pré-visualização.
  @Throttle(THROTTLE.uploads)
  @Post('preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  preview(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedFileLike) {
    return this.imports.upload(user.userId, file);
  }

  /// Passo 2 (opcional): mudar o mapeamento das colunas à mão.
  @Post(':id/mapping')
  @HttpCode(200)
  remap(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(mappingSchema)) mapping: z.infer<typeof mappingSchema>) {
    return this.imports.remap(user.userId, id, mapping);
  }

  /// Passo 2 (opcional): pedir à IA o mapeamento (planos pagos; conta como uma pergunta).
  @Post(':id/mapping/ai')
  @HttpCode(200)
  aiMapping(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Headers('x-idempotency-key') requestKey?: string) {
    return this.imports.aiMapping(user.userId, id, requestKey);
  }

  /// Passo 3: confirmar e criar os movimentos.
  @Post(':id/commit')
  @HttpCode(200)
  commit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(commitSchema)) dto: CommitDto) {
    return this.imports.commit(user.userId, id, dto);
  }

  @Delete(':id')
  discard(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.discard(user.userId, id);
  }
}
