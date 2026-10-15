import { z } from 'zod';
import { hexColor, iconName, uuid } from '../accounts/accounts.dto';

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(40),
  type: z.enum(['INCOME', 'EXPENSE']),
  icon: iconName.optional(),
  color: hexColor.optional(),
  parentId: uuid.nullable().optional(),
});
export type CreateCategoryDto = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  /// null volta ao nome traduzido (só nas de base)
  name: z.string().trim().min(1).max(40).nullable().optional(),
  icon: iconName.optional(),
  color: hexColor.optional(),
  parentId: uuid.nullable().optional(),
  archived: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});
export type UpdateCategoryDto = z.infer<typeof updateCategorySchema>;
