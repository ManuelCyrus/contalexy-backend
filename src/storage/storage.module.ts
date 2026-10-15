import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { AttachmentsService } from './attachments.service';
import { FilesController } from './files.controller';

@Global()
@Module({
  controllers: [FilesController],
  providers: [StorageService, AttachmentsService],
  exports: [StorageService, AttachmentsService],
})
export class StorageModule {}
