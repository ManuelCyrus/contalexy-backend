import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { ApiException } from '../common/errors/api.exception';
import { Category, CategoryType, Prisma } from '../generated/prisma/client';
import { CreateCategoryDto, UpdateCategoryDto } from './categories.dto';
import { DEFAULT_CATEGORIES } from './default-categories';

export const toCategoryDto = (c: Category, usage?: number) => ({
  id: c.id,
  key: c.key,
  name: c.name,
  type: c.type,
  icon: c.icon,
  color: c.color,
  parentId: c.parentId,
  archived: !!c.archivedAt,
  sortOrder: c.sortOrder,
  isDefault: c.key !== null,
  ...(usage !== undefined ? { usage } : {}),
});

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(userId: string, type?: CategoryType, includeArchived = false) {
    const [categories, usage] = await Promise.all([
      this.prisma.category.findMany({
        where: { userId, ...(type ? { type } : {}), ...(includeArchived ? {} : { archivedAt: null }) },
        orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.transaction.groupBy({ by: ['categoryId'], where: { userId, categoryId: { not: null } }, _count: { _all: true } }),
    ]);
    const counts = new Map(usage.map((u) => [u.categoryId, u._count._all]));
    return categories.map((c) => toCategoryDto(c, counts.get(c.id) ?? 0));
  }

  async ownedOrThrow(userId: string, id: string) {
    const category = await this.prisma.category.findFirst({ where: { id, userId } });
    if (!category) throw ApiException.notFound('CATEGORY_NOT_FOUND');
    return category;
  }

  async create(userId: string, dto: CreateCategoryDto) {
    const custom = await this.prisma.category.count({ where: { userId, key: null, archivedAt: null } });
    await this.entitlements.assertLimit(userId, 'customCategories', custom);
    if (dto.parentId) {
      const parent = await this.ownedOrThrow(userId, dto.parentId);
      if (parent.type !== dto.type) throw ApiException.badRequest('CATEGORY_TYPE_MISMATCH');
    }
    const last = await this.prisma.category.aggregate({ where: { userId, type: dto.type }, _max: { sortOrder: true } });
    const category = await this.prisma.category.create({
      data: {
        userId,
        name: dto.name,
        type: dto.type,
        icon: dto.icon ?? 'tag',
        color: dto.color ?? '#64748B',
        parentId: dto.parentId ?? null,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
    return toCategoryDto(category, 0);
  }

  async update(userId: string, id: string, dto: UpdateCategoryDto) {
    const category = await this.ownedOrThrow(userId, id);
    const data: Prisma.CategoryUpdateInput = {};
    if (dto.name !== undefined) {
      if (dto.name === null && !category.key) throw ApiException.badRequest('VALIDATION_ERROR', undefined, [{ field: 'name', message: 'required' }]);
      data.name = dto.name;
    }
    if (dto.icon !== undefined) data.icon = dto.icon;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.parentId !== undefined) {
      if (dto.parentId) {
        if (dto.parentId === id) throw ApiException.badRequest('INVALID_REQUEST');
        const parent = await this.ownedOrThrow(userId, dto.parentId);
        if (parent.type !== category.type) throw ApiException.badRequest('CATEGORY_TYPE_MISMATCH');
        data.parent = { connect: { id: dto.parentId } };
      } else {
        data.parent = { disconnect: true };
      }
    }
    if (dto.archived !== undefined) {
      if (!dto.archived && category.archivedAt && !category.key) {
        const custom = await this.prisma.category.count({ where: { userId, key: null, archivedAt: null } });
        await this.entitlements.assertLimit(userId, 'customCategories', custom);
      }
      data.archivedAt = dto.archived ? (category.archivedAt ?? new Date()) : null;
    }
    const updated = await this.prisma.category.update({ where: { id }, data });
    return toCategoryDto(updated);
  }

  /// Apagar: os movimentos passam para `moveTo` (ou ficam sem categoria).
  async remove(userId: string, id: string, moveTo?: string) {
    const category = await this.ownedOrThrow(userId, id);
    if (moveTo) {
      if (moveTo === id) throw ApiException.badRequest('INVALID_REQUEST');
      const target = await this.ownedOrThrow(userId, moveTo);
      if (target.type !== category.type) throw ApiException.badRequest('CATEGORY_TYPE_MISMATCH');
      await this.prisma.transaction.updateMany({ where: { userId, categoryId: id }, data: { categoryId: moveTo } });
      await this.prisma.recurringRule.updateMany({ where: { userId, categoryId: id }, data: { categoryId: moveTo } });
    }
    // Orçamentos que usavam esta categoria deixam de a ter.
    const budgets = await this.prisma.budget.findMany({ where: { userId, categoryIds: { has: id } }, select: { id: true, categoryIds: true } });
    for (const b of budgets) {
      const ids = b.categoryIds.filter((c) => c !== id);
      if (moveTo && !ids.includes(moveTo)) ids.push(moveTo);
      await this.prisma.budget.update({ where: { id: b.id }, data: { categoryIds: ids } });
    }
    await this.prisma.category.delete({ where: { id } });
    return { deleted: true };
  }

  /// Volta a criar as categorias de base que tenham sido apagadas.
  async restoreDefaults(userId: string) {
    const existing = await this.prisma.category.findMany({ where: { userId, key: { not: null } }, select: { key: true } });
    const have = new Set(existing.map((c) => c.key));
    const missing = DEFAULT_CATEGORIES.filter((c) => !have.has(c.key));
    if (missing.length) {
      await this.prisma.category.createMany({
        data: missing.map((c, i) => ({ userId, key: c.key, type: c.type, icon: c.icon, color: c.color, sortOrder: 100 + i })),
      });
    }
    await this.prisma.category.updateMany({ where: { userId, key: { not: null } }, data: { archivedAt: null } });
    return this.list(userId);
  }
}
