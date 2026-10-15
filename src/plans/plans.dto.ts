import { z } from 'zod';
import { dateOnly, hexColor, iconName, positiveMoney, uuid } from '../accounts/accounts.dto';

export const PLAN_TYPES = ['TRIP', 'EVENT', 'PROJECT', 'PURCHASE', 'SHOPPING', 'BUSINESS', 'MOVING', 'COURSE', 'VEHICLE', 'OTHER'] as const;
export const PLAN_STATUSES = ['PLANNING', 'ACTIVE', 'DONE', 'CANCELLED'] as const;
/// COST = custo único · MONTHLY_COST = custo de todos os meses ·
/// REVENUE = receita prevista · RESERVE = dinheiro de reserva (planos de negócio)
export const ITEM_KINDS = ['COST', 'MONTHLY_COST', 'REVENUE', 'RESERVE'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
const amount = z.number().finite().min(0).max(1e12);

export const planItemSchema = z.object({
  title: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(500).nullable().optional(),
  quantity: z.number().int().min(1).max(999).default(1),
  /// Preço de uma unidade: com ele, a estimativa da linha = quantidade × preço
  unitPrice: amount.nullable().optional(),
  /// Estimativa da linha toda (usa-se quando não se dá o preço por unidade)
  estimatedAmount: amount.nullable().optional(),
  /// Quanto custou de facto (planeado vs. real)
  actualAmount: amount.nullable().optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  dueDate: dateOnly.nullable().optional(),
  categoryKey: z.string().trim().max(30).nullable().optional(),
  isDone: z.boolean().optional(),
});
export type PlanItemDto = z.infer<typeof planItemSchema>;

export const updatePlanItemSchema = planItemSchema.partial().extend({ sortOrder: z.number().int().min(0).max(10000).optional() });
export type UpdatePlanItemDto = z.infer<typeof updatePlanItemSchema>;

export const createPlanSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(PLAN_TYPES).default('OTHER'),
  status: z.enum(PLAN_STATUSES).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  icon: iconName.optional(),
  color: hexColor.optional(),
  budget: positiveMoney.nullable().optional(),
  /// Planos de negócio: capital disponível para arrancar
  capital: positiveMoney.nullable().optional(),
  /// Fixar no Início
  pinned: z.boolean().optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  startDate: dateOnly.nullable().optional(),
  endDate: dateOnly.nullable().optional(),
  /// Mês a que o plano pertence ("2026-11") — aparece no plano desse mês
  periodKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable().optional(),
  /// Categoria de despesa que este plano detalha (ex.: lista de compras → Alimentação)
  categoryId: uuid.nullable().optional(),
  items: z.array(planItemSchema).max(500).optional(),
  /// Plano criado a partir de um rascunho da IA (só para mostrar o selo)
  aiGenerated: z.boolean().optional(),
});
export type CreatePlanDto = z.infer<typeof createPlanSchema>;

export const updatePlanSchema = createPlanSchema.omit({ items: true, aiGenerated: true }).partial();
export type UpdatePlanDto = z.infer<typeof updatePlanSchema>;

export const payItemSchema = z.object({
  accountId: uuid,
  amount: positiveMoney.optional(),
  date: dateOnly.optional(),
  categoryId: uuid.nullable().optional(),
});
export type PayItemDto = z.infer<typeof payItemSchema>;

/// "Fiz as compras": guarda quanto custou cada item e cria UMA despesa com o total.
export const checkoutSchema = z.object({
  accountId: uuid,
  date: dateOnly.optional(),
  categoryId: uuid.nullable().optional(),
  /// Valor real de cada item comprado (ficam marcados como feitos)
  items: z.array(z.object({ itemId: uuid, actualAmount: amount })).max(500).optional(),
  /// Total pago (por omissão: a soma dos itens feitos e ainda por pagar)
  total: positiveMoney.optional(),
  description: z.string().trim().max(140).optional(),
  /// Fechar a lista depois de registar a despesa
  close: z.boolean().optional(),
});
export type CheckoutDto = z.infer<typeof checkoutSchema>;

/// Duplicar: opcionalmente já para outro mês ("a lista de compras do mês que vem").
export const duplicatePlanSchema = z.object({ periodKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable().optional() });
export type DuplicatePlanDto = z.infer<typeof duplicatePlanSchema>;
