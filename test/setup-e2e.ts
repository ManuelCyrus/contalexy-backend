// Testes de ponta a ponta: usam uma base de dados PRÓPRIA (nunca a de
// desenvolvimento). Cria-a e aplica o esquema antes:
//   DATABASE_URL=<url da rumo_test> npx prisma migrate reset --force
import 'dotenv/config';

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? 'postgresql://postgres:postgres@localhost:5432/rumo_test?schema=public';
process.env.NODE_ENV = 'test';
process.env.JOBS_ENABLED = 'false';
process.env.EXCHANGE_RATES_ENABLED = 'false';
process.env.BILLING_DEV_GRANTS = 'true';
process.env.PROMOTIONS_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = '';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-0123456789-0123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret-0123456789-0123456789';
process.env.UPLOADS_DIR = 'uploads-test';
process.env.REVENUECAT_WEBHOOK_AUTH = 'test-webhook-secret';
process.env.AI_MONTHLY_BUDGET_USD = '0';
process.env.ADMIN_EMAILS = '';
process.env.AI_BURST_LIMIT_FREE = '50';
