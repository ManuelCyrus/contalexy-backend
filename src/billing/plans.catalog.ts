/// Catálogo por defeito dos planos. Fica na tabela SubscriptionPlan (é
/// lá que se mudam limites/benefícios sem novo deploy); isto só serve para
/// a criar na primeira vez e como referência.
///
/// Para acrescentar um benefício Premium: inventa uma chave de
/// funcionalidade (ex.: "reports.pdf"), junta-a aos planos que a têm e usa
/// `entitlements.assertFeature(userId, 'reports.pdf')` no serviço. Para um
/// plano novo: mais uma entrada aqui (ou uma linha na tabela) — o resto do
/// sistema lê o catálogo.

export const FREE_PLAN = 'FREE';
export const PREMIUM_PLAN = 'PREMIUM';
export const PREMIUM_PLUS_PLAN = 'PREMIUM_PLUS';

/// Funcionalidades com chave. As de IA "de base" (assistente, recibos,
/// previsões) existem em TODOS os planos — o que muda é quantas vezes por
/// mês se podem usar (ver limites). As restantes são dos planos pagos.
export const FEATURES = {
  aiAssistant: 'ai.assistant',
  aiInsights: 'ai.insights',
  aiPlans: 'ai.plans',
  aiForecasts: 'ai.forecasts',
  aiAdvanced: 'ai.advanced',
  scannerReceipts: 'scanner.receipts',
  scannerPrices: 'scanner.prices',
  pricesHistory: 'prices.history',
  reportsAdvanced: 'reports.advanced',
  exportAdvanced: 'export.advanced',
  automationRules: 'automation.rules',
  alertsAdvanced: 'alerts.advanced',
  budgetsRollover: 'budgets.rollover',
  planningAdvanced: 'planning.advanced',
  simulationsAdvanced: 'simulations.advanced',
  insightsAdvanced: 'insights.advanced',
  openBanking: 'openbanking',
  analyticsAdvanced: 'analytics.advanced',
  experimental: 'experimental',
  /// Importar CSV/XLSX com mapeamento inteligente (IA só quando o normal não chega)
  importSmart: 'import.smart',
  /// Registar despesas por WhatsApp (mensagens e fotografias de faturas)
  whatsapp: 'whatsapp',
} as const;

/// Áreas da app que um código promocional pode fechar (a app esconde-as e
/// o servidor recusa as rotas). As chaves são as dos menus da app.
export const AREAS = ['spaces', 'loans', 'sharing', 'plans', 'goals', 'budgets', 'recurring', 'simulator', 'ai', 'prices', 'rules', 'reports', 'chat', 'offers', 'shopping', 'investments', 'import', 'whatsapp'] as const;
export type AreaKey = (typeof AREAS)[number];

/// Funcionalidades que deixaram de existir num plano (para corrigir planos
/// já guardados na base de dados quando o catálogo muda).
export const REMOVED_FEATURES: Record<string, string[]> = {
  [FREE_PLAN]: ['scanner.receipts'],
};

export type FeatureKey = (typeof FEATURES)[keyof typeof FEATURES];

/// Limites. null = sem limite.
export interface PlanLimits {
  accounts: number | null;
  customCategories: number | null;
  budgets: number | null;
  goals: number | null;
  plans: number | null;
  planItems: number | null;
  spaces: number | null;
  spaceMembers: number | null;
  recurring: number | null;
  savedFilters: number | null;
  rules: number | null;
  /// Empréstimos em aberto
  loans: number | null;
  /// Pessoas que podem acompanhar os meus gastos
  sharedViewers: number | null;
  /// IA por mês: perguntas rápidas ao assistente
  aiRequestsMonthly: number | null;
  /// IA por mês: documentos lidos (recibos, etiquetas)
  scansMonthly: number | null;
  /// IA por mês: previsões/análises completas (inclui planos com IA)
  forecastsMonthly: number | null;
  /// Até quantos meses para trás vão os relatórios
  reportMonths: number | null;
  /// Quantos dias se podem exportar de uma vez
  exportDays: number | null;
}

export type LimitKey = keyof PlanLimits;

export interface PlanDefinition {
  code: string;
  rank: number;
  features: string[];
  limits: PlanLimits;
  entitlementId: string | null;
  /// Subscrições (renovam sozinhas até a pessoa cancelar na loja)
  productIds: string[];
  /// Compras de uma só vez (sem renovação): produto → dias de plano que dá
  /// (null = para sempre). Comprar outra vez soma ao tempo que ainda falta.
  oneTimeProducts: Record<string, number | null>;
}

/// IA incluída em todos os planos (com limite mensal).
const baseFeatures = [FEATURES.aiAssistant, FEATURES.aiInsights, FEATURES.aiPlans, FEATURES.aiForecasts, FEATURES.scannerReceipts];

const premiumFeatures = [
  ...baseFeatures,
  FEATURES.scannerPrices,
  FEATURES.pricesHistory,
  FEATURES.reportsAdvanced,
  FEATURES.exportAdvanced,
  FEATURES.automationRules,
  FEATURES.alertsAdvanced,
  FEATURES.budgetsRollover,
  FEATURES.planningAdvanced,
  FEATURES.simulationsAdvanced,
  FEATURES.insightsAdvanced,
];

export const DEFAULT_PLANS: PlanDefinition[] = [
  {
    code: FREE_PLAN,
    rank: 0,
    features: baseFeatures,
    limits: {
      accounts: 5,
      customCategories: 10,
      budgets: 5,
      goals: 3,
      plans: 3,
      planItems: 40,
      spaces: 2,
      spaceMembers: 6,
      recurring: 15,
      savedFilters: 2,
      rules: 0,
      loans: 10,
      sharedViewers: 2,
      // Limites iniciais de IA do plano grátis (por pessoa, por mês de quota)
      aiRequestsMonthly: 10,
      scansMonthly: 0,
      forecastsMonthly: 2,
      reportMonths: 3,
      exportDays: 31,
    },
    entitlementId: null,
    productIds: [],
    oneTimeProducts: {},
  },
  {
    code: PREMIUM_PLAN,
    rank: 1,
    features: premiumFeatures,
    limits: {
      accounts: 50,
      customCategories: 100,
      budgets: 50,
      goals: 30,
      plans: 30,
      planItems: 200,
      spaces: 10,
      spaceMembers: 30,
      recurring: 100,
      savedFilters: 30,
      rules: 50,
      loans: 200,
      sharedViewers: 10,
      aiRequestsMonthly: 150,
      scansMonthly: 100,
      forecastsMonthly: 30,
      reportMonths: 36,
      exportDays: null,
    },
    entitlementId: 'premium',
    productIds: ['contalex_premium_monthly', 'contalex_premium_yearly'],
    oneTimeProducts: { contalex_premium_pass_month: 31, contalex_premium_pass_year: 366 },
  },
  {
    code: PREMIUM_PLUS_PLAN,
    rank: 2,
    features: [...premiumFeatures, FEATURES.aiAdvanced, FEATURES.openBanking, FEATURES.analyticsAdvanced, FEATURES.experimental, FEATURES.whatsapp],
    limits: {
      accounts: null,
      customCategories: null,
      budgets: null,
      goals: null,
      plans: null,
      planItems: 500,
      spaces: 30,
      spaceMembers: 100,
      recurring: null,
      savedFilters: null,
      rules: null,
      loans: null,
      sharedViewers: 30,
      aiRequestsMonthly: 600,
      scansMonthly: 400,
      forecastsMonthly: 120,
      reportMonths: null,
      exportDays: null,
    },
    entitlementId: 'premium_plus',
    productIds: ['contalex_premium_plus_monthly', 'contalex_premium_plus_yearly'],
    oneTimeProducts: { contalex_premium_plus_pass_month: 31, contalex_premium_plus_pass_year: 366 },
  },
];

export const LIMIT_KEYS: LimitKey[] = Object.keys(DEFAULT_PLANS[0].limits) as LimitKey[];
