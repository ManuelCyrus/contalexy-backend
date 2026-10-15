import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { InstitutionsController } from './institutions.controller';
import { InstitutionsService } from './institutions.service';

@Module({ imports: [StorageModule], controllers: [InstitutionsController], providers: [InstitutionsService], exports: [InstitutionsService] })
export class InstitutionsModule {}
