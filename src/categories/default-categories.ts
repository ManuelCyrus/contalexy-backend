import { CategoryType } from '../generated/prisma/client';

/// Categorias criadas para cada conta nova. A app traduz pela `key`; a
/// pessoa pode renomear, mudar cor/ícone, arquivar ou criar outras.
/// Os ícones são nomes que a app conhece (ver category_icons.dart).
export const DEFAULT_CATEGORIES: Array<{ key: string; type: CategoryType; icon: string; color: string }> = [
  { key: 'food', type: 'EXPENSE', icon: 'restaurant', color: '#F97316' },
  { key: 'transport', type: 'EXPENSE', icon: 'directions_car', color: '#3B82F6' },
  { key: 'home', type: 'EXPENSE', icon: 'home', color: '#8B5CF6' },
  { key: 'health', type: 'EXPENSE', icon: 'medical_services', color: '#EF4444' },
  { key: 'education', type: 'EXPENSE', icon: 'school', color: '#0EA5E9' },
  { key: 'entertainment', type: 'EXPENSE', icon: 'movie', color: '#EC4899' },
  { key: 'shopping', type: 'EXPENSE', icon: 'shopping_bag', color: '#F59E0B' },
  { key: 'technology', type: 'EXPENSE', icon: 'devices', color: '#6366F1' },
  { key: 'travel', type: 'EXPENSE', icon: 'flight', color: '#14B8A6' },
  { key: 'subscriptions', type: 'EXPENSE', icon: 'subscriptions', color: '#A855F7' },
  { key: 'other_expense', type: 'EXPENSE', icon: 'category', color: '#64748B' },
  { key: 'salary', type: 'INCOME', icon: 'work', color: '#12B886' },
  { key: 'freelance', type: 'INCOME', icon: 'laptop', color: '#22C55E' },
  { key: 'sale', type: 'INCOME', icon: 'sell', color: '#84CC16' },
  { key: 'transfer_in', type: 'INCOME', icon: 'swap_horiz', color: '#06B6D4' },
  { key: 'bonus', type: 'INCOME', icon: 'star', color: '#EAB308' },
  { key: 'other_income', type: 'INCOME', icon: 'payments', color: '#64748B' },
];
