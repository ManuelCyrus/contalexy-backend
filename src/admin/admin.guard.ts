import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ApiException } from '../common/errors/api.exception';
import { adminAreasOf, areaOfPath, isAdminUser } from '../common/utils/admin';

/// Só administradores (ver isAdminUser), e só nas áreas que lhes foram dadas
/// (adminAreas vazio = todas). Tornar alguém admin é só para quem acede a tudo.
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId = req.user?.userId as string | undefined;
    if (!userId) throw ApiException.unauthorized();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, email: true, adminAreas: true } });
    if (!user || !isAdminUser(user)) throw ApiException.forbidden('ADMIN_REQUIRED');
    const areas = adminAreasOf(user);
    if (areas === null) return true;
    const area = areaOfPath(String(req.path ?? req.url ?? ''));
    if (area === null) return true;
    if (area === 'roles' || !areas.includes(area)) throw ApiException.forbidden('ADMIN_AREA_REQUIRED');
    return true;
  }
}
