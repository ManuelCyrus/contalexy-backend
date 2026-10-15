import { Controller, Get, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';
import { InstitutionsService } from './institutions.service';

/// Lista pública (para quem está ligado) dos bancos de referência.
@Controller('meta/institutions')
export class InstitutionsController {
  constructor(
    private readonly institutions: InstitutionsService,
    private readonly prisma: PrismaService,
  ) {}

  /// ?country=PT (por omissão, o país da pessoa)
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('country') country?: string) {
    const c = country ?? (await this.prisma.user.findUnique({ where: { id: user.userId }, select: { country: true } }))?.country;
    return this.institutions.listPublic(c);
  }
}
