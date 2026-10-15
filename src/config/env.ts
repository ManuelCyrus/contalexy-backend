import { z } from 'zod';

/// Variáveis de ambiente — validadas ao arrancar (um erro claro em vez de
/// falhas estranhas mais tarde). Tudo o que é opcional desliga a
/// funcionalidade correspondente (IA, push, email, pagamentos…).
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL em falta'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET precisa de 32+ caracteres'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET precisa de 32+ caracteres'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(60),
  APP_PUBLIC_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('*'),

  // Ficheiros (recibos, fotos). "local" guarda em ./uploads.
  /// local (pasta UPLOADS_DIR) | s3 (DigitalOcean Spaces ou qualquer S3)
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  /// DigitalOcean Spaces: https://<região>.digitaloceanspaces.com
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  /// Endereço público (CDN) para os ficheiros públicos, ex.: https://<space>.<região>.cdn.digitaloceanspaces.com
  S3_PUBLIC_URL: z.string().default(''),
  /// Quanto tempo vale um endereço temporário para um ficheiro privado (segundos)
  S3_SIGNED_SECONDS: z.coerce.number().int().positive().default(900),
  /// Redis (cache, filas, limites de pedidos). Vazio = tudo em memória, só neste processo.
  REDIS_URL: z.string().default(''),
  /// Limite curto de IA (renova sozinho): pedidos por janela, por pessoa
  AI_BURST_WINDOW_MINUTES: z.coerce.number().int().positive().default(10),
  AI_BURST_LIMIT_FREE: z.coerce.number().int().positive().default(5),
  AI_BURST_LIMIT_PAID: z.coerce.number().int().positive().default(25),
  /// WhatsApp (integração oficial da Meta, Cloud API). Vazios = desligado.
  WHATSAPP_VERIFY_TOKEN: z.string().default(''),
  WHATSAPP_APP_SECRET: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  /// O número do negócio como as pessoas o veem (ex.: +351910000000)
  WHATSAPP_BUSINESS_NUMBER: z.string().default(''),
  WHATSAPP_API_VERSION: z.string().default('v20.0'),
  /// Créditos de IA à venda (compras únicas na loja): "produto:créditos,produto:créditos"
  AI_CREDIT_PRODUCTS: z.string().default('contalex_ai_credits_50:50,contalex_ai_credits_200:200'),
  UPLOADS_DIR: z.string().default('uploads'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),

  // Email (códigos para recuperar a palavra-passe). Sem chave: aparece no log.
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('Contalexy <noreply@contalex.app>'),
  /// Para onde vão as sugestões e problemas enviados pela app (vazio = só ficam na administração)
  SUPPORT_EMAIL: z.string().default(''),

  // Entrar com o Google: IDs de cliente OAuth aceites, separados por vírgulas
  // (o "Web client ID" que a app usa como serverClientId e, se quiseres, os
  // de Android/iOS). Vazio = o botão do Google responde "indisponível".
  GOOGLE_CLIENT_IDS: z.string().default(''),

  // Push (Firebase). Sem isto, as notificações ficam só dentro da app.
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // IA (Claude, da Anthropic). Sem chave, as funções de IA respondem "indisponível".
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  AI_MODEL_ADVANCED: z.string().default('claude-sonnet-5'),
  /// Teto global de custo da IA por mês, em USD (0 = sem teto). A 80% as
  /// funções mais pesadas (previsões, análises, planos) ficam em pausa para
  /// o plano grátis; a 100% fica toda a IA em pausa para o plano grátis.
  /// Quem paga não é afetado (tem os seus próprios limites mensais).
  AI_MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().default(0),
  /// Preço do modelo (USD por milhão de tokens) — só para estimar o custo.
  AI_PRICE_INPUT_PER_MTOK: z.coerce.number().nonnegative().default(1),
  AI_PRICE_OUTPUT_PER_MTOK: z.coerce.number().nonnegative().default(5),
  /// O mesmo para o modelo avançado (AI_MODEL_ADVANCED)
  AI_PRICE_ADVANCED_INPUT_PER_MTOK: z.coerce.number().nonnegative().default(3),
  AI_PRICE_ADVANCED_OUTPUT_PER_MTOK: z.coerce.number().nonnegative().default(15),

  // Pagamentos (RevenueCat — App Store, Google Play e web).
  REVENUECAT_WEBHOOK_AUTH: z.string().optional(),
  REVENUECAT_SECRET_API_KEY: z.string().optional(),
  /// Só para testes: deixa dar Premium a si próprio pela API.
  BILLING_DEV_GRANTS: z.string().default('false'),
  /// As compras de teste das lojas (sandbox) dão acesso? Tem de ficar a true
  /// para a revisão da Apple e para os testadores da Google Play.
  BILLING_ACCEPT_SANDBOX: z.string().default('true'),

  // Promoções do Premium
  PROMOTIONS_ENABLED: z.string().default('true'),
  /// Nunca mais do que uma promoção (de qualquer tipo) por X horas
  PROMOTIONS_GLOBAL_GAP_HOURS: z.coerce.number().nonnegative().default(20),

  // Câmbios
  EXCHANGE_RATES_URL: z.string().default('https://open.er-api.com/v6/latest/EUR'),
  EXCHANGE_RATES_ENABLED: z.string().default('true'),

  // Administração: emails (separados por vírgulas) que entram como administradores
  ADMIN_EMAILS: z.string().default(''),
  /// Comissão da loja a assumir no relatório de receita quando a loja não a
  /// comunica (0.15 = 15%). É só uma estimativa do que chega à conta.
  STORE_COMMISSION_DEFAULT: z.coerce.number().min(0).max(1).default(0.15),

  // Tarefas agendadas (desligar em testes)
  JOBS_ENABLED: z.string().default('true'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida (.env):\n${issues}`);
  }
  return parsed.data;
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/// Para os testes poderem mudar valores.
export function resetEnvCache() {
  cached = null;
}

export const isTrue = (value: string | undefined) => value === 'true' || value === '1';
