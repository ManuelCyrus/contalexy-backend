import { Throttle } from '@nestjs/throttler';
import { Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { THROTTLE } from '../common/throttles';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { AttachmentsService } from './attachments.service';
import { StorageService, UploadedFileLike } from './storage.service';
import { ApiException } from '../common/errors/api.exception';
import { env } from '../config/env';

const uploadLimits = () => ({ limits: { fileSize: env().MAX_UPLOAD_MB * 1024 * 1024 } });

@Controller()
export class FilesController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly storage: StorageService,
  ) {}

  /// Carregar um recibo antes de gravar o movimento (devolve o id para
  /// mandar em `attachmentIds`).
  @Throttle(THROTTLE.uploads)
  @Post('attachments')
  @UseInterceptors(FileInterceptor('file', uploadLimits()))
  upload(@CurrentUser() user: AuthUser, @UploadedFile() file: UploadedFileLike, @Query('kind') kind?: string) {
    const k = kind === 'PRICE_TAG' ? 'PRICE_TAG' : kind === 'OTHER' ? 'OTHER' : 'RECEIPT';
    return this.attachments.upload(user.userId, file, k);
  }

  @Delete('attachments/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attachments.remove(user.userId, id);
  }

  /// O endereço temporário de um ficheiro (no S3) ou o próprio /files/:id.
  @Get('files/:id/url')
  async url(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const attachment = await this.attachments.findReadable(user.userId, id);
    const signed = await this.storage.signedUrl(attachment.storageKey);
    return signed ?? { url: `${env().APP_PUBLIC_URL.replace(/\/$/, '')}/v1/files/${id}`, expiresAt: null };
  }

  /// Ver um ficheiro (com sessão e permissão).
  @Get('files/:id')
  async file(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const attachment = await this.attachments.findReadable(user.userId, id);
    // No S3 o ficheiro é privado: a resposta é um endereço temporário.
    const signed = await this.storage.signedUrl(attachment.storageKey);
    if (signed) {
      res.redirect(302, signed.url);
      return;
    }
    if (!(await this.storage.exists(attachment.storageKey))) throw ApiException.notFound('FILE_NOT_FOUND');
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return new StreamableFile(this.storage.stream(attachment.storageKey));
  }
}
