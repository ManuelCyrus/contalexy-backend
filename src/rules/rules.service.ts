import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { LocksService } from '../billing/locks.service';
import { ApiException } from '../common/errors/api.exception';
import { FEATURES } from '../billing/plans.catalog';
import { CategoryRule } from '../generated/prisma/client';
import { uuid } from '../accounts/accounts.dto';

export const ruleSchema = z.object({
  field: z.enum(['DESCRIPTION', 'MERCHANT']).default('DESCRIPTION'),
  operator: z.enum(['CONTAINS', 'EQUALS', 'STARTS_WITH']).default('CONTAINS'),
  value: z.string().trim().min(1).max(80),
  categoryId: uuid,
  addTags: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(5).default([]),
  isActive: z.boolean().default(true),
});
export type RuleDto = z.infer<typeof ruleSchema>;
export const updateRuleSchema = ruleSchema.partial();

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function ruleMatches(rule: Pick<CategoryRule, 'field' | 'operator' | 'value'>, input: { description?: string | null; merchant?: string | null }): boolean {
  const target = rule.field === 'MERCHANT' ? input.merchant : input.description;
  if (!target) return false;
  const a = normalize(target);
  const b = normalize(rule.value);
  switch (rule.operator) {
    case 'EQUALS':
      return a === b;
    case 'STARTS_WITH':
      return a.startsWith(b);
    default:
      return a.includes(b);
  }
}

/// Regras automáticas (Premium): "se a descrição tem 'Uber' → Transporte".
@Injectable()
export class RulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly locks: LocksService,
  ) {}

  private toDto(r: CategoryRule, locked = false) {
    return {
      id: r.id,
      field: r.field,
      operator: r.operator,
      value: r.value,
      categoryId: r.categoryId,
      // Numa regra fechada vê-se a condição, mas não o que ela fazia.
      addTags: locked ? [] : r.addTags,
      isActive: r.isActive,
      /// Fechada: criada com um plano pago que a pessoa já não tem — deixou de se aplicar
      locked,
      createdAt: r.createdAt,
    };
  }

  /// Sem o plano pago, as regras continuam guardadas mas fechadas (amostra).
  async list(userId: string) {
    const [rules, locked] = await Promise.all([this.prisma.categoryRule.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }), this.locks.lockedIds(userId, 'rules')]);
    return rules.map((r) => this.toDto(r, locked.has(r.id)));
  }

  private async assertCategory(userId: string, categoryId: string) {
    const c = await this.prisma.category.findFirst({ where: { id: categoryId, userId }, select: { id: true } });
    if (!c) throw ApiException.notFound('CATEGORY_NOT_FOUND');
  }

  async create(userId: string, dto: RuleDto) {
    await this.entitlements.assertFeature(userId, FEATURES.automationRules);
    await this.entitlements.assertLimit(userId, 'rules', await this.prisma.categoryRule.count({ where: { userId } }));
    await this.assertCategory(userId, dto.categoryId);
    return this.toDto(await this.prisma.categoryRule.create({ data: { userId, ...dto } }));
  }

  async update(userId: string, id: string, dto: Partial<RuleDto>) {
    await this.entitlements.assertFeature(userId, FEATURES.automationRules);
    const rule = await this.prisma.categoryRule.findFirst({ where: { id, userId } });
    if (!rule) throw ApiException.notFound('RULE_NOT_FOUND');
    if (dto.categoryId) await this.assertCategory(userId, dto.categoryId);
    return this.toDto(await this.prisma.categoryRule.update({ where: { id }, data: dto }));
  }

  async remove(userId: string, id: string) {
    const result = await this.prisma.categoryRule.deleteMany({ where: { id, userId } });
    if (!result.count) throw ApiException.notFound('RULE_NOT_FOUND');
    return { deleted: true };
  }

  /// A primeira regra ativa que encaixa (só para quem tem o Premium).
  async match(userId: string, input: { description?: string | null; merchant?: string | null }) {
    if (!input.description && !input.merchant) return null;
    if (!(await this.entitlements.hasFeature(userId, FEATURES.automationRules))) return null;
    const locked = await this.locks.lockedIds(userId, 'rules');
    const rules = await this.prisma.categoryRule.findMany({ where: { userId, isActive: true }, orderBy: { createdAt: 'asc' } });
    return rules.find((r) => !locked.has(r.id) && ruleMatches(r, input)) ?? null;
  }

  /// Aplica as regras aos movimentos antigos que ainda não têm categoria.
  async applyToPast(userId: string) {
    await this.entitlements.assertFeature(userId, FEATURES.automationRules);
    const locked = await this.locks.lockedIds(userId, 'rules');
    const rules = (await this.prisma.categoryRule.findMany({ where: { userId, isActive: true }, include: { category: { select: { type: true } } } })).filter((r) => !locked.has(r.id));
    if (!rules.length) return { updated: 0 };
    const pending = await this.prisma.transaction.findMany({
      where: { userId, categoryId: null, type: { in: ['INCOME', 'EXPENSE'] }, isAdjustment: false },
      select: { id: true, type: true, description: true, merchant: true, tags: true },
      take: 5000,
    });
    let updated = 0;
    for (const t of pending) {
      const rule = rules.find((r) => r.category.type === t.type && ruleMatches(r, t));
      if (!rule) continue;
      const tags = Array.from(new Set([...t.tags, ...rule.addTags]));
      await this.prisma.transaction.update({ where: { id: t.id }, data: { categoryId: rule.categoryId, tags } });
      updated++;
    }
    return { updated };
  }
}
