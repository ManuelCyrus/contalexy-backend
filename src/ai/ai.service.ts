import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { QuotaService } from '../billing/quota.service';
import { CreditsService, creditProducts } from '../billing/credits.service';
import { RedisService } from '../infra/redis.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { AttachmentsService } from '../storage/attachments.service';
import { StorageService, UploadedFileLike } from '../storage/storage.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PlansService } from '../plans/plans.service';
import { SimulatorService } from '../simulator/simulator.service';
import { InsightsService } from '../insights/insights.service';
import { ApiException } from '../common/errors/api.exception';
import { categoryName, resolveLanguage } from '../common/i18n/messages';
import { FEATURES, LimitKey } from '../billing/plans.catalog';
import { env } from '../config/env';
import { isDateOnly, todayIn } from '../common/utils/dates';
import { round2 } from '../common/utils/money';
import { AiKind } from '../generated/prisma/client';
import { DEFAULT_CATEGORIES } from '../categories/default-categories';
import { AiMessage, AnthropicClient, extractJson } from './anthropic.client';
import { AiBudgetService, estimateCost } from './ai-budget.service';
import { ITEM_KINDS, PLAN_TYPES } from '../plans/plans.dto';
import { normalizeProductName } from '../prices/prices.service';

const LANGUAGE_NAMES: Record<string, string> = {
  pt: 'European Portuguese (pt-PT)',
  en: 'English',
  fr: 'French',
  de: 'German',
};

const EXPENSE_KEYS = DEFAULT_CATEGORIES.filter((c) => c.type === 'EXPENSE').map((c) => c.key);
const VISION_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/// Os três "contadores" mensais de IA de cada pessoa.
export type AiBucket = 'questions' | 'scans' | 'forecasts';
const BUCKETS: Record<AiBucket, { kinds: AiKind[]; limit: LimitKey }> = {
  /// Perguntas rápidas ao assistente
  questions: { kinds: ['CHAT'], limit: 'aiRequestsMonthly' },
  /// Documentos lidos (recibos, faturas, etiquetas de preço)
  scans: { kinds: ['RECEIPT_SCAN', 'PRICE_SCAN'], limit: 'scansMonthly' },
  /// Previsões e análises completas (mais pesadas)
  forecasts: { kinds: ['FORECAST', 'INSIGHTS', 'PLAN'], limit: 'forecastsMonthly' },
};
const bucketOf = (kind: AiKind): AiBucket => (Object.keys(BUCKETS) as AiBucket[]).find((b) => BUCKETS[b].kinds.includes(kind)) ?? 'questions';

export const forecastSchema = z.object({ question: z.string().trim().max(300).optional() });

const forecastOutputSchema = z.object({
  headline: z.string().max(200).catch(''),
  summary: z.string().max(1500).catch(''),
  sections: z
    .array(z.object({ title: z.string().max(120), detail: z.string().max(800), tone: z.enum(['positive', 'warning', 'neutral']).catch('neutral') }))
    .max(8)
    .catch([]),
  actions: z.array(z.string().max(300)).max(6).catch([]),
});

export const chatSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(12),
});

export const planDraftSchema = z.object({
  prompt: z.string().trim().min(5).max(800),
  type: z.enum(PLAN_TYPES).optional(),
  budget: z.number().positive().max(1e9).optional(),
  /// Planos de negócio: capital disponível para arrancar
  capital: z.number().positive().max(1e9).optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  people: z.number().int().min(1).max(50).optional(),
  save: z.boolean().optional(),
});
export type PlanDraftInput = z.infer<typeof planDraftSchema>;

const draftOutputSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(PLAN_TYPES).catch('OTHER'),
  description: z.string().max(1000).nullable().optional(),
  budget: z.number().positive().max(1e9).nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        quantity: z.number().int().min(1).max(999).catch(1),
        estimatedAmount: z.number().min(0).max(1e9).nullable().catch(null),
        kind: z.enum(ITEM_KINDS).catch('COST'),
        categoryKey: z.string().nullable().catch(null),
        notes: z.string().max(500).nullable().catch(null),
      }),
    )
    .max(40),
});

const receiptSchema = z.object({
  merchant: z.string().max(80).nullable().catch(null),
  date: z.string().nullable().catch(null),
  total: z.number().min(0).max(1e9).nullable().catch(null),
  currency: z.string().length(3).nullable().catch(null),
  categoryKey: z.string().nullable().catch(null),
  items: z
    .array(z.object({ name: z.string().max(120), quantity: z.number().min(0).max(9999).nullable().catch(null), price: z.number().min(0).max(1e9).nullable().catch(null) }))
    .max(80)
    .catch([]),
  confidence: z.number().min(0).max(1).catch(0.5),
});

const priceSchema = z.object({
  productName: z.string().min(1).max(120),
  brand: z.string().max(60).nullable().catch(null),
  price: z.number().positive().max(1e9),
  currency: z.string().length(3).nullable().catch(null),
  quantity: z.number().positive().max(1e6).nullable().catch(null),
  unit: z.enum(['un', 'kg', 'g', 'l', 'ml']).nullable().catch(null),
  storeName: z.string().max(80).nullable().catch(null),
  confidence: z.number().min(0).max(1).catch(0.5),
});

/// Funcionalidades de IA: assistente (perguntas rápidas), previsões e
/// análises completas, planos automáticos, leitura de recibos e de preços.
/// Usa o Claude (Anthropic). Existem em todos os planos, com um limite
/// mensal por pessoa e por tipo — e um teto global de custo (AiBudgetService).
/// As contas simples (simulador, desperdícios, plano mensal) NÃO passam por aqui.
/// Tira o Markdown que o modelo às vezes mete mesmo quando se lhe pede texto
/// simples (a app e o site mostram o texto tal como vem): **negrito**, _itálico_,
/// `código`, títulos com # e listas com * passam a texto normal.
export function plainText(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/^\s*>\s?/gm, '')
    .trim();
}

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly attachments: AttachmentsService,
    private readonly storage: StorageService,
    private readonly analytics: AnalyticsService,
    private readonly plans: PlansService,
    private readonly simulator: SimulatorService,
    private readonly waste: InsightsService,
    private readonly budget: AiBudgetService,
    private readonly client: AnthropicClient,
    private readonly quota: QuotaService,
    private readonly credits: CreditsService,
    private readonly redis: RedisService,
  ) {}

  /// Limite curto (renova sozinho): quantos pedidos por janela, por pessoa.
  private burstLimit(rank: number) {
    return rank > 0 ? env().AI_BURST_LIMIT_PAID : env().AI_BURST_LIMIT_FREE;
  }

  private async burstState(userId: string, rank: number) {
    const window = env().AI_BURST_WINDOW_MINUTES * 60;
    const key = `ai:burst:${userId}`;
    const raw = await this.redis.get(key);
    const used = raw ? Number(raw) : 0;
    const limit = this.burstLimit(rank);
    return { used, limit, remaining: Math.max(0, limit - used), windowMinutes: env().AI_BURST_WINDOW_MINUTES, windowSeconds: window };
  }

  /// O plano grátis é o que fica em pausa quando o teto global aperta.
  private async limitedFor(rank: number): Promise<'none' | 'heavy' | 'all'> {
    if (rank > 0) return 'none';
    return (await this.budget.state()).level;
  }

  async usage(userId: string) {
    const ent = await this.entitlements.forUser(userId);
    const { period, items } = await this.quota.summary(
      userId,
      (Object.keys(BUCKETS) as AiBucket[]).map((b) => ({ feature: b, limitKey: BUCKETS[b].limit })),
    );
    return {
      available: this.client.enabled,
      /// Perguntas rápidas ao assistente
      questions: items.questions,
      /// Documentos lidos (recibos, etiquetas)
      scans: items.scans,
      /// Previsões e análises completas
      forecasts: items.forecasts,
      /// As quotas renovam pelo aniversário da ativação do plano (ou do registo)
      periodStart: period.start.toISOString(),
      resetsAt: period.end.toISOString(),
      /// Créditos comprados ou oferecidos: usam-se quando a quota acaba
      credits: await this.credits.balance(userId),
      creditProducts: creditProducts(),
      /// Limite curto: pedidos por janela de minutos (renova sozinho)
      burst: await this.burstState(userId, ent.rank),
      /// none | heavy (previsões em pausa) | all (IA em pausa) — só acontece
      /// no plano grátis, quando o custo global do mês chega perto do teto
      limited: await this.limitedFor(ent.rank),
    };
  }

  /// Confirma o plano, o teto global e a quota do período e reserva uma
  /// utilização. Com uma chave de idempotência repetida devolve a resposta
  /// guardada sem gastar nem cobrar outra vez.
  private async start(userId: string, feature: string, kind: AiKind, requestKey?: string) {
    const key = requestKey ? `${userId}:${requestKey}` : null;
    if (key) {
      const previous = await this.prisma.aiUsage.findUnique({ where: { requestKey: key }, select: { result: true } });
      if (previous?.result) return { replay: previous.result as Record<string, unknown>, record: async () => {}, finish: <T,>(v: T) => v };
    }
    await this.entitlements.assertFeature(userId, feature);
    if (!this.client.enabled) throw ApiException.unavailable('AI_NOT_CONFIGURED');
    const ent = await this.entitlements.forUser(userId);
    const bucket = bucketOf(kind);
    const limited = await this.limitedFor(ent.rank);
    if (limited === 'all' || (limited === 'heavy' && bucket === 'forecasts')) throw ApiException.unavailable('AI_BUDGET_REACHED');
    // Limite curto por pessoa (renova sozinho passados uns minutos).
    const burst = await this.redis.hit(`ai:burst:${userId}`, env().AI_BURST_WINDOW_MINUTES * 60);
    if (burst.count > this.burstLimit(ent.rank)) {
      const minutes = Math.max(1, Math.ceil(burst.ttl / 60));
      throw ApiException.tooManyRequests('AI_RATE_LIMIT', { minutes }, { retryAfterSeconds: burst.ttl, limit: this.burstLimit(ent.rank), windowMinutes: env().AI_BURST_WINDOW_MINUTES });
    }
    // A quota do período; quando acaba, um crédito comprado.
    let reservation: { release: () => Promise<void> };
    try {
      reservation = await this.quota.reserve(userId, bucket, BUCKETS[bucket].limit);
    } catch (err) {
      if (!(err instanceof ApiException) || err.code !== 'AI_QUOTA_REACHED') throw err;
      const credit = await this.credits.spendOne(userId, bucket);
      if (!credit.spent) {
        const details = (err.details ?? {}) as Record<string, unknown>;
        throw ApiException.forbidden('AI_QUOTA_REACHED', err.params, { ...details, credits: 0, creditProducts: creditProducts() });
      }
      reservation = { release: credit.release };
    }
    let usageId: string | null = null;
    let recorded = false;
    const meter = {
      replay: null as Record<string, unknown> | null,
      /// Chamar depois da resposta do modelo (custo e tokens).
      record: async (model: string, inputTokens: number, outputTokens: number) => {
        recorded = true;
        const cost = estimateCost(model, inputTokens, outputTokens);
        const row = await this.prisma.aiUsage.create({ data: { userId, kind, inputTokens, outputTokens, costUsd: cost.toFixed(6), requestKey: key } });
        usageId = row.id;
        this.budget.add(cost);
      },
      /// Guarda a resposta para a devolver igual se o pedido se repetir.
      finish: async <T,>(value: T): Promise<T> => {
        if (key && usageId) await this.prisma.aiUsage.update({ where: { id: usageId }, data: { result: value as object } }).catch(() => undefined);
        return value;
      },
      /// A chamada falhou antes de haver resposta: a utilização volta atrás.
      release: async () => {
        if (!recorded) await reservation.release();
      },
    };
    return meter;
  }

  /// Corre uma ação de IA com a quota reservada; se falhar antes de haver
  /// resposta, a utilização não conta.
  private async metered<T>(userId: string, feature: string, kind: AiKind, requestKey: string | undefined, fn: (meter: Awaited<ReturnType<AiService['start']>>) => Promise<T>): Promise<T> {
    const meter = await this.start(userId, feature, kind, requestKey);
    if (meter.replay) return meter.replay as T;
    try {
      return await fn(meter);
    } catch (err) {
      await (meter as { release?: () => Promise<void> }).release?.();
      throw err;
    }
  }

  private async model(userId: string) {
    return (await this.entitlements.hasFeature(userId, FEATURES.aiAdvanced)) ? env().AI_MODEL_ADVANCED : env().AI_MODEL;
  }

  private async user(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, language: true, currency: true, country: true, timezone: true } });
    if (!user) throw ApiException.unauthorized('SESSION_EXPIRED');
    return { ...user, lang: resolveLanguage(user.language) };
  }

  /// Resumo das finanças da pessoa para o assistente (compacto).
  private async financialContext(userId: string, lang: ReturnType<typeof resolveLanguage>) {
    const [dashboard, trend] = await Promise.all([this.analytics.dashboard(userId), this.analytics.trend(userId, 3)]);
    const catName = (c: { category: { key: string | null; name: string | null } | null }) => (c.category ? (c.category.name ?? categoryName(c.category.key, lang)) : 'uncategorized');
    return {
      currency: dashboard.currency,
      today: dashboard.today,
      currentPeriod: dashboard.period,
      balances: {
        total: dashboard.balances.total,
        available: dashboard.balances.available,
        savings: dashboard.balances.savings,
        creditCardDebt: dashboard.balances.creditDebt,
        accounts: dashboard.balances.accounts.map((a) => ({ name: a.name, type: a.type, balance: a.balance, currency: a.currency })),
      },
      thisPeriod: {
        income: dashboard.month.income,
        expenses: dashboard.month.expense,
        savingsRatePercent: dashboard.month.savingsRate,
        expenseChangeVsLastPeriodPercent: dashboard.month.expenseChange,
        topExpenseCategories: dashboard.month.topCategories.map((c) => ({ category: catName(c), amount: c.amount, percent: c.percent })),
      },
      safeToSpendPerDay: dashboard.safeToSpend.perDay,
      budgets: dashboard.budgets.items.map((b) => ({ name: b.name, available: b.available, spent: b.spent, percent: b.percent, period: b.period })),
      goals: dashboard.goals.map((g) => ({ name: g.name, target: g.targetAmount, saved: g.saved, targetDate: g.targetDate, monthlyNeeded: g.monthlyNeeded })),
      upcomingPayments: dashboard.upcoming.items.map((u) => ({ description: u.description, amount: u.amount, currency: u.currency, date: u.date, type: u.type })),
      spaces: dashboard.spaces,
      last3Months: trend.points,
    };
  }

  private systemPrompt(lang: string, extra: string) {
    return [
      `You are the financial assistant inside "Contalexy", a personal finance app. Always answer in ${LANGUAGE_NAMES[lang] ?? 'English'}.`,
      'Be warm, concise and practical: short paragraphs or bullet points, concrete numbers from the data, and one clear next step when useful.',
      'Use the user\'s currency formatting. Never invent data that is not in the context; if something is missing, say so and suggest how to record it in the app.',
      'You give general budgeting and saving guidance only. Do not recommend buying or selling specific securities, crypto or financial products, and do not give tax or legal advice (suggest a professional for that).',
      // O que se lê na app tem de soar a uma pessoa: sem travessões, sem emojis, sem floreados.
      'Writing style: plain everyday sentences, the way a careful person writes. Never use em dashes or en dashes (use commas, colons or full stops instead), no emoji, no exclamation marks in a row and no filler openings or sign-offs.',
      // A app e o site mostram o texto tal como vem: nada de Markdown.
      'Plain text only, never Markdown: no asterisks or underscores for emphasis, no # headings, no backticks, no tables. For a list, start each line with "- " (hyphen and space). Do not bold the numbers; just write them.',
      // Em português a app trata por "tu" (português europeu), não por "você".
      'In Portuguese, use European Portuguese and address the user as "tu" (second person singular: "os teus gastos", "podes"), never "você", "o senhor" or "seus".',
      'Stay on personal finance and on how to use the app; politely decline unrelated requests.',
      extra,
    ].join('\n');
  }

  async chat(userId: string, messages: z.infer<typeof chatSchema>['messages'], requestKey?: string) {
    return this.metered(userId, FEATURES.aiAssistant, 'CHAT', requestKey, async (meter) => {
    const user = await this.user(userId);
    const context = await this.financialContext(userId, user.lang);
    const system = this.systemPrompt(user.lang, `The user is ${user.name.split(' ')[0]}. Their financial data (JSON):\n${JSON.stringify(context)}`);
    const last = messages[messages.length - 1];
    if (last.role !== 'user') throw ApiException.badRequest('INVALID_REQUEST');
    const model = await this.model(userId);
    const result = await this.client.complete({ model, system, messages: messages as AiMessage[], maxTokens: 700 });
    await meter.record(model, result.inputTokens, result.outputTokens);
    return meter.finish({ reply: plainText(result.text), usage: await this.usage(userId) });
    });
  }

  /// Previsão completa: como acaba o mês, quanto dá para poupar, quando se
  /// chega aos objetivos e o que pode correr mal. Os números vêm das contas
  /// do servidor (simulador + desperdícios); a IA só os explica e aconselha.
  async forecast(userId: string, question?: string, requestKey?: string) {
    return this.metered(userId, FEATURES.aiForecasts, 'FORECAST', requestKey, async (meter) => {
    const user = await this.user(userId);
    const [outlook, waste] = await Promise.all([this.simulator.outlook(userId), this.waste.waste(userId)]);
    const catName = (p: Record<string, unknown>) => (typeof p.name === 'string' && p.name ? p.name : typeof p.key === 'string' ? categoryName(p.key, user.lang) : null);
    const context = {
      currency: outlook.currency,
      today: outlook.today,
      currentMonth: outlook.period,
      numbersBasedOn: outlook.basis,
      typicalMonth: outlook.monthly,
      thisMonth: outlook.monthEnd,
      savingsPotential: outlook.savingsPotential,
      goals: outlook.goals.map((g) => ({ name: g.name, remaining: g.remaining, currency: g.currency, monthlySaving: g.monthly, estimatedDate: g.estimatedDate, targetDate: g.targetDate, onTrack: g.onTrack })),
      loans: outlook.loans,
      risks: outlook.risks.map((r) => ({ type: r.type, ...r.params })),
      next6Months: outlook.projection,
      spendingPatterns: waste.items.map((i) => ({ type: i.type, category: catName(i.params), ...i.params })),
      subscriptions: { count: waste.subscriptions.count, monthly: waste.subscriptions.monthly },
    };
    const system = this.systemPrompt(
      user.lang,
      [
        'Write a complete financial forecast for this user from the data below. Every number you mention must come from the data. Do not calculate new projections.',
        'Return ONLY JSON: {"headline": string (max 80 characters), "summary": string (2 or 3 sentences), "sections": [{"title": string, "detail": string (1 to 3 sentences with concrete numbers), "tone": "positive"|"warning"|"neutral"}], "actions": [string]}.',
        'Sections (4 to 6), in this order when the data allows: how this month should end; how much they can save; when each goal should be reached; spending versus the monthly plan; expenses or loans that could compromise the budget.',
        'Actions: 2 to 4 short, concrete next steps the user can do in the app (set a category limit, adjust the monthly plan, move money to a goal, review subscriptions…).',
        'If there is little data yet, say so honestly and explain what to record to get a better forecast.',
      ].join('\n'),
    );
    const model = await this.model(userId);
    const result = await this.client.complete({
      model,
      system,
      messages: [{ role: 'user', content: `${question ? `My question: ${question}\n` : ''}My data (JSON):\n${JSON.stringify(context)}` }],
      maxTokens: 1400,
    });
    await meter.record(model, result.inputTokens, result.outputTokens);
    const parsed = forecastOutputSchema.safeParse(extractJson(result.text));
    const usage = await this.usage(userId);
    if (!parsed.success || (!parsed.data.summary && !parsed.data.sections.length)) return meter.finish({ headline: '', summary: plainText(result.text), sections: [], actions: [], usage });
    return meter.finish({ ...parsed.data, headline: plainText(parsed.data.headline), summary: plainText(parsed.data.summary), sections: parsed.data.sections.map((x) => ({ ...x, title: plainText(x.title), detail: plainText(x.detail) })), actions: parsed.data.actions.map(plainText), usage });
    });
  }

  /// Análise do mês: 3 a 5 observações com uma sugestão cada.
  async insights(userId: string, requestKey?: string) {
    return this.metered(userId, FEATURES.aiInsights, 'INSIGHTS', requestKey, async (meter) => {
    const user = await this.user(userId);
    const context = await this.financialContext(userId, user.lang);
    const system = this.systemPrompt(
      user.lang,
      'Return ONLY JSON: {"summary": string (2 sentences), "insights": [{"title": string, "detail": string, "tone": "positive"|"warning"|"neutral"}] (3 to 5 items)}.',
    );
    const model = await this.model(userId);
    const result = await this.client.complete({
      model,
      system,
      messages: [{ role: 'user', content: `Analyse my current month and give me insights.\n${JSON.stringify(context)}` }],
      maxTokens: 900,
    });
    await meter.record(model, result.inputTokens, result.outputTokens);
    const parsed = z
      .object({
        summary: z.string().catch(''),
        insights: z.array(z.object({ title: z.string(), detail: z.string(), tone: z.enum(['positive', 'warning', 'neutral']).catch('neutral') })).catch([]),
      })
      .safeParse(extractJson(result.text));
    if (!parsed.success || !parsed.data.insights.length) return meter.finish({ summary: plainText(result.text), insights: [], usage: await this.usage(userId) });
    return meter.finish({ summary: plainText(parsed.data.summary), insights: parsed.data.insights.map((x) => ({ ...x, title: plainText(x.title), detail: plainText(x.detail) })), usage: await this.usage(userId) });
    });
  }

  /// "Viagem a Paris em março, 4 dias, 2 pessoas, 1500 €" → plano com itens e estimativas.
  async planDraft(userId: string, input: PlanDraftInput, requestKey?: string) {
    return this.metered(userId, FEATURES.aiPlans, 'PLAN', requestKey, async (meter) => {
    const user = await this.user(userId);
    const currency = input.currency ?? user.currency;
    const system = this.systemPrompt(
      user.lang,
      [
        'Create a realistic financial plan (trip, event, project, purchase, shopping list, small business, moving house, course or vehicle) from the user request.',
        `Use realistic prices for the user's country (${user.country}) in ${currency}. Today is ${todayIn(user.timezone)}.`,
        `Return ONLY JSON: {"name": string, "type": one of ${JSON.stringify(PLAN_TYPES)}, "description": string, "budget": number|null, "startDate": "YYYY-MM-DD"|null, "endDate": "YYYY-MM-DD"|null,`,
        `"items": [{"title": string, "quantity": integer, "estimatedAmount": number (total for the line), "kind": "COST"|"MONTHLY_COST"|"REVENUE"|"RESERVE", "categoryKey": one of ${JSON.stringify(EXPENSE_KEYS)} or null, "notes": string|null}]}`,
        'Between 4 and 20 items, ordered by when they happen. Titles and notes in the user language.',
        'Item "kind" is always "COST", except in type BUSINESS: "COST" = one-off start-up cost (stock, ads, packaging, transport…), "MONTHLY_COST" = cost that repeats every month, "REVENUE" = expected revenue (units × sale price as estimatedAmount; say the units and price in notes), "RESERVE" = safety reserve.',
        'For BUSINESS include at least one REVENUE item and one RESERVE item and, when a capital amount is given, keep COST + MONTHLY_COST + RESERVE within that capital.',
      ].join('\n'),
    );
    const details = {
      request: input.prompt,
      type: input.type ?? null,
      budget: input.budget ?? null,
      capital: input.capital ?? null,
      currency,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      people: input.people ?? null,
    };
    const model = await this.model(userId);
    const result = await this.client.complete({ model, system, messages: [{ role: 'user', content: JSON.stringify(details) }], maxTokens: 2000 });
    await meter.record(model, result.inputTokens, result.outputTokens);
    const parsed = draftOutputSchema.safeParse(extractJson(result.text));
    if (!parsed.success) throw ApiException.unavailable('AI_FAILED');
    const d = parsed.data;
    const draft = {
      name: d.name,
      type: input.type ?? d.type,
      description: d.description ?? null,
      budget: input.budget ?? (d.budget ? round2(d.budget) : null),
      capital: input.capital ?? null,
      currency,
      startDate: d.startDate && isDateOnly(d.startDate) ? d.startDate : (input.startDate && isDateOnly(input.startDate) ? input.startDate : null),
      endDate: d.endDate && isDateOnly(d.endDate) ? d.endDate : (input.endDate && isDateOnly(input.endDate) ? input.endDate : null),
      items: d.items.map((i) => ({
        title: i.title,
        quantity: i.quantity,
        estimatedAmount: i.estimatedAmount !== null ? round2(i.estimatedAmount) : null,
        // Só os planos de negócio têm receitas/reserva; nos outros é tudo custo.
        kind: (input.type ?? d.type) === 'BUSINESS' ? i.kind : ('COST' as const),
        categoryKey: i.categoryKey && EXPENSE_KEYS.includes(i.categoryKey) ? i.categoryKey : null,
        notes: i.notes,
      })),
    };
    if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) draft.endDate = null;
    if (input.save) {
      const plan = await this.plans.create(userId, { ...draft, items: draft.items.map((i) => ({ ...i, isDone: false })) }, { aiGenerated: true });
      return meter.finish({ draft, plan, usage: await this.usage(userId) });
    }
    return meter.finish({ draft, plan: null, usage: await this.usage(userId) });
    });
  }

  private async imageBlock(file: UploadedFileLike, mimeType: string) {
    if (mimeType === 'application/pdf') {
      return { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: file.buffer.toString('base64') } };
    }
    if (!VISION_TYPES.includes(mimeType) || file.size > 5 * 1024 * 1024) throw ApiException.badRequest('SCAN_FAILED');
    return { type: 'image' as const, source: { type: 'base64' as const, media_type: mimeType, data: file.buffer.toString('base64') } };
  }

  /// Ler um recibo/fatura → valores para pré-preencher a despesa.
  async scanReceipt(userId: string, file: UploadedFileLike | undefined, requestKey?: string) {
    return this.metered(userId, FEATURES.scannerReceipts, 'RECEIPT_SCAN', requestKey, async (meter) => {
    const user = await this.user(userId);
    const mimeType = this.storage.validate(file);
    const block = await this.imageBlock(file as UploadedFileLike, mimeType);
    const attachment = await this.attachments.upload(userId, file, 'RECEIPT');
    const system = [
      'You read receipts and invoices. Extract the data exactly as printed.',
      `Return ONLY JSON: {"merchant": string|null, "date": "YYYY-MM-DD"|null, "total": number|null (final amount paid), "currency": ISO 4217|null, "categoryKey": one of ${JSON.stringify(EXPENSE_KEYS)} or null, "items": [{"name": string, "quantity": number|null, "price": number|null (the line total actually charged, after discounts)}], "confidence": number 0..1}.`,
      `List every purchased product line (not subtotals, taxes or payment lines). If the currency is not printed, use null. The user is in ${user.country}. Item names as printed, in a clean readable form.`,
    ].join('\n');
    const model = await this.model(userId);
    const result = await this.client.complete({
      model,
      system,
      messages: [{ role: 'user', content: [block, { type: 'text', text: 'Extract this receipt.' }] }],
      maxTokens: 2500,
      temperature: 0,
    });
    await meter.record(model, result.inputTokens, result.outputTokens);
    const parsed = receiptSchema.safeParse(extractJson(result.text));
    if (!parsed.success || parsed.data.total === null) {
      return meter.finish({ attachmentId: attachment.id, attachment, recognized: false, usage: await this.usage(userId) });
    }
    const r = parsed.data;
    const categoryKey = r.categoryKey && EXPENSE_KEYS.includes(r.categoryKey) ? r.categoryKey : null;
    const category = categoryKey ? await this.prisma.category.findFirst({ where: { userId, key: categoryKey, type: 'EXPENSE' }, select: { id: true } }) : null;
    return meter.finish({
      attachmentId: attachment.id,
      attachment,
      recognized: true,
      merchant: r.merchant,
      date: r.date && isDateOnly(r.date) ? r.date : null,
      total: round2(r.total ?? 0),
      currency: r.currency?.toUpperCase() ?? null,
      categoryKey,
      categoryId: category?.id ?? null,
      items: r.items,
      confidence: r.confidence,
      usage: await this.usage(userId),
    });
    });
  }

  /// Importação: quando as regras normais não percebem as colunas, a IA diz
  /// qual é a data, o valor, a descrição (conta como uma pergunta).
  async mapImportColumns(userId: string, columns: string[], sample: string[][], requestKey?: string) {
    return this.metered(userId, FEATURES.importSmart, 'CHAT', requestKey, async (meter) => {
      const model = await this.model(userId);
      const result = await this.client.complete({
        model,
        system:
          'You map bank statement columns. Reply ONLY with JSON: {"date":<index|null>,"amount":<index|null>,"debit":<index|null>,"credit":<index|null>,"description":<index|null>,"merchant":<index|null>,"category":<index|null>,"positiveIsExpense":<bool>,"monthFirst":<bool>}. Indexes are 0-based column positions. Use "amount" for a single signed column, or "debit"+"credit" for two columns. positiveIsExpense is true when positive numbers are spending (card statements). monthFirst is true when dates are month/day/year.',
        messages: [{ role: 'user', content: `Columns: ${JSON.stringify(columns)}
Rows: ${JSON.stringify(sample.slice(0, 8))}` }],
        maxTokens: 300,
        temperature: 0,
      });
      await meter.record(model, result.inputTokens, result.outputTokens);
      const parsed = z
        .object({
          date: z.number().int().nullable().catch(null),
          amount: z.number().int().nullable().catch(null),
          debit: z.number().int().nullable().catch(null),
          credit: z.number().int().nullable().catch(null),
          description: z.number().int().nullable().catch(null),
          merchant: z.number().int().nullable().catch(null),
          category: z.number().int().nullable().catch(null),
          positiveIsExpense: z.boolean().catch(false),
          monthFirst: z.boolean().catch(false),
        })
        .safeParse(extractJson(result.text));
      const clamp = (i: number | null) => (i !== null && i >= 0 && i < columns.length ? i : null);
      const m = parsed.success ? parsed.data : { date: null, amount: null, debit: null, credit: null, description: null, merchant: null, category: null, positiveIsExpense: false, monthFirst: false };
      return meter.finish({ date: clamp(m.date), amount: clamp(m.amount), debit: clamp(m.debit), credit: clamp(m.credit), description: clamp(m.description), merchant: clamp(m.merchant), category: clamp(m.category), positiveIsExpense: m.positiveIsExpense, monthFirst: m.monthFirst, usage: await this.usage(userId) });
    });
  }

  /// Ler uma etiqueta de preço → produto, preço, unidade (para o histórico).
  async scanPrice(userId: string, file: UploadedFileLike | undefined, requestKey?: string) {
    return this.metered(userId, FEATURES.scannerPrices, 'PRICE_SCAN', requestKey, async (meter) => {
    const user = await this.user(userId);
    const mimeType = this.storage.validate(file, { imagesOnly: true });
    const block = await this.imageBlock(file as UploadedFileLike, mimeType);
    const attachment = await this.attachments.upload(userId, file, 'PRICE_TAG');
    const system = [
      'You read supermarket/store price tags and shelf labels.',
      'Return ONLY JSON: {"productName": string, "brand": string|null, "price": number (the main price to pay), "currency": ISO 4217|null, "quantity": number|null (package size), "unit": "un"|"kg"|"g"|"l"|"ml"|null, "storeName": string|null, "confidence": number 0..1}.',
      `The user is in ${user.country}. Product name as printed, in a clean readable form.`,
    ].join('\n');
    const model = await this.model(userId);
    const result = await this.client.complete({
      model,
      system,
      messages: [{ role: 'user', content: [block, { type: 'text', text: 'Read this price tag.' }] }],
      maxTokens: 600,
      temperature: 0,
    });
    await meter.record(model, result.inputTokens, result.outputTokens);
    const parsed = priceSchema.safeParse(extractJson(result.text));
    if (!parsed.success) return meter.finish({ attachmentId: attachment.id, attachment, recognized: false, usage: await this.usage(userId) });
    const p = parsed.data;
    // O que já pagaste por este produto (para comparar logo).
    const previous = await this.prisma.priceRecord.findMany({
      where: { userId, normalizedName: normalizeProductName(p.productName) },
      orderBy: { date: 'desc' },
      take: 5,
    });
    return meter.finish({
      attachmentId: attachment.id,
      attachment,
      recognized: true,
      productName: p.productName,
      brand: p.brand,
      price: round2(p.price),
      currency: p.currency?.toUpperCase() ?? user.currency,
      quantity: p.quantity,
      unit: p.unit,
      storeName: p.storeName,
      confidence: p.confidence,
      previous: previous.map((r) => ({ id: r.id, price: Number(r.price), currency: r.currency, storeName: r.storeName, date: r.date.toISOString().slice(0, 10) })),
      usage: await this.usage(userId),
    });
    });
  }
}
