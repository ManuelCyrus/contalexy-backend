import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { StorageService, UploadedFileLike } from '../storage/storage.service';
import { ApiException } from '../common/errors/api.exception';
import { Institution } from '../generated/prisma/client';

/// Um endereço de logótipo escrito à mão: só https e só imagens (confirma-se com um HEAD).
const logoUrlSchema = z.string().trim().url().max(500).refine((u) => u.startsWith('https://'), 'https only');

export const institutionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  country: z.string().trim().toUpperCase().length(2).nullable().optional(),
  logoUrl: logoUrlSchema.nullable().optional(),
  website: z.string().trim().url().max(300).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});
export type InstitutionDto = z.infer<typeof institutionSchema>;

/// Bancos e carteiras de referência: só o nome e o logótipo, para as contas
/// manuais ficarem reconhecíveis. Não há ligação a nenhum banco.
@Injectable()
export class InstitutionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  private dto(i: Institution) {
    return { id: i.id, name: i.name, country: i.country, logoUrl: i.logoKey ? this.storage.publicUrl(i.logoKey) : i.logoUrl, website: i.website, isActive: i.isActive, sortOrder: i.sortOrder, uploaded: !!i.logoKey, createdAt: i.createdAt };
  }

  /// Para a app: os do país da pessoa primeiro, depois os de todo o lado.
  async listPublic(country?: string | null) {
    const rows = await this.prisma.institution.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    const c = country?.toUpperCase();
    const score = (i: Institution) => (i.country === c ? 0 : i.country === null ? 1 : 2);
    return rows
      .filter((i) => !c || !i.country || i.country === c)
      .sort((a, b) => score(a) - score(b) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((i) => this.dto(i));
  }

  async listAll() {
    const rows = await this.prisma.institution.findMany({ orderBy: [{ country: { sort: 'asc', nulls: 'first' } }, { sortOrder: 'asc' }, { name: 'asc' }] });
    const usage = await this.prisma.account.groupBy({ by: ['institutionId'], where: { institutionId: { not: null } }, _count: { _all: true } });
    const count = new Map(usage.map((u) => [u.institutionId, u._count._all]));
    return rows.map((i) => ({ ...this.dto(i), accounts: count.get(i.id) ?? 0 }));
  }

  /// Um endereço de logótipo tem de responder com uma imagem.
  private async checkLogoUrl(url: string) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/^image\/(png|jpeg|webp|svg\+xml|gif)/.test(type)) throw new Error('not an image');
    } catch {
      throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'logoUrl', message: 'not an image url' }]);
    }
  }

  async create(dto: InstitutionDto) {
    if (dto.logoUrl) await this.checkLogoUrl(dto.logoUrl);
    const created = await this.prisma.institution.create({ data: { name: dto.name, country: dto.country ?? null, logoUrl: dto.logoUrl ?? null, website: dto.website ?? null, isActive: dto.isActive ?? true, sortOrder: dto.sortOrder ?? 0 } });
    return this.dto(created);
  }

  async update(id: string, dto: Partial<InstitutionDto>) {
    const existing = await this.prisma.institution.findUnique({ where: { id } });
    if (!existing) throw ApiException.notFound('NOT_FOUND');
    if (dto.logoUrl) await this.checkLogoUrl(dto.logoUrl);
    const data: Record<string, unknown> = {};
    for (const key of ['name', 'country', 'website', 'isActive', 'sortOrder'] as const) if (dto[key] !== undefined) data[key] = dto[key];
    if (dto.logoUrl !== undefined) {
      data.logoUrl = dto.logoUrl;
      // Um endereço novo substitui o ficheiro carregado.
      if (dto.logoUrl && existing.logoKey) {
        await this.storage.remove(existing.logoKey);
        data.logoKey = null;
      }
    }
    const updated = await this.prisma.institution.update({ where: { id }, data });
    return this.dto(updated);
  }

  async uploadLogo(id: string, file: UploadedFileLike | undefined) {
    if (!file) throw ApiException.badRequest('FILE_REQUIRED');
    const existing = await this.prisma.institution.findUnique({ where: { id } });
    if (!existing) throw ApiException.notFound('NOT_FOUND');
    const saved = await this.storage.save(file, 'avatars/institutions', { imagesOnly: true });
    if (existing.logoKey) await this.storage.remove(existing.logoKey);
    const updated = await this.prisma.institution.update({ where: { id }, data: { logoKey: saved.key, logoUrl: null } });
    return this.dto(updated);
  }

  async remove(id: string) {
    const existing = await this.prisma.institution.findUnique({ where: { id } });
    if (!existing) throw ApiException.notFound('NOT_FOUND');
    // As contas que o usavam ficam só com o nome escrito.
    await this.prisma.account.updateMany({ where: { institutionId: id }, data: { institutionId: null } });
    await this.prisma.institution.delete({ where: { id } });
    if (existing.logoKey) await this.storage.remove(existing.logoKey);
    return { deleted: true };
  }
}
