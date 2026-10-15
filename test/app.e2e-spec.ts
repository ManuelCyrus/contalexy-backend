import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { ExchangeService } from '../src/exchange/exchange.service';
import { AnthropicClient } from '../src/ai/anthropic.client';
import { GoogleVerifier } from '../src/google/google.verifier';
import { ApiException } from '../src/common/errors/api.exception';
import { LoansService } from '../src/loans/loans.service';
import { GoalDepositsService } from '../src/goals/goal-deposits.service';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { resetEnvCache } from '../src/config/env';
import { SubscriptionsService } from '../src/billing/subscriptions.service';
import { addDays, todayIn } from '../src/common/utils/dates';

/// IA de faz de conta (os testes não chamam a Anthropic): responde JSON
/// quando o pedido o exige e conta os tokens como um pedido pequeno.
const fakeAi = {
  enabled: false,
  calls: 0,
  async complete(input: { system: string }) {
    fakeAi.calls++;
    const json = input.system.includes('Return ONLY JSON');
    return {
      text: json ? '{"headline":"Mês equilibrado","summary":"Resumo de teste.","sections":[{"title":"Fim do mês","detail":"Deve sobrar dinheiro.","tone":"positive"}],"actions":["Rever subscrições"]}' : 'Resposta de teste.',
      inputTokens: 1000,
      outputTokens: 200,
    };
  },
};

/// Google de faz de conta (os testes não falam com a Google): o "token" é
/// "google:" seguido da identidade em JSON; qualquer outra coisa é recusada.
const fakeGoogle = {
  enabled: true,
  async verify(idToken: string) {
    if (!idToken.startsWith('google:')) throw ApiException.unauthorized('GOOGLE_TOKEN_INVALID');
    return JSON.parse(idToken.slice(7));
  },
};
const googleToken = (identity: { sub: string; email: string; emailVerified?: boolean; name?: string | null; picture?: string | null }) =>
  `google:${JSON.stringify({ emailVerified: true, name: null, picture: null, ...identity })}`;

/// Percurso completo da app contra uma base de dados PostgreSQL real.
describe('Contalexy API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now() % 1_000_000;
  /// O dia de hoje no fuso de quem faz os testes (todas as contas daqui estão em Lisboa):
  /// à meia-noite, o dia em UTC e o dia de Lisboa não são o mesmo.
  const today = todayIn('Europe/Lisbon');
  let T = '';
  let T2 = '';
  let userId = '';
  let bankId = '';
  let savingsId = '';
  let foodId = '';
  let salaryId = '';
  let transportId = '';

  const api = (lang = 'pt') => ({
    get: (url: string, token = T) => request(app.getHttpServer()).get(`/v1${url}`).set('Authorization', `Bearer ${token}`).set('Accept-Language', lang),
    post: (url: string, body?: object, token = T) => request(app.getHttpServer()).post(`/v1${url}`).set('Authorization', `Bearer ${token}`).set('Accept-Language', lang).send(body ?? {}),
    patch: (url: string, body: object, token = T) => request(app.getHttpServer()).patch(`/v1${url}`).set('Authorization', `Bearer ${token}`).set('Accept-Language', lang).send(body),
    put: (url: string, body: object, token = T) => request(app.getHttpServer()).put(`/v1${url}`).set('Authorization', `Bearer ${token}`).set('Accept-Language', lang).send(body),
    del: (url: string, token = T) => request(app.getHttpServer()).delete(`/v1${url}`).set('Authorization', `Bearer ${token}`).set('Accept-Language', lang),
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AnthropicClient).useValue(fakeAi).overrideProvider(GoogleVerifier).useValue(fakeGoogle).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('v1');
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    await app.init();
    prisma = app.get(PrismaService);
    app.get(ExchangeService).setRates({ USD: 1.1, BRL: 6, GBP: 0.85, AOA: 1000 });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registo, login e sessões', async () => {
    const reg = await api().post('/auth/register', {
      name: 'Manuel Teste', username: `manuel${stamp}`, email: `m${stamp}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt-PT', timezone: 'Europe/Lisbon',
    }, '');
    expect(reg.status).toBe(201);
    T = reg.body.data.accessToken;
    userId = reg.body.data.user.id;
    expect(reg.body.data.user).toMatchObject({ currency: 'EUR', language: 'pt', plan: { code: 'FREE' } });

    const dup = await api('de').post('/auth/register', { name: 'X', username: `manuel${stamp}`, email: `x${stamp}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'DE', language: 'de' }, '');
    expect(dup.body.error.code).toBe('USERNAME_TAKEN');
    expect(dup.body.error.message).toContain('Benutzername');

    // Idioma não suportado → inglês
    const es = await api().post('/auth/register', { name: 'Ana', username: `ana${stamp}`, email: `a${stamp}@ex.es`, password: 'segredo123', birthDate: '1990-05-20', country: 'ES', language: 'es-ES' }, '');
    expect(es.body.data.user.language).toBe('en');

    const login = await api().post('/auth/login', { login: `M${stamp}@EX.PT`, password: 'segredo123' }, '');
    expect(login.status).toBe(200);
    const refresh = await api().post('/auth/refresh', { refreshToken: login.body.data.refreshToken }, '');
    expect(refresh.status).toBe(200);
    const reuse = await api().post('/auth/refresh', { refreshToken: login.body.data.refreshToken }, '');
    expect(reuse.status).toBe(401);

    const manual = await api().patch('/me', { language: 'fr' });
    expect(manual.body.data).toMatchObject({ language: 'fr', languageSource: 'manual' });
  });

  it('contas, movimentos, transferências e saldos', async () => {
    const cats = await api().get('/categories');
    expect(cats.body.data).toHaveLength(17);
    expect(cats.body.data.some((c: { key: string }) => c.key === 'subscriptions')).toBe(true);
    foodId = cats.body.data.find((c: { key: string }) => c.key === 'food').id;
    salaryId = cats.body.data.find((c: { key: string }) => c.key === 'salary').id;
    transportId = cats.body.data.find((c: { key: string }) => c.key === 'transport').id;

    bankId = (await api().post('/accounts', { name: 'Banco', type: 'BANK', initialBalance: 1000 })).body.data.id;
    savingsId = (await api().post('/accounts', { name: 'Poupança', type: 'SAVINGS', initialBalance: 500 })).body.data.id;
    const usd = await api().post('/accounts', { name: 'Revolut USD', type: 'DIGITAL_WALLET', currency: 'USD', initialBalance: 110 });
    expect(usd.body.data.convertedBalance).toBe(100);

    await api().post('/transactions', { type: 'INCOME', amount: 1500, accountId: bankId, categoryId: salaryId, date: today, description: 'Salário' }).expect(201);
    const exp = await api().post('/transactions', { type: 'EXPENSE', amount: 42.35, accountId: bankId, categoryId: foodId, date: today, description: 'Pingo Doce', tags: ['#Casa'] });
    expect(exp.body.data.tags).toEqual(['casa']);
    const transfer = await api().post('/transactions', { type: 'TRANSFER', amount: 200, accountId: bankId, toAccountId: savingsId, date: today });
    expect(transfer.body.data.toAmount).toBe(200);
    const crossCurrency = await api().post('/transactions', { type: 'TRANSFER', amount: 100, accountId: bankId, toAccountId: usd.body.data.id, date: today });
    expect(crossCurrency.body.data.toAmount).toBe(110);

    const accounts = await api().get('/accounts');
    const bank = accounts.body.data.accounts.find((a: { id: string }) => a.id === bankId);
    expect(bank.balance).toBe(2157.65);
    expect(accounts.body.data.total).toBe(2157.65 + 700 + 200);

    const adjust = await api().post(`/accounts/${bankId}/adjust`, { balance: 2000 });
    expect(adjust.body.data.balance).toBe(2000);
    const summary = await api().get(`/transactions/summary?from=${today.slice(0, 8)}01&to=${today}`);
    // O ajuste não conta como despesa
    expect(summary.body.data.expense).toBe(42.35);

    const blocked = await api().del(`/accounts/${bankId}`);
    expect(blocked.body.error.code).toBe('ACCOUNT_HAS_TRANSACTIONS');
  });

  it('filtros, pesquisa, sugestões e exportação', async () => {
    const list = await api().get('/transactions?type=EXPENSE&q=pingo&tags=casa');
    expect(list.body.data).toHaveLength(1);
    const none = await api().get(`/transactions?categoryIds=none&type=EXPENSE`);
    expect(none.body.data.every((t: { category: unknown }) => t.category === null)).toBe(true);
    const range = await api().get('/transactions?minAmount=100&maxAmount=300&sort=amount_desc');
    expect(range.body.data.map((t: { amount: number }) => t.amount)).toEqual([200, 157.65, 100]); // inclui o ajuste de saldo
    const sug = await api().get('/transactions/suggest?description=Pingo%20Doce');
    expect(sug.body.data.categoryId).toBe(foodId);

    const freeExport = await api().get('/transactions/export?from=2020-01-01');
    expect(freeExport.status).toBe(403);
    expect(freeExport.body.error.details.feature).toBe('export.advanced');
    // A exportação sai no idioma da conta (aqui francês, escolhido acima).
    const csv = await api('en').get('/transactions/export');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Date;Type;Montant');
    expect(csv.text).toContain(';-42,35;');
    expect(csv.text).toContain('Ajustement du solde');
  });

  it('orçamentos com alertas (uma vez por limiar)', async () => {
    const b = await api().post('/budgets', { name: 'Comida', amount: 50, categoryIds: [foodId] });
    expect(b.body.data).toMatchObject({ spent: 42.35, status: 'WARNING' });
    await api().post('/transactions', { type: 'EXPENSE', amount: 10, accountId: bankId, categoryId: foodId, date: today }).expect(201);
    await new Promise((r) => setTimeout(r, 300));
    await api().post('/transactions', { type: 'EXPENSE', amount: 1, accountId: bankId, categoryId: foodId, date: today }).expect(201);
    await new Promise((r) => setTimeout(r, 300));
    const alerts = await prisma.notification.count({ where: { userId, type: 'budget_exceeded' } });
    expect(alerts).toBe(1);
    const premiumOnly = await api().post('/budgets', { name: 'Tudo', amount: 900, alertThresholds: [50] });
    expect(premiumOnly.body.error.code).toBe('PREMIUM_REQUIRED');
  });

  it('recorrentes: cria hoje, lembra e avança', async () => {
    const rec = await api().post('/recurring', { type: 'EXPENSE', amount: 15.99, accountId: bankId, description: 'Netflix', frequency: 'MONTHLY', startDate: today, kind: 'SUBSCRIPTION' });
    expect(rec.status).toBe(201);
    expect(rec.body.data.nextDate > today).toBe(true);
    const created = await prisma.transaction.count({ where: { recurringRuleId: rec.body.data.id } });
    expect(created).toBe(1);
    const manual = await api().post('/recurring', { type: 'EXPENSE', amount: 650, accountId: bankId, description: 'Renda', frequency: 'MONTHLY', startDate: today, autoCreate: false });
    const upcoming = await api().get('/recurring/upcoming?days=40');
    expect(upcoming.body.data.items.some((i: { ruleId: string }) => i.ruleId === manual.body.data.id)).toBe(true);
    const pay = await api().post(`/recurring/${manual.body.data.id}/pay`, {});
    expect(pay.body.data.transaction.amount).toBe(650);
    expect(pay.body.data.rule.nextDate > today).toBe(true);
  });

  it('objetivos e planos', async () => {
    const g = await api().post('/goals', { name: 'Férias', targetAmount: 1000, initialAmount: 100 });
    expect(g.body.data.saved).toBe(100);
    const done = await api().post(`/goals/${g.body.data.id}/contributions`, { amount: 900 });
    expect(done.body.data.status).toBe('COMPLETED');

    const plan = await api().post('/plans', { name: 'Porto', type: 'TRIP', budget: 300, items: [{ title: 'Comboio', estimatedAmount: 60, categoryKey: 'transport' }] });
    const paid = await api().post(`/plans/${plan.body.data.id}/items/${plan.body.data.items[0].id}/pay`, { accountId: bankId });
    expect(paid.body.data).toMatchObject({ spent: 60, remaining: 240 });
    expect(paid.body.data.transactions[0].category.key).toBe('transport');
  });

  it('Spaces: convite, divisão, saldos e acertos', async () => {
    const reg = await api().post('/auth/register', { name: 'Rui', username: `rui${stamp}`, email: `r${stamp}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'en' }, '');
    T2 = reg.body.data.accessToken;
    const space = await api().post('/spaces', { name: 'Casa', type: 'HOUSEHOLD' });
    const sid = space.body.data.id;
    await api().post(`/spaces/${sid}/invitations`, { username: `rui${stamp}` }).expect(201);
    const inv = await api().get('/space-invitations', T2);
    await api().post(`/space-invitations/${inv.body.data[0].id}/accept`, {}, T2).expect(200);

    const expense = await api().post(`/spaces/${sid}/expenses`, { title: 'Supermercado', amount: 90.01, addToMyExpenses: { accountId: bankId } });
    expect(expense.body.data.myShare).toBe(45.01);
    const mine = await prisma.transaction.findFirst({ where: { spaceExpenseId: expense.body.data.id } });
    expect(Number(mine?.amount)).toBe(45.01);

    const balances = await api().get(`/spaces/${sid}/balances`, T2);
    expect(balances.body.data.myBalance).toBe(-45);
    expect(balances.body.data.suggested[0].amount).toBe(45);
    const leave = await api('en').post(`/spaces/${sid}/leave`, {}, T2);
    expect(leave.body.error.code).toBe('SPACE_BALANCE_NOT_SETTLED');
    const settle = await api().post(`/spaces/${sid}/settlements`, { toUserId: userId, amount: 45 }, T2);
    expect(settle.body.data.myBalance).toBe(0);
    await api().post(`/spaces/${sid}/leave`, {}, T2).expect(200);

    // Entrar com o código (em minúsculas e com espaços à volta também serve).
    const casa = await api().get(`/spaces/${sid}`);
    const code: string = casa.body.data.inviteCode;
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    const joined = await api().post('/spaces/join', { code: ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()} ` }, T2);
    expect(joined.body.error).toBeUndefined();
    expect(joined.body.data.id).toBe(sid);
    expect((await api().post('/spaces/join', { code: 'ZZZZ9999' }, T2)).body.error.code).toBe('INVITE_CODE_INVALID');
    await api().post(`/spaces/${sid}/leave`, {}, T2).expect(200);

    // Plano grátis: 2 Spaces — o terceiro já não dá.
    await api().post('/spaces', { name: 'Outro' }).expect(201);
    const third = await api().post('/spaces', { name: 'Mais um' });
    expect(third.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('painel, relatórios e calendário', async () => {
    const dash = await api().get('/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.data.month.expense).toBeGreaterThan(0);
    expect(typeof dash.body.data.safeToSpend.perDay).toBe('number');
    const overview = await api().get('/reports/overview');
    expect(overview.body.data.expenseByCategory.length).toBeGreaterThan(0);
    const old = await api().get('/reports/overview?from=2020-01-01&to=2020-01-31');
    expect(old.body.error.code).toBe('REPORT_RANGE_LIMIT');
    const cal = await api().get(`/calendar?month=${today.slice(0, 7)}`);
    expect(cal.body.data.totals.expense).toBeGreaterThan(0);
    const merchants = await api().get('/reports/merchants');
    expect(merchants.body.error.code).toBe('PREMIUM_REQUIRED');
  });

  it('promoções sem spam', async () => {
    expect((await api().get('/promotions/next?placement=DASHBOARD')).body.data).toBeNull(); // conta nova
    await prisma.user.update({ where: { id: userId }, data: { createdAt: new Date(Date.now() - 10 * 86_400_000) } });
    const first = await api().get('/promotions/next?placement=DASHBOARD');
    expect(first.body.data.key).toBe('dashboard_premium');
    expect((await api().get('/promotions/next?placement=DASHBOARD&context=busy')).body.data).toBeNull();
    await api().post('/promotions/dashboard_premium/seen').expect(200);
    // Depois de vista, não volta logo (nem outra qualquer, pelo intervalo global)
    expect((await api().get('/promotions/next?placement=DASHBOARD')).body.data).toBeNull();
    expect((await api().get('/promotions/next?placement=REPORTS')).body.data).toBeNull();
  });

  it('Premium: limites, regras automáticas, preços e IA', async () => {
    // O assistente existe no plano grátis (com limite mensal); o que é só do
    // Premium continua fechado.
    const freeUsage = await api().get('/ai/usage');
    expect(freeUsage.body.data).toMatchObject({ available: false, questions: { used: 0, limit: 15 }, scans: { limit: 10 }, forecasts: { limit: 4 } });
    const rulesFree = await api().post('/rules', { value: 'uber', categoryId: transportId });
    expect(rulesFree.status).toBe(403);
    const grant = await api().post('/billing/dev/grant', { plan: 'PREMIUM', days: 30 });
    expect(grant.body.data).toMatchObject({ plan: 'PREMIUM', state: 'PREMIUM' });
    expect((await api().get('/promotions/next?placement=REPORTS')).body.data).toBeNull(); // Premium não vê promoções

    await api().post('/rules', { value: 'uber', categoryId: transportId }).expect(201);
    const uber = await api().post('/transactions', { type: 'EXPENSE', amount: 7.5, accountId: bankId, date: today, description: 'Uber casa' });
    expect(uber.body.data.category.key).toBe('transport');

    await api().post('/prices', { productName: 'Leite Mimosa 1 L', price: 0.99, quantity: 1, unit: 'l', storeName: 'Continente' }).expect(201);
    await api().post('/prices', { productName: 'leite mimosa 1l', price: 1.09, storeName: 'Pingo Doce' }).expect(201);
    const products = await api().get('/prices');
    expect(products.body.data[0]).toMatchObject({ count: 2, minPrice: 0.99, change: 10.1 });

    const noKey = await api().post('/ai/chat', { messages: [{ role: 'user', content: 'Olá' }] });
    expect(noKey.body.error.code).toBe('AI_NOT_CONFIGURED');
    const usage = await api().get('/ai/usage');
    expect(usage.body.data.questions.limit).toBe(150);
  });

  it('empréstimos: emprestar, devolver em partes, lembretes e fixar', async () => {
    const due = addDays(today, 3);
    const lent = await api().post('/loans', { direction: 'LENT', personName: 'João', amount: 100, dueDate: due, accountId: bankId, registerTransaction: true, remindDaysBefore: [3, 1], pinned: true });
    expect(lent.status).toBe(201);
    const loanId = lent.body.data.id;
    expect(lent.body.data).toMatchObject({ remaining: 100, daysUntilDue: 3, pinned: true, status: 'OPEN', overdue: false });
    // O dinheiro saiu da conta, mas emprestar não é uma despesa.
    const moved = await prisma.transaction.findFirst({ where: { loanId } });
    expect(moved).toMatchObject({ type: 'EXPENSE', excludeFromReports: true });
    const borrowed = await api().post('/loans', { direction: 'BORROWED', personName: 'Mãe', amount: 50 });
    expect(borrowed.status).toBe(201);
    const list = await api().get('/loans');
    expect(list.body.data.summary).toMatchObject({ owedToMe: 100, iOwe: 50, openCount: 2, overdueCount: 0 });
    expect(list.body.data.summary.nextDue).toMatchObject({ loanId, daysUntilDue: 3 });
    expect(list.body.data.items[0].id).toBe(loanId); // o fixado vem primeiro

    // Lembrete "faltam 3 dias": sai uma vez só.
    const loans = app.get(LoansService);
    const noon = new Date(`${today}T12:00:00Z`);
    await loans.sendReminders(noon);
    await loans.sendReminders(noon);
    expect(await prisma.notification.count({ where: { userId, type: 'loan_lent_due_soon' } })).toBe(1);
    // De madrugada não se manda nada.
    await prisma.loanReminder.deleteMany({ where: { loanId } });
    await loans.sendReminders(new Date(`${today}T02:00:00Z`));
    expect(await prisma.loanReminder.count({ where: { loanId } })).toBe(0);

    const tooMuch = await api('en').post(`/loans/${loanId}/payments`, { amount: 150 });
    expect(tooMuch.body.error.code).toBe('LOAN_PAYMENT_TOO_HIGH');
    const part = await api().post(`/loans/${loanId}/payments`, { amount: 40, accountId: bankId });
    expect(part.body.data).toMatchObject({ paid: 40, remaining: 60, status: 'OPEN', progress: 40 });
    const rest = await api().post(`/loans/${loanId}/payments`, { amount: 60 });
    expect(rest.body.data.status).toBe('SETTLED');
    const reopened = await api().del(`/loans/${loanId}/payments/${rest.body.data.payments[0].id}`);
    expect(reopened.body.data).toMatchObject({ status: 'OPEN', remaining: 60 });

    const dash = await api().get('/dashboard');
    expect(dash.body.data.loans).toMatchObject({ openCount: 2, owedToMe: 60, iOwe: 50 });
    expect(dash.body.data.loans.pinned[0].id).toBe(loanId);
    expect(dash.body.data.insights.some((i: { type: string }) => i.type === 'loan_to_receive')).toBe(true);
    const cal = await api().get(`/calendar?month=${due.slice(0, 7)}`);
    expect(cal.body.data.days.find((d: { date: string }) => d.date === due).loans[0]).toMatchObject({ id: loanId, remaining: 60 });

    const forgiven = await api().patch(`/loans/${borrowed.body.data.id}`, { status: 'CANCELLED' });
    expect(forgiven.body.data.status).toBe('CANCELLED');
    expect((await api().get('/loans')).body.data.summary.openCount).toBe(1);
  });

  it('plano mensal: planeado vs. real, sugestão e aviso ao passar', async () => {
    const empty = await api().get('/monthly-plans/current');
    expect(empty.body.data).toMatchObject({ exists: false, plan: null });
    expect(empty.body.data.suggestion).toBeTruthy();
    const key = empty.body.data.period.key;

    const dup = await api().put(`/monthly-plans/${key}`, { plannedIncome: 1500, lines: [{ categoryId: foodId, amount: 60 }, { categoryId: foodId, amount: 10 }] });
    expect(dup.body.error.code).toBe('MONTHLY_PLAN_DUPLICATE_LINE');
    const saved = await api().put(`/monthly-plans/${key}`, {
      plannedIncome: 1500,
      plannedSavings: 100,
      lines: [{ categoryId: foodId, amount: 60 }, { categoryId: transportId, amount: 100 }, { name: 'Prendas', amount: 40 }],
    });
    expect(saved.status).toBe(200);
    const plan = saved.body.data.plan;
    // Rendimento − despesas previstas − poupança = dinheiro livre
    expect(plan).toMatchObject({ plannedExpenses: 200, plannedFree: 1200, status: 'WARNING' });
    const food = plan.lines.find((l: { categoryId: string }) => l.categoryId === foodId);
    expect(food).toMatchObject({ planned: 60, actual: 53.35, status: 'WARNING' });
    expect(plan.lines.find((l: { kind: string }) => l.kind === 'CUSTOM')).toMatchObject({ name: 'Prendas', actual: null });

    // Passar o planeado avisa uma vez (não a cada despesa).
    await api().post('/transactions', { type: 'EXPENSE', amount: 10, accountId: bankId, categoryId: foodId, date: today }).expect(201);
    await new Promise((r) => setTimeout(r, 400));
    await api().post('/transactions', { type: 'EXPENSE', amount: 2, accountId: bankId, categoryId: foodId, date: today }).expect(201);
    await new Promise((r) => setTimeout(r, 400));
    expect(await prisma.notification.count({ where: { userId, type: 'plan_line_exceeded' } })).toBe(1);
    const after = await api().get(`/monthly-plans/${key}`);
    expect(after.body.data.plan).toMatchObject({ status: 'EXCEEDED', overCount: 1 });
    const dash = await api().get('/dashboard');
    expect(dash.body.data.monthlyPlan).toMatchObject({ exists: true, plannedExpenses: 200, overCount: 1 });

    // Só se planeia o mês atual e os seguintes: o mês passado fica fechado.
    const lastKey = addDays(empty.body.data.period.start, -1).slice(0, 7);
    const closed = await api().put(`/monthly-plans/${lastKey}`, { plannedIncome: 1000, lines: [] });
    expect(closed.body.error.code).toBe('MONTHLY_PLAN_CLOSED');
    expect((await api().post(`/monthly-plans/${lastKey}/copy-previous`)).body.error.code).toBe('MONTHLY_PLAN_CLOSED');
    const past = await api().get(`/monthly-plans/${lastKey}`);
    expect(past.body.data).toMatchObject({ exists: false, suggestion: null, period: { isPast: true, editable: false } });
    expect(after.body.data.period).toMatchObject({ isCurrent: true, isPast: false, editable: true });

    const nextKey = addDays(empty.body.data.period.end, 1).slice(0, 7);
    expect((await api().get(`/monthly-plans/${nextKey}`)).body.data.period).toMatchObject({ isFuture: true, editable: true });
    const copied = await api().post(`/monthly-plans/${nextKey}/copy-previous`);
    expect(copied.body.data.plan.lines).toHaveLength(3);
    expect(copied.body.data.plan.plannedIncome).toBe(1500);
    const history = await api().get('/monthly-plans');
    expect(history.body.data.items.map((i: { key: string }) => i.key)).toEqual([nextKey, key]);
    await api().del(`/monthly-plans/${nextKey}`).expect(200);
  });

  it('simulador "e se…" e análise de desperdícios (contas do servidor, sem IA)', async () => {
    const calls = fakeAi.calls;
    const out = await api().get('/simulator/outlook');
    expect(out.status).toBe(200);
    expect(out.body.data.basis).toMatchObject({ hasPlan: true, income: 'plan', expenses: 'plan' });
    expect(out.body.data.monthly).toMatchObject({ income: 1500, expenses: 200, savings: 100, free: 1200 });
    expect(out.body.data.projection).toHaveLength(7);
    expect(out.body.data.risks.some((r: { type: string }) => r.type === 'category_over_plan')).toBe(true);

    const buy = await api().post('/simulator/purchase', { amount: 1200, monthsFromNow: 2, monthlySaving: 150 });
    expect(buy.status).toBe(200);
    const now = buy.body.data.now;
    expect(now.purchase).toBe(1200);
    expect(now.remaining).toBeCloseTo(now.remainingWithoutPurchase - 1200, 2);
    expect(now.remaining).toBeCloseTo(now.balance + now.expectedIncome - now.expectedExpenses - now.plannedSavings - now.loanRepayments - 1200, 2);
    expect(['OK', 'TIGHT', 'AFFECTS_GOALS', 'NOT_AFFORDABLE']).toContain(now.verdict);
    expect(buy.body.data.later.monthsFromNow).toBe(2);
    // Daqui a 2 meses há mais 2 × 1200 livres do que agora
    expect(buy.body.data.later.remaining).toBeCloseTo(now.remaining + 2400, 2);
    expect(buy.body.data.saving).toMatchObject({ monthly: 150, months: 8, feasible: true });
    expect(buy.body.data.options.find((o: { months: number }) => o.months === 6).monthly).toBe(200);
    expect(buy.body.data.projection).toHaveLength(13);

    const goal = await api().post('/simulator/goal', { targetAmount: 1200, saved: 300, monthlySaving: 150, unexpectedExpense: 300 });
    expect(goal.body.data).toMatchObject({ remaining: 900, months: 6, feasible: true });
    expect(goal.body.data.withUnexpected).toMatchObject({ months: 8, delayMonths: 2 });
    expect(goal.body.data.scenarios.find((x: { monthly: number }) => x.monthly === 300).months).toBe(3);
    expect(goal.body.data.timeline).toHaveLength(6);

    const longer = await api().post('/simulator/forecast', { months: 12, expenseChangePercent: -10, oneOffs: [{ month: 3, amount: 500 }, { month: 5, amount: -200 }] });
    expect(longer.body.data.months).toHaveLength(13);
    expect(longer.body.data.adjusted.expenses).toBe(180);
    // Simulações longas são do Premium; o essencial é grátis.
    const freeLong = await api().post('/simulator/forecast', { months: 12 }, T2);
    expect(freeLong.body.error.code).toBe('PREMIUM_REQUIRED');
    expect(freeLong.body.error.details.feature).toBe('simulations.advanced');
    await api().post('/simulator/forecast', { months: 6, extraMonthlySaving: 50 }, T2).expect(200);
    await api().post('/simulator/purchase', { amount: 300 }, T2).expect(200);

    const waste = await api().get('/insights/waste');
    expect(waste.status).toBe(200);
    expect(waste.body.data.subscriptions).toMatchObject({ count: 1, monthly: 15.99 });
    expect(waste.body.data.items.find((i: { type: string }) => i.type === 'subscriptions').params).toMatchObject({ count: 1, yearly: 191.88 });
    // Nada disto gasta IA.
    expect(fakeAi.calls).toBe(calls);
  });

  it('acompanhamento: convidar alguém para ver os gastos do mês', async () => {
    const self = await api().post('/sharing/invitations', { username: `manuel${stamp}` });
    expect(self.body.error.code).toBe('CANNOT_INVITE_SELF');
    const invite = await api().post('/sharing/invitations', { username: `rui${stamp}`, scope: 'SUMMARY' });
    expect(invite.status).toBe(201);
    const id = invite.body.data.id;
    expect((await api().post('/sharing/invitations', { username: `rui${stamp}` })).body.error.code).toBe('SHARE_ALREADY_EXISTS');

    // Antes de aceitar, quem foi convidado ainda não vê nada.
    expect((await api().get(`/sharing/${id}/overview`, T2)).body.error.code).toBe('SHARE_NOT_ACTIVE');
    expect((await api().get('/sharing', T2)).body.data.pendingReceived).toBe(1);
    expect((await api().get('/dashboard', T2)).body.data.sharing.pendingReceived).toBe(1);
    await api().post(`/sharing/${id}/accept`, {}, T2).expect(200);
    expect(await prisma.notification.count({ where: { userId, type: 'sharing_accepted' } })).toBe(1);

    const overview = await api().get(`/sharing/${id}/overview`, T2);
    expect(overview.status).toBe(200);
    expect(overview.body.data.expenses).toBeGreaterThan(0);
    expect(overview.body.data.byCategory.length).toBeGreaterThan(0);
    expect(overview.body.data.plan.lines).toHaveLength(3);
    expect(overview.body.data.budgets[0]).toMatchObject({ name: 'Comida', status: 'EXCEEDED' });
    // Só gastos: nada de contas nem saldos.
    expect(JSON.stringify(overview.body.data)).not.toContain('Banco');
    expect(overview.body.data.balances).toBeUndefined();

    // "Resumo" não mostra a lista de movimentos; "Completo" mostra.
    expect((await api().get(`/sharing/${id}/transactions`, T2)).body.error.code).toBe('SHARE_SCOPE_SUMMARY');
    expect((await api().patch(`/sharing/${id}`, { scope: 'FULL' }, T2)).status).toBe(404); // só quem partilha decide
    await api().patch(`/sharing/${id}`, { scope: 'FULL' }).expect(200);
    const txs = await api().get(`/sharing/${id}/transactions?limit=5`, T2);
    expect(txs.body.data).toHaveLength(5);
    expect(txs.body.meta.nextOffset).toBe(5);
    expect(Object.keys(txs.body.data[0]).sort()).toEqual(['amount', 'category', 'currency', 'date', 'description', 'id', 'merchant', 'type']);
    // Quem acompanha só lê: não consegue mexer nos movimentos.
    expect((await api().del(`/transactions/${txs.body.data[0].id}`, T2)).status).toBe(404);

    const note = await api().post(`/sharing/${id}/notes`, { text: 'Tenta gastar menos em restaurantes 😉' }, T2);
    expect(note.body.data[0]).toMatchObject({ mine: true, text: 'Tenta gastar menos em restaurantes 😉' });
    expect((await api().get(`/sharing/${id}/notes`)).body.data[0].mine).toBe(false);
    expect(await prisma.notification.count({ where: { userId, type: 'sharing_note' } })).toBe(1);

    // Deixar de partilhar corta o acesso na hora.
    await api().del(`/sharing/${id}`).expect(200);
    expect((await api().get(`/sharing/${id}/overview`, T2)).status).toBe(404);

    // Convidar por email não revela de quem é o email (só depois de aceitar).
    const byEmail = await api().post('/sharing/invitations', { email: `r${stamp}@ex.pt` });
    expect(byEmail.body.data).toMatchObject({ person: null, email: `r${stamp}@ex.pt`, status: 'PENDING' });
    expect((await api().get('/sharing', T2)).body.data.received[0].person.username).toBe(`manuel${stamp}`);
    await api().post(`/sharing/${byEmail.body.data.id}/decline`, {}, T2).expect(200);
    expect((await api().get('/sharing')).body.data.given[0]).toMatchObject({ status: 'DECLINED', person: null });
    await api().del(`/sharing/${byEmail.body.data.id}`).expect(200);
  });

  it('planos: lista de compras (planeado vs. real), plano de negócio e fixar', async () => {
    const list = await api().post('/plans', {
      name: 'Compras da semana',
      type: 'SHOPPING',
      items: [{ title: 'Arroz', estimatedAmount: 2 }, { title: 'Frango', estimatedAmount: 6 }, { title: 'Fruta', estimatedAmount: 5 }],
    });
    const [rice, chicken] = list.body.data.items;
    const out = await api().post(`/plans/${list.body.data.id}/checkout`, { accountId: bankId, items: [{ itemId: rice.id, actualAmount: 2.4 }, { itemId: chicken.id, actualAmount: 7.1 }] });
    expect(out.status).toBe(200);
    // Uma só despesa com o total; 8 planeados, 9,50 reais
    expect(out.body.data).toMatchObject({ estimated: 13, spent: 9.5, actual: 9.5, actualDifference: 1.5, itemsDone: 2 });
    expect(out.body.data.transactions).toHaveLength(1);
    expect(out.body.data.transactions[0]).toMatchObject({ amount: 9.5, description: 'Compras da semana' });
    expect(out.body.data.transactions[0].category.key).toBe('shopping');

    // O exemplo do documento: capital 900, custos 700, reserva 200.
    const biz = await api().post('/plans', {
      name: 'Loja online',
      type: 'BUSINESS',
      capital: 900,
      items: [
        { title: 'Produtos', estimatedAmount: 400 },
        { title: 'Anúncios', estimatedAmount: 200 },
        { title: 'Embalagens', estimatedAmount: 50 },
        { title: 'Transporte', estimatedAmount: 50 },
        { title: 'Reserva', estimatedAmount: 200, kind: 'RESERVE' },
        { title: 'Vendas (40 × 25)', estimatedAmount: 1000, kind: 'REVENUE', quantity: 40 },
      ],
    });
    expect(biz.status).toBe(201);
    expect(biz.body.data.estimated).toBe(700);
    expect(biz.body.data.business).toMatchObject({ capital: 900, startupCosts: 700, reserve: 200, capitalNeeded: 900, capitalLeft: 0, expectedRevenue: 1000, expectedProfit: 300, marginPercent: 30 });
    // Previsto contra real: uma venda e um custo ligados ao plano
    await api().post('/transactions', { type: 'INCOME', amount: 250, accountId: bankId, date: today, description: 'Primeiras vendas', planId: biz.body.data.id }).expect(201);
    await api().post('/transactions', { type: 'EXPENSE', amount: 410, accountId: bankId, date: today, description: 'Produtos', planId: biz.body.data.id }).expect(201);
    const real = await api().get(`/plans/${biz.body.data.id}`);
    expect(real.body.data.business).toMatchObject({ actualRevenue: 250, actualCosts: 410, actualProfit: -160 });

    await api().patch(`/plans/${biz.body.data.id}`, { pinned: true }).expect(200);
    const plans = await api().get('/plans?status=active');
    expect(plans.body.data[0]).toMatchObject({ id: biz.body.data.id, pinned: true });
    const goal = await api().post('/goals', { name: 'Computador', targetAmount: 1200, initialAmount: 300, pinned: true });
    expect(goal.body.data.pinned).toBe(true);
    // "Falta pouco": avisa ao passar dos 90%
    await api().post(`/goals/${goal.body.data.id}/contributions`, { amount: 800 }).expect(201);
    expect(await prisma.notification.count({ where: { userId, type: 'goal_almost' } })).toBe(1);
  });

  it('planear: depósitos planeados, calendário, produtos das faturas e planos por mês', async () => {
    const reg = await api().post('/auth/register', { name: 'Nia Plano', username: `nia${stamp}`, email: `n${stamp}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt', timezone: 'Europe/Lisbon' }, '');
    const N = reg.body.data.accessToken;
    const nia = reg.body.data.user.id;
    const cats = await api().get('/categories', N);
    const food = cats.body.data.find((c: { key: string }) => c.key === 'food').id;
    const bank = (await api().post('/accounts', { name: 'Banco', type: 'BANK', initialBalance: 500 }, N)).body.data.id;
    const noon = new Date(`${today}T12:00:00Z`);
    const deposits = app.get(GoalDepositsService);
    type Day = { date: string; deposits: unknown[]; contributions: Array<Record<string, unknown>> };
    const dayOf = (body: { data: { days: Day[] } }) => body.data.days.find((d) => d.date === today) as Day;
    const byId = (body: { data: { deposits: Array<{ id: string; nextDate: string }> } }, id: string) => body.data.deposits.find((d) => d.id === id) as { id: string; nextDate: string };

    // --- Depósitos planeados num objetivo
    const goal = await api().post('/goals', { name: 'Casa', targetAmount: 1000 }, N);
    const gid = goal.body.data.id;
    expect((await api().post(`/goals/${gid}/deposits`, { amount: 100, date: addDays(today, -1) }, N)).body.error.code).toBe('DEPOSIT_DATE_PAST');
    const planned = await api().post(`/goals/${gid}/deposits`, { amount: 100, frequency: 'MONTHLY', date: today }, N);
    expect(planned.status).toBe(201);
    expect(planned.body.data).toMatchObject({ plannedMonthly: 100, saved: 0 });
    expect(planned.body.data.plannedDate).toBeTruthy();
    const monthly = planned.body.data.deposits[0];
    expect(monthly).toMatchObject({ amount: 100, frequency: 'MONTHLY', nextDate: today, due: true, overdue: false, autoApply: false });

    // No calendário, o dia fica marcado.
    const cal = await api().get(`/calendar?month=${today.slice(0, 7)}`, N);
    expect(dayOf(cal.body).deposits).toHaveLength(1);
    expect(cal.body.data.totals.plannedDeposits).toBeGreaterThanOrEqual(100);

    // "No dia 10 recebo o salário": fica marcado no calendário desse mês e entra sozinho.
    const payday = `${addDays(today, 40).slice(0, 8)}10`;
    await api().post('/recurring', { type: 'INCOME', amount: 1200, accountId: bank, description: 'Salário', frequency: 'MONTHLY', startDate: payday, kind: 'SALARY', autoCreate: true }, N).expect(201);
    const payMonth = await api().get(`/calendar?month=${payday.slice(0, 7)}`, N);
    const payDay = payMonth.body.data.days.find((d: { date: string }) => d.date === payday);
    expect(payDay.upcoming[0]).toMatchObject({ description: 'Salário', type: 'INCOME', amount: 1200, autoCreate: true });
    expect(payMonth.body.data.totals.plannedIncome).toBe(1200);

    // Lembra no dia, uma só vez.
    expect(await deposits.sendReminders(noon)).toBeGreaterThanOrEqual(1);
    await deposits.sendReminders(noon);
    expect(await prisma.notification.count({ where: { userId: nia, type: 'goal_deposit_due' } })).toBe(1);

    // "Depositei": entra no objetivo e passa para o mês seguinte.
    const confirmed = await api().post(`/goals/${gid}/deposits/${monthly.id}/confirm`, {}, N);
    expect(confirmed.body.data.saved).toBe(100);
    expect(confirmed.body.data.contributions[0]).toMatchObject({ amount: 100, planned: true });
    const next = byId(confirmed.body, monthly.id);
    expect(next.nextDate > today).toBe(true);
    expect(next).toMatchObject({ due: false });
    const cal2 = await api().get(`/calendar?month=${today.slice(0, 7)}`, N);
    expect(dayOf(cal2.body).deposits).toHaveLength(0);
    expect(dayOf(cal2.body).contributions[0]).toMatchObject({ amount: 100, planned: true });

    // Um depósito automático entra sozinho no dia (e avisa).
    const auto = await api().post(`/goals/${gid}/deposits`, { amount: 50, date: today, autoApply: true }, N);
    const autoId = auto.body.data.deposits.find((d: { autoApply: boolean }) => d.autoApply).id;
    expect(await deposits.runDue(noon)).toBeGreaterThanOrEqual(1);
    await deposits.runDue(noon);
    const after = await api().get(`/goals/${gid}`, N);
    expect(after.body.data.saved).toBe(150);
    expect(byId(after.body, autoId)).toMatchObject({ isActive: false });
    expect(await prisma.notification.count({ where: { userId: nia, type: 'goal_deposit_done' } })).toBe(1);

    // Saltar uma vez, ver o que aí vem, mudar e apagar.
    const skipped = await api().post(`/goals/${gid}/deposits/${monthly.id}/skip`, {}, N);
    expect(byId(skipped.body, monthly.id).nextDate > next.nextDate).toBe(true);
    const upcoming = await api().get('/goals/deposits/upcoming?days=100', N);
    expect(upcoming.body.data.items[0]).toMatchObject({ goalId: gid, name: 'Casa', amount: 100 });
    const edited = await api().patch(`/goals/${gid}/deposits/${monthly.id}`, { amount: 120, autoApply: true }, N);
    expect(byId(edited.body, monthly.id)).toMatchObject({ amount: 120, autoApply: true });
    expect((await api().del(`/goals/${gid}/deposits/${monthly.id}`, N)).body.data.plannedMonthly).toBe(0);

    // --- Produtos de uma fatura guardados com a despesa
    const tx = await api().post('/transactions', {
      type: 'EXPENSE', amount: 7.85, accountId: bank, categoryId: food, date: today, merchant: 'Mercado',
      items: [{ name: 'Leite meio-gordo', quantity: 2, price: 1.78 }, { name: 'Pão de forma', price: 1.99 }, { name: 'Café moído', quantity: 1, price: 4.08 }],
    }, N);
    expect(tx.status).toBe(201);
    expect(tx.body.data.items).toEqual([
      { name: 'Leite meio-gordo', quantity: 2, price: 1.78 },
      { name: 'Pão de forma', quantity: null, price: 1.99 },
      { name: 'Café moído', quantity: 1, price: 4.08 },
    ]);
    const search = `/transactions?q=${encodeURIComponent('café')}`;
    expect((await api().get(search, N)).body.data.map((t: { id: string }) => t.id)).toContain(tx.body.data.id);
    const kept = await api().patch(`/transactions/${tx.body.data.id}`, { note: 'ok' }, N);
    expect(kept.body.data.items).toHaveLength(3);
    const cleared = await api().patch(`/transactions/${tx.body.data.id}`, { items: null }, N);
    expect(cleared.body.data.items).toEqual([]);
    expect((await api().get(search, N)).body.data).toHaveLength(0);

    // --- Planos por mês
    const month = await api().get('/monthly-plans/current', N);
    const key = month.body.data.period.key;
    const nextKey = addDays(month.body.data.period.end, 1).slice(0, 7);
    await api().put(`/monthly-plans/${key}`, { plannedIncome: 1000, lines: [{ categoryId: food, amount: 150 }] }, N).expect(200);
    const list = await api().post('/plans', {
      name: 'Compras do mês', type: 'SHOPPING', periodKey: key, categoryId: food,
      items: [{ title: 'Arroz', estimatedAmount: 12 }, { title: 'Peixe', quantity: 2, estimatedAmount: 30 }],
    }, N);
    expect(list.body.data).toMatchObject({ periodKey: key, categoryId: food, estimated: 42 });
    expect(list.body.data.category.key).toBe('food');
    await api().post('/plans', { name: 'Viagem ao Gerês', type: 'TRIP', periodKey: nextKey, budget: 200 }, N).expect(201);
    const withPlans = await api().get(`/monthly-plans/${key}`, N);
    expect(withPlans.body.data.linkedPlans).toHaveLength(1);
    expect(withPlans.body.data).toMatchObject({ plansEstimated: 42 });
    expect(withPlans.body.data.plan.lines[0]).toMatchObject({ planned: 150, listCount: 1, listEstimated: 42 });
    // Um mês futuro ainda sem plano já mostra a viagem marcada para lá.
    const future = await api().get(`/monthly-plans/${nextKey}`, N);
    expect(future.body.data).toMatchObject({ exists: false, plansEstimated: 200 });
    expect((await api().get(`/plans?period=${nextKey}`, N)).body.data.map((p: { name: string }) => p.name)).toEqual(['Viagem ao Gerês']);
    // A lista de compras copia-se para o mês seguinte.
    const copy = await api().post(`/plans/${list.body.data.id}/duplicate`, { periodKey: nextKey }, N);
    expect(copy.body.data).toMatchObject({ periodKey: nextKey, categoryId: food, itemsTotal: 2, itemsDone: 0 });
    // As listas do mês (mês + categoria) não gastam o limite de planos do plano grátis (3):
    // só a viagem conta até aqui.
    await api().post('/plans', { name: 'Mudança', type: 'MOVING' }, N).expect(201);
    await api().post('/plans', { name: 'Curso', type: 'COURSE' }, N).expect(201);
    expect((await api().post('/plans', { name: 'Carro', type: 'VEHICLE' }, N)).body.error.code).toBe('PLAN_LIMIT_REACHED');
    const extra = await api().post('/plans', { name: 'Farmácia', type: 'SHOPPING', periodKey: key, categoryId: food }, N);
    expect(extra.status).toBe(201);
    // …mas não servem para contornar o limite: tirar-lhe a categoria é passar a contar.
    expect((await api().patch(`/plans/${extra.body.data.id}`, { categoryId: null }, N)).body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect((await api().patch(`/plans/${extra.body.data.id}`, { name: 'Farmácia e higiene' }, N)).body.data.name).toBe('Farmácia e higiene');
  });

  it('administração: códigos promocionais, ofertas e receita só de quem pagou', async () => {
    const hook = (event: object) => request(app.getHttpServer()).post('/v1/billing/webhooks/revenuecat').set('Authorization', 'Bearer test-webhook-secret').send({ event });
    expect((await api().get('/admin/overview')).body.error.code).toBe('ADMIN_REQUIRED');
    await prisma.user.update({ where: { id: userId }, data: { role: 'ADMIN' } });
    expect((await api().get('/me')).body.data.isAdmin).toBe(true);
    expect((await api().get('/admin/overview', T2)).status).toBe(403);
    // Acabou o Premium de testes: daqui para a frente conta a origem do plano.
    await api().post('/billing/dev/grant', { plan: 'FREE', days: 1 }).expect(200);
    const before = (await api().get('/admin/revenue?months=1')).body.data.totals;

    // 1) Código promocional: o Rui fica com Premium sem pagar.
    const code = await api().post('/admin/promo-codes', { code: `teste${stamp}`, plan: 'PREMIUM', durationDays: 30, maxRedemptions: 1, note: 'lançamento' });
    expect(code.status).toBe(201);
    expect(code.body.data).toMatchObject({ code: `TESTE${stamp}`, state: 'active', remaining: 1 });
    expect((await api().post('/admin/promo-codes', { code: `TESTE${stamp}`, plan: 'PREMIUM' })).body.error.code).toBe('PROMO_CODE_TAKEN');
    expect((await api().post('/billing/redeem', { code: 'NAO-EXISTE' }, T2)).body.error.code).toBe('PROMO_CODE_INVALID');
    const redeemed = await api().post('/billing/redeem', { code: ` teste${stamp} ` }, T2);
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.data).toMatchObject({ redeemed: true, plan: 'PREMIUM', durationDays: 30 });
    expect(redeemed.body.data.subscription).toMatchObject({ plan: 'PREMIUM', source: 'PROMO' });
    expect((await api().get('/me', T2)).body.data.plan).toMatchObject({ code: 'PREMIUM', source: 'PROMO' });
    // Só dava para uma pessoa
    expect((await api().post('/billing/redeem', { code: `TESTE${stamp}` })).body.error.code).toBe('PROMO_CODE_EXHAUSTED');
    const open = await api().post('/admin/promo-codes', { plan: 'PREMIUM_PLUS' });
    expect(open.body.data.code).toMatch(/^CONTALEX-/);
    await api().post('/billing/redeem', { code: open.body.data.code }, T2).expect(200);
    expect((await api().post('/billing/redeem', { code: open.body.data.code }, T2)).body.error.code).toBe('PROMO_CODE_ALREADY_USED');
    const used = await api().get(`/admin/promo-codes/${code.body.data.id}/redemptions`);
    expect(used.body.data[0]).toMatchObject({ active: true, user: { username: `rui${stamp}` } });

    // 2) Oferta: o criador dá o plano a si próprio.
    const grant = await api().post(`/admin/users/${userId}/grant`, { plan: 'PREMIUM_PLUS', note: 'criador da app' });
    expect(grant.body.data).toMatchObject({ plan: 'PREMIUM_PLUS', source: 'GRANT', expirationDate: null });

    // Códigos e ofertas não mexem na receita.
    expect((await api().get('/admin/revenue?months=1')).body.data.totals).toEqual(before);

    // 3) Uma compra a sério (webhook da loja).
    const payer = await api().post('/auth/register', { name: 'Paga Bem', username: `paga${stamp}`, email: `p${stamp}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt' }, '');
    const payerId = payer.body.data.user.id;
    const purchase = {
      id: `evt-${stamp}-1`, type: 'INITIAL_PURCHASE', app_user_id: payerId, product_id: 'contalex_premium_monthly', entitlement_ids: ['premium'], period_type: 'NORMAL',
      purchased_at_ms: Date.now(), expiration_at_ms: Date.now() + 30 * 86_400_000, event_timestamp_ms: Date.now(), environment: 'PRODUCTION', store: 'PLAY_STORE',
      price: 4.99, price_in_purchased_currency: 4.59, currency: 'EUR', commission_percentage: 0.15, tax_percentage: 0.1,
    };
    expect((await hook(purchase)).status).toBe(200);
    expect((await hook(purchase)).body.data).toEqual({ duplicate: true }); // o mesmo evento não conta duas vezes
    expect((await api().get('/me', payer.body.data.accessToken)).body.data.plan).toMatchObject({ code: 'PREMIUM', source: 'STORE' });
    const paid = (await api().get('/admin/revenue?months=1')).body.data;
    expect(paid.totals.net).toBeCloseTo(before.net + 4.99, 2);
    expect(paid.totals.payments).toBe(before.payments + 1);
    expect(paid.totals.proceeds).toBeCloseTo(before.proceeds + 3.7425, 1); // 4,99 − 15% de comissão − 10% de impostos
    expect(paid.byCurrency.find((c: { currency: string }) => c.currency === 'EUR').amount).toBeGreaterThanOrEqual(4.59);
    // Uma compra de teste (sandbox) também não entra.
    await hook({ ...purchase, id: `evt-${stamp}-2`, environment: 'SANDBOX', price: 99 }).expect(200);
    expect((await api().get('/admin/revenue?months=1')).body.data.totals.net).toBeCloseTo(before.net + 4.99, 2);

    // Quem é quem: só quem pagou conta para a receita.
    const subs = (await api().get(`/admin/subscribers?q=${stamp}`)).body.data.items as Array<{ user: { username: string }; kind: string; countsAsRevenue: boolean; promoCode: string | null; note: string | null }>;
    const of = (username: string) => subs.find((s) => s.user.username === username);
    expect(of(`paga${stamp}`)).toMatchObject({ kind: 'paid', countsAsRevenue: true });
    expect(of(`rui${stamp}`)).toMatchObject({ kind: 'promo', countsAsRevenue: false });
    expect(of(`manuel${stamp}`)).toMatchObject({ kind: 'grant', countsAsRevenue: false, note: 'criador da app' });
    expect((await api().get(`/admin/subscribers?kind=paid&q=${stamp}`)).body.data.items).toHaveLength(1);
    expect((await api().get(`/admin/subscribers?kind=free&q=${stamp}`)).body.data.items).toHaveLength(2);
    const overview = (await api().get('/admin/overview')).body.data;
    expect(overview.premium.paying).toBeGreaterThanOrEqual(1);
    expect(overview.premium.total).toBe(overview.premium.paying + overview.premium.notPaying);
    expect(overview.revenue.mrr).toBeGreaterThanOrEqual(4.99);
    const users = await api().get(`/admin/users?q=paga${stamp}`);
    expect(users.body.data.items[0]).toMatchObject({ plan: 'PREMIUM', kind: 'paid' });

    // 4) Reembolso: a receita volta atrás.
    await hook({ ...purchase, id: `evt-${stamp}-3`, type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', price: -4.99, price_in_purchased_currency: -4.59, expiration_at_ms: Date.now() - 1000 }).expect(200);
    const refunded = (await api().get('/admin/revenue?months=1')).body.data.totals;
    expect(refunded.net).toBeCloseTo(before.net, 2);
    expect(refunded.refundCount).toBe(before.refundCount + 1);

    // 5) Tirar o que não foi pago.
    const revoked = await api().del(`/admin/users/${(await api().get('/me', T2)).body.data.id}/grant`);
    expect(revoked.body.data.subscription.plan).toBe('FREE');
    await api().patch(`/admin/promo-codes/${open.body.data.id}`, { isActive: false }).expect(200);
    expect((await api().post('/billing/redeem', { code: open.body.data.code })).body.error.code).toBe('PROMO_CODE_INVALID');
    // Um código já usado não se apaga: fica desligado.
    expect((await api().del(`/admin/promo-codes/${code.body.data.id}`)).body.data).toEqual({ deleted: false, deactivated: true });
  });

  it('IA: limites mensais por tipo e teto global de custo', async () => {
    fakeAi.enabled = true;
    const reg = await api().post('/auth/register', { name: 'Ia Teste', username: `ia${stamp}`, email: `ia${stamp}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt' }, '');
    const T3 = reg.body.data.accessToken;
    const ask = (token: string) => api().post('/ai/chat', { messages: [{ role: 'user', content: 'Quanto posso gastar este mês?' }] }, token);

    const chat = await ask(T3);
    expect(chat.status).toBe(200);
    expect(chat.body.data.reply).toBe('Resposta de teste.');
    expect(chat.body.data.usage).toMatchObject({ questions: { used: 1, limit: 15, remaining: 14 }, forecasts: { used: 0, limit: 4 }, limited: 'none' });

    // 4 previsões completas por mês no plano grátis; a 5.ª já não dá.
    for (let i = 0; i < 4; i++) {
      const forecast = await api().post('/ai/forecast', {}, T3);
      expect(forecast.status).toBe(200);
      expect(forecast.body.data).toMatchObject({ headline: 'Mês equilibrado', actions: ['Rever subscrições'] });
    }
    const fifth = await api().post('/ai/forecast', {}, T3);
    expect(fifth.status).toBe(403);
    expect(fifth.body.error.code).toBe('AI_QUOTA_REACHED');
    expect(fifth.body.error.details).toMatchObject({ bucket: 'forecasts', limit: 'forecastsMonthly', max: 4, requiredPlan: 'PREMIUM' });
    // Os contadores são separados: as perguntas continuam a funcionar.
    expect((await ask(T3)).status).toBe(200);
    const cost = await prisma.aiUsage.aggregate({ where: { userId: reg.body.data.user.id }, _sum: { costUsd: true }, _count: { _all: true } });
    expect(cost._count._all).toBe(6);
    expect(Number(cost._sum.costUsd)).toBeCloseTo(6 * 0.002, 6); // 1000 tokens de entrada + 200 de saída

    // Teto global: quando o custo do mês lá chega, o plano grátis fica em pausa…
    process.env.AI_MONTHLY_BUDGET_USD = '0.000001';
    resetEnvCache();
    const paused = await ask(T3);
    expect(paused.status).toBe(503);
    expect(paused.body.error.code).toBe('AI_BUDGET_REACHED');
    expect((await api().get('/ai/usage', T3)).body.data.limited).toBe('all');
    // …e quem tem um plano pago continua a poder usar.
    expect((await ask(T)).status).toBe(200);
    expect((await api().get('/admin/ai')).body.data).toMatchObject({ level: 'all', configured: false });
    process.env.AI_MONTHLY_BUDGET_USD = '0';
    resetEnvCache();
    expect((await ask(T3)).status).toBe(200);
    fakeAi.enabled = false;
  });

  it('webhook do RevenueCat recusa sem autorização', async () => {
    const res = await request(app.getHttpServer()).post('/v1/billing/webhooks/revenuecat').send({ event: { id: 'x', type: 'TEST' } });
    expect([401, 503]).toContain(res.status);
  });

  it('entrar com o Google: conta nova, ligar a uma conta que já existia e contas sem palavra-passe', async () => {
    const gmail = `gui.google${stamp}@gmail.com`;
    const token = googleToken({ sub: `g-${stamp}`, email: gmail, name: 'Gui Google', picture: 'https://lh3.googleusercontent.com/a/foto' });

    // Token que não é da Google, e conta Google com o email por confirmar.
    const bad = await api().post('/auth/google', { idToken: 'isto-nao-e-um-token-da-google' }, '');
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('GOOGLE_TOKEN_INVALID');
    const unverified = await api().post('/auth/google', { idToken: googleToken({ sub: 'g-x', email: `x.${gmail}`, emailVerified: false }) }, '');
    expect(unverified.body.error.code).toBe('GOOGLE_EMAIL_NOT_VERIFIED');

    // 1) Conta nova: país e idioma vêm do telemóvel; o username sai do email.
    const first = await api().post('/auth/google', { idToken: token, country: 'BR', language: 'pt-BR', timezone: 'America/Sao_Paulo' }, '');
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ created: true, passwordCleared: false });
    expect(first.body.data.user).toMatchObject({
      email: gmail, name: 'Gui Google', username: `gui.google${stamp}`, country: 'BR', currency: 'BRL', language: 'pt', timezone: 'America/Sao_Paulo',
      hasPassword: false, googleLinked: true, onboarded: false, avatarUrl: 'https://lh3.googleusercontent.com/a/foto',
    });
    const G = first.body.data.accessToken as string;
    const googleUserId = first.body.data.user.id as string;
    expect((await api().get('/categories', G)).body.data.length).toBeGreaterThan(5);

    // 2) Voltar a entrar com a mesma conta Google: a mesma conta, nada de novo.
    const again = await api().post('/auth/google', { idToken: token }, '');
    expect(again.body.data).toMatchObject({ created: false, passwordCleared: false });
    expect(again.body.data.user.id).toBe(googleUserId);

    // Sem palavra-passe não se entra pelo login normal — nem com a palavra-passe "de faz de conta".
    for (const password of ['qualquer123', 'dummy-password-never-valid-1']) {
      expect((await api().post('/auth/login', { login: gmail, password }, '')).body.error.code).toBe('INVALID_CREDENTIALS');
    }

    // 3) Já havia uma conta com esse email (criada com palavra-passe, email por confirmar):
    //    fica ligada ao Google, a palavra-passe antiga deixa de servir e as sessões fecham-se.
    const email = `ligar${stamp}@ex.pt`;
    const reg = await api().post('/auth/register', { name: 'Lia Ligar', username: `lia${stamp}`, email, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt' }, '');
    expect(reg.status).toBe(201);
    const linked = await api().post('/auth/google', { idToken: googleToken({ sub: `g-lia-${stamp}`, email }) }, '');
    expect(linked.body.data).toMatchObject({ created: false, passwordCleared: true });
    expect(linked.body.data.user).toMatchObject({ id: reg.body.data.user.id, username: `lia${stamp}`, hasPassword: false, googleLinked: true });
    expect((await api().post('/auth/login', { login: email, password: 'segredo123' }, '')).body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await api().post('/auth/refresh', { refreshToken: reg.body.data.refreshToken }, '')).body.error.code).toBe('SESSION_EXPIRED');
    // O mesmo email não fica ligado a uma segunda conta Google.
    expect((await api().post('/auth/google', { idToken: googleToken({ sub: `g-outra-${stamp}`, email }) }, '')).body.error.code).toBe('EMAIL_TAKEN');

    // Definir uma palavra-passe (não há "atual" para confirmar) e passar a poder entrar com ela.
    const L = linked.body.data.accessToken as string;
    expect((await api().post('/me/password', { newPassword: 'fraca' }, L)).body.error.code).toBe('WEAK_PASSWORD');
    await api().post('/me/password', { newPassword: 'novaSenha123' }, L).expect(200);
    const withPassword = await api().post('/auth/login', { login: email, password: 'novaSenha123' }, '');
    expect(withPassword.status).toBe(200);
    expect(withPassword.body.data.user).toMatchObject({ hasPassword: true, googleLinked: true });
    // A partir daí, mudar outra vez já pede a atual.
    expect((await api().post('/me/password', { newPassword: 'outraSenha123' }, withPassword.body.data.accessToken)).body.error.code).toBe('WRONG_PASSWORD');

    // Apagar uma conta só com Google: confirma-se com a MESMA conta Google.
    expect((await api().post('/me/delete', {}, G)).body.error.code).toBe('GOOGLE_CONFIRM_REQUIRED');
    expect((await api().post('/me/delete', { idToken: googleToken({ sub: 'g-de-outra-pessoa', email: gmail }) }, G)).body.error.code).toBe('GOOGLE_ACCOUNT_MISMATCH');
    const scheduled = await api().post('/me/delete', { idToken: token }, G);
    expect(scheduled.body.data).toMatchObject({ scheduled: true, days: 30 });
    // A conta não desaparece logo — e entrar outra vez com o Google cancela o pedido.
    const cameBack = await api().post('/auth/google', { idToken: token }, '');
    expect(cameBack.body.data).toMatchObject({ created: false, deletionCancelled: true });
    expect((await prisma.user.findUnique({ where: { id: googleUserId } }))?.deletionScheduledFor).toBeNull();
  });

  it('pessoas: histórico de entradas, empréstimos ligados, perfis, privilégios dos Spaces e planos enviados', async () => {
    const mk = async (name: string, tag: string) => {
      const username = `${tag}${stamp}`;
      const r = await api().post('/auth/register', { name, username, email: `${username}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt', timezone: 'Europe/Lisbon' }, '');
      expect(r.status).toBe(201);
      return { token: r.body.data.accessToken as string, refresh: r.body.data.refreshToken as string, id: r.body.data.user.id as string, username };
    };
    const bia = await mk('Bia Lima', 'bia');
    const caio = await mk('Caio Reis', 'caio');
    const C = caio.token;
    const notified = (userId: string, type: string) => prisma.notification.count({ where: { userId, type } });

    // --- Histórico de entradas e sessões
    expect((await api().post('/auth/login', { login: bia.username, password: 'errada000' }, '')).status).toBe(401);
    const again = await api().post('/auth/login', { login: bia.username, password: 'segredo123' }, '').set('User-Agent', 'Contalexy/1.0 (Android 14)');
    expect(again.body.data.deletionCancelled).toBe(false);
    const B = again.body.data.accessToken as string;
    const logins = await api().get('/me/logins', B);
    expect(logins.body.data.history.map((h: { method: string; success: boolean }) => [h.method, h.success])).toEqual([['password', true], ['password', false], ['register', true]]);
    expect(logins.body.data.history[0]).toMatchObject({ current: true, active: true, device: { client: 'app', os: 'Android' } });
    expect(logins.body.data.history[1]).toMatchObject({ active: false, current: false });
    expect(logins.body.data.sessions).toHaveLength(2);
    expect(logins.body.data.sessions[0]).toMatchObject({ current: true, method: 'password' });
    // Terminar a sessão no outro aparelho: ele deixa de renovar, este continua.
    const others = await api().post('/me/sessions/revoke-others', {}, B);
    expect(others.body.data.sessions).toHaveLength(1);
    expect((await api().post('/auth/refresh', { refreshToken: bia.refresh }, '')).status).toBe(401);
    expect((await api().post('/auth/refresh', { refreshToken: again.body.data.refreshToken }, '')).status).toBe(200);
    expect((await api().del(`/me/sessions/${logins.body.data.sessions[1].sessionId}`, B)).body.error.code).toBe('SESSION_NOT_FOUND');

    // --- Procurar pessoas: de fora, só com o @username certo
    expect((await api().get('/users/search?q=caio', B)).body.data).toHaveLength(0);
    expect((await api().get(`/users/search?q=@${caio.username}`, B)).body.data[0]).toMatchObject({ id: caio.id, known: false });

    // --- Empréstimo ligado: a Bia emprestou 100 ao Caio
    expect((await api().post('/loans', { direction: 'LENT', amount: 100, counterpartUsername: bia.username }, B)).body.error.code).toBe('LOAN_LINK_SELF');
    const loan = await api().post('/loans', { direction: 'LENT', amount: 100, counterpartUsername: caio.username }, B);
    expect(loan.status).toBe(201);
    expect(loan.body.data).toMatchObject({ personName: 'Caio Reis', mine: true, link: { status: 'PENDING', role: 'owner', user: { id: caio.id } } });
    const lid = loan.body.data.id;
    // O Caio vê o pedido do lado dele ("devo"), mas ainda não conta para as contas dele.
    const pending = await api().get('/loans', C);
    expect(pending.body.data.items).toHaveLength(0);
    expect(pending.body.data.requests[0]).toMatchObject({ id: lid, direction: 'BORROWED', personName: 'Bia Lima', mine: false });
    expect(pending.body.data.summary).toMatchObject({ requestsCount: 1, iOwe: 0 });
    expect(await notified(caio.id, 'loan_request_borrowed')).toBe(1);
    // Os pedidos por responder juntam-se todos num sítio (convites, empréstimos, planos).
    const inbox = await api().get('/me/requests', C);
    expect(inbox.body.data).toMatchObject({ count: 1, items: [{ kind: 'loan', id: lid, direction: 'BORROWED', amount: 100, from: { id: bia.id, name: 'Bia Lima' } }] });
    expect((await api().post(`/loans/${lid}/payments`, { amount: 10 }, C)).body.error.code).toBe('LOAN_NOT_FOUND');
    const accepted = await api().post(`/loans/${lid}/accept`, {}, C);
    expect(accepted.body.data).toMatchObject({ direction: 'BORROWED', remaining: 100, link: { status: 'ACCEPTED', role: 'counterpart', user: { id: bia.id } } });
    expect((await api().post(`/loans/${lid}/accept`, {}, C)).body.error.code).toBe('LOAN_REQUEST_CLOSED');
    expect((await api().get('/loans', C)).body.data.summary).toMatchObject({ iOwe: 100, requestsCount: 0 });
    expect(await notified(bia.id, 'loan_accepted')).toBe(1);

    // O Caio devolve metade: a Bia vê a devolução e o que falta.
    const half = await api().post(`/loans/${lid}/payments`, { amount: 50, note: 'metade' }, C);
    expect(half.body.data).toMatchObject({ paid: 50, remaining: 50 });
    expect(half.body.data.payments[0]).toMatchObject({ amount: 50, mine: true, canRemove: true });
    const seen = await api().get(`/loans/${lid}`, B);
    expect(seen.body.data).toMatchObject({ direction: 'LENT', paid: 50, remaining: 50 });
    expect(seen.body.data.payments[0]).toMatchObject({ amount: 50, note: 'metade', mine: false, canRemove: true });
    expect((await prisma.notification.findFirst({ where: { userId: bia.id, type: 'loan_payment_lent' } }))?.data).toMatchObject({ amount: 50, remaining: 50 });
    // Só quem criou muda os dados; do outro lado cada um fixa o seu.
    expect((await api().patch(`/loans/${lid}`, { amount: 80 }, C)).body.error.code).toBe('LOAN_OWNER_ONLY');
    expect((await api().patch(`/loans/${lid}`, { pinned: true }, C)).body.data.pinned).toBe(true);
    expect((await api().get(`/loans/${lid}`, B)).body.data.pinned).toBe(false);
    // A Bia regista o resto: fica pago para os dois.
    await api().post(`/loans/${lid}/payments`, { amount: 50 }, B).expect(200);
    expect((await api().get(`/loans/${lid}`, C)).body.data).toMatchObject({ status: 'SETTLED', remaining: 0 });
    expect(await notified(caio.id, 'loan_settled')).toBe(1);
    // O Caio não anula o que a Bia registou; a Bia pode anular.
    const bySeen = (await api().get(`/loans/${lid}`, C)).body.data.payments.find((p: { mine: boolean }) => !p.mine);
    expect(bySeen.canRemove).toBe(false);
    expect((await api().del(`/loans/${lid}/payments/${bySeen.id}`, C)).body.error.code).toBe('LOAN_OWNER_ONLY');

    // --- Perfil: quem é e o que temos em comum (nunca o email)
    const l2 = await api().post('/loans', { direction: 'BORROWED', amount: 30, counterpartId: caio.id, personName: 'Caio' }, B);
    await api().post(`/loans/${l2.body.data.id}/accept`, {}, C).expect(200);
    const profile = await api().get(`/users/${bia.id}`, C);
    expect(profile.body.data).toMatchObject({ name: 'Bia Lima', username: bia.username, isMe: false, loans: [{ id: l2.body.data.id, direction: 'LENT', remaining: 30 }] });
    expect(profile.body.data.email).toBeUndefined();
    expect((await api().get('/users/search?q=bia', C)).body.data[0]).toMatchObject({ id: bia.id, known: true });
    // Recusar um pedido e deixar de acompanhar um empréstimo.
    const l3 = await api().post('/loans', { direction: 'LENT', amount: 5, counterpartUsername: caio.username }, B);
    expect((await api().post(`/loans/${l3.body.data.id}/decline`, {}, C)).body.data.declined).toBe(true);
    expect((await api().get(`/loans/${l3.body.data.id}`, B)).body.data.link.status).toBe('DECLINED');
    expect((await api().del(`/loans/${l2.body.data.id}`, C)).body.data).toMatchObject({ left: true });
    expect((await api().get(`/loans/${l2.body.data.id}`, B)).body.data.link.status).toBe('LEFT');
    expect((await api().get(`/loans/${l2.body.data.id}`, C)).body.error.code).toBe('LOAN_NOT_FOUND');

    // --- Spaces: privilégios e "quem apagou"
    const space = await api().post('/spaces', { name: 'Casa B', type: 'HOUSEHOLD' }, B);
    const sid = space.body.data.id;
    expect(space.body.data).toMatchObject({ settings: { inviteBy: 'ALL', expensesBy: 'ALL', editBy: 'OWN' }, can: { invite: true, addExpense: true, manage: true, owner: true } });
    await api().post('/spaces/join', { code: space.body.data.inviteCode }, C).expect(200);
    const dinner = await api().post(`/spaces/${sid}/expenses`, { title: 'Jantar', amount: 40 }, C);
    expect(dinner.status).toBe(201);
    expect(dinner.body.data.mine).toBe(true);
    // Só o dono mexe nos privilégios.
    expect((await api().patch(`/spaces/${sid}`, { expensesBy: 'ADMINS' }, C)).status).toBe(403);
    const locked = await api().patch(`/spaces/${sid}`, { expensesBy: 'ADMINS', editBy: 'ADMINS', inviteBy: 'ADMINS' }, B);
    expect(locked.body.data.settings).toEqual({ inviteBy: 'ADMINS', expensesBy: 'ADMINS', editBy: 'ADMINS' });
    expect((await api().get(`/spaces/${sid}`, C)).body.data.can).toMatchObject({ invite: false, addExpense: false, editOwn: false, manage: false, owner: false });
    expect((await api().post(`/spaces/${sid}/expenses`, { title: 'Café', amount: 2 }, C)).body.error.code).toBe('SPACE_ADMIN_REQUIRED');
    expect((await api().del(`/spaces/${sid}/expenses/${dinner.body.data.id}`, C)).body.error.code).toBe('SPACE_ADMIN_REQUIRED');
    expect((await api().post(`/spaces/${sid}/invitations`, { username: `manuel${stamp}` }, C)).body.error.code).toBe('SPACE_ADMIN_REQUIRED');
    // A dona apaga a despesa do Caio: fica registado quem foi e ele é avisado.
    await api().del(`/spaces/${sid}/expenses/${dinner.body.data.id}`, B).expect(200);
    const activity = await api().get(`/spaces/${sid}/activity`, C);
    const logs = activity.body.data.filter((a: { kind: string }) => a.kind === 'log').map((a: { log: { type: string } }) => a.log);
    expect(logs.find((l: { type: string }) => l.type === 'expense_deleted')).toMatchObject({ actor: { id: bia.id }, actorName: 'Bia Lima', data: { title: 'Jantar', amount: 40 } });
    expect(logs.find((l: { type: string }) => l.type === 'privileges_changed')).toMatchObject({ data: { expensesBy: 'ADMINS', editBy: 'ADMINS', inviteBy: 'ADMINS' } });
    expect(await notified(caio.id, 'space_expense_deleted')).toBe(1);
    // Papéis e remoção: quem é mexido é avisado e fica no histórico.
    await api().patch(`/spaces/${sid}/members/${caio.id}`, { role: 'ADMIN' }, B).expect(200);
    expect(await notified(caio.id, 'space_role')).toBe(1);
    await api().del(`/spaces/${sid}/members/${caio.id}`, B).expect(200);
    expect(await notified(caio.id, 'space_removed')).toBe(1);
    const after = (await api().get(`/spaces/${sid}/activity`, B)).body.data.filter((a: { kind: string }) => a.kind === 'log').map((a: { log: { type: string } }) => a.log.type);
    expect(after).toEqual(expect.arrayContaining(['member_removed', 'role_changed', 'expense_deleted', 'privileges_changed']));

    // --- Enviar o meu plano do mês a alguém
    const food = (await api().get('/categories', B)).body.data.find((c: { key: string }) => c.key === 'food').id;
    const month = (await api().get('/monthly-plans/current', B)).body.data.period.key;
    expect((await api().post('/plan-offers', { periodKey: month, username: caio.username }, B)).body.error.code).toBe('MONTHLY_PLAN_NOT_FOUND');
    const pets = await api().post('/categories', { name: 'Animais', type: 'EXPENSE', icon: 'pets', color: '#F59F00' }, B);
    expect(pets.status).toBe(201);
    await api().put(`/monthly-plans/${month}`, { plannedIncome: 2000, plannedSavings: 100, lines: [{ categoryId: food, amount: 300 }, { categoryId: pets.body.data.id, amount: 40 }, { name: 'Prendas', amount: 25 }] }, B).expect(200);
    expect((await api().post('/plan-offers', { periodKey: month, userId: bia.id }, B)).body.error.code).toBe('PLAN_OFFER_SELF');
    const offer = await api().post('/plan-offers', { periodKey: month, username: caio.username, note: 'Experimenta este' }, B);
    expect(offer.status).toBe(201);
    // O rendimento só vai se quem envia quiser.
    expect(offer.body.data).toMatchObject({ status: 'PENDING', plannedIncome: null, plannedSavings: 100, plannedExpenses: 365, linesCount: 3, mine: true, proposal: false });
    expect(await notified(caio.id, 'plan_offer')).toBe(1);
    const oid = offer.body.data.id;
    const detail = await api().get(`/plan-offers/${oid}`, C);
    expect(detail.body.data.lines.map((l: { kind: string; matched: boolean; amount: number }) => [l.kind, l.matched, l.amount])).toEqual([['CATEGORY', true, 300], ['CATEGORY', false, 40], ['CUSTOM', true, 25]]);
    expect(detail.body.data.lines[0].category).toMatchObject({ key: 'food' });
    expect(detail.body.data.months[0]).toMatchObject({ key: month, isCurrent: true, hasPlan: false });
    expect((await api().get('/plan-offers', C)).body.data.pendingCount).toBe(1);
    expect((await api().get('/me/requests', C)).body.data.items.map((i: { kind: string }) => i.kind)).toEqual(['plan']);
    // O Caio aceita: passa a ser o plano dele, com as categorias dele.
    const used = await api().post(`/plan-offers/${oid}/accept`, {}, C);
    expect(used.status).toBe(200);
    expect(used.body.data.offer).toMatchObject({ status: 'ACCEPTED', appliedKey: month });
    expect(used.body.data.plan.plan).toMatchObject({ plannedSavings: 100, plannedExpenses: 365 });
    expect(used.body.data.plan.plan.lines.map((l: { kind: string; name: string | null; category: { key: string } | null; planned: number }) => [l.kind, l.name ?? l.category?.key, l.planned])).toEqual([
      ['CATEGORY', 'food', 300],
      ['CUSTOM', 'Animais', 40],
      ['CUSTOM', 'Prendas', 25],
    ]);
    expect(await notified(bia.id, 'plan_offer_accepted')).toBe(1);
    expect((await api().post(`/plan-offers/${oid}/accept`, {}, C)).body.error.code).toBe('PLAN_OFFER_CLOSED');
    expect((await api().get('/plan-offers', B)).body.data.sent[0]).toMatchObject({ id: oid, status: 'ACCEPTED' });

    // --- Quem acompanha os gastos propõe um plano (com as categorias de quem os mostra)
    const share = await api().post('/sharing/invitations', { username: bia.username, scope: 'SUMMARY' }, C);
    expect(share.status).toBe(201);
    const aid = share.body.data.id;
    await api().post(`/sharing/${aid}/accept`, {}, B).expect(200);
    const transport = (await api().get('/categories', C)).body.data.find((c: { key: string }) => c.key === 'transport').id;
    const proposal = await api().post(`/sharing/${aid}/plan-proposal`, { plannedSavings: 50, note: 'Tenta assim', lines: [{ categoryId: transport, amount: 60 }, { name: 'Lazer', amount: 30 }] }, B);
    expect(proposal.status).toBe(201);
    expect(proposal.body.data).toMatchObject({ proposal: true, plannedExpenses: 90, plannedSavings: 50, to: { id: caio.id }, mine: true });
    // Só quem acompanha propõe; e só com categorias de quem recebe.
    expect((await api().post(`/sharing/${aid}/plan-proposal`, { lines: [{ name: 'X', amount: 1 }] }, C)).body.error.code).toBe('SHARE_NOT_FOUND');
    expect((await api().post(`/sharing/${aid}/plan-proposal`, { lines: [{ categoryId: food, amount: 10 }] }, B)).body.error.code).toBe('CATEGORY_NOT_FOUND');
    expect((await api().post(`/plan-offers/${proposal.body.data.id}/decline`, {}, C)).body.data.declined).toBe(true);
    expect(await notified(bia.id, 'plan_offer_declined')).toBe(1);
    expect((await api().get(`/users/${caio.id}`, B)).body.data.sharing).toMatchObject({ iFollow: aid, followsMe: null });
  });

  it('plano em grupo: fundo comum, metas juntas, plano de gastos e mensagens', async () => {
    // Criadas diretamente no serviço: o registo pela API tem limite por minuto e este teste só precisa das contas.
    const auth = app.get(AuthService);
    const mk = async (name: string, tag: string) => {
      const username = `${tag}${stamp}`;
      const r = await auth.register({ name, username, email: `${username}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt', languageSource: 'auto', timezone: 'Europe/Lisbon' });
      return { token: r.accessToken, id: r.user.id, username };
    };
    const dora = await mk('Dora Paz', 'dora');
    const edu = await mk('Edu Sol', 'edu');
    const fred = await mk('Fred Luz', 'fred');
    const D = dora.token;
    const E = edu.token;
    const F = fred.token;
    const notified = (userId: string, type: string) => prisma.notification.count({ where: { userId, type } });
    type Member = { userId: string | null; isMember: boolean; deposited: number; stake: number };
    type Goal = { id: string; status: string; saved: number; pct: number; canEdit: boolean };

    const space = await api().post('/spaces', { name: 'Viagem a Roma', type: 'TRIP' }, D);
    const sid = space.body.data.id as string;
    expect(space.body.data.pot).toEqual({ balance: 0, earmarked: 0, free: 0, myStake: 0 });
    await api().post('/spaces/join', { code: space.body.data.inviteCode }, E).expect(200);
    const fundOf = async (token: string) => (await api().get(`/spaces/${sid}/fund`, token)).body.data;
    const bankOf = async () => (await api().get('/accounts', D)).body.data.accounts.find((a: { id: string }) => a.id === bank).balance;

    // --- Depósitos: a Dora põe 100 da conta dela; o Edu põe 60 sem registar em conta nenhuma.
    const bank = (await api().post('/accounts', { name: 'Banco', type: 'BANK', initialBalance: 500 }, D)).body.data.id as string;
    const d1 = await api().post(`/spaces/${sid}/deposits`, { amount: 100, accountId: bank, note: 'Para começar' }, D);
    expect(d1.status).toBe(201);
    expect(d1.body.data).toMatchObject({ balance: 100, free: 100, earmarked: 0, reachedGoalId: null, my: { deposited: 100, stake: 100, canWithdraw: 100 } });
    expect(d1.body.data.deposits[0]).toMatchObject({ amount: 100, kind: 'deposit', mine: true, canRemove: true, inMyAccount: true, note: 'Para começar' });
    expect(await bankOf()).toBe(400);
    const mirror = await prisma.transaction.findFirst({ where: { userId: dora.id, accountId: bank, type: 'EXPENSE' } });
    expect(mirror).toMatchObject({ description: 'Depósito no fundo · Viagem a Roma', excludeFromReports: false });
    expect(await notified(edu.id, 'space_deposit')).toBe(1);
    await api().post(`/spaces/${sid}/deposits`, { amount: 60 }, E).expect(201);
    // O Edu não vê se o depósito da Dora ficou na conta dela.
    expect((await fundOf(E)).deposits.find((d: { amount: number }) => d.amount === 100)).toMatchObject({ mine: false, canRemove: false, inMyAccount: false });

    // --- Uma meta do grupo: juntam os dois até chegar ao valor.
    const g = await api().post(`/spaces/${sid}/goals`, { name: 'Bilhetes', targetAmount: 150, icon: 'flight' }, E);
    expect(g.status).toBe(201);
    const goalId = g.body.data.goals[0].id as string;
    expect(g.body.data.goals[0]).toMatchObject({ name: 'Bilhetes', targetAmount: 150, saved: 0, status: 'ACTIVE', canEdit: true, createdBy: { id: edu.id } });
    expect(await notified(dora.id, 'space_goal_created')).toBe(1);
    const toGoal = await api().post(`/spaces/${sid}/deposits`, { amount: 100, goalId }, D);
    expect(toGoal.body.data).toMatchObject({ balance: 260, earmarked: 100, free: 160, reachedGoalId: null });
    expect(toGoal.body.data.goals[0]).toMatchObject({ saved: 100, remaining: 50, pct: 67, myContribution: 100, contributors: [{ userId: dora.id, amount: 100, isMe: true }] });
    expect(await notified(edu.id, 'space_deposit_goal')).toBe(1);
    const reached = await api().post(`/spaces/${sid}/deposits`, { amount: 50, goalId }, E);
    expect(reached.body.data).toMatchObject({ balance: 310, earmarked: 150, free: 160, reachedGoalId: goalId });
    expect(reached.body.data.goals[0]).toMatchObject({ status: 'COMPLETED', saved: 150, pct: 100 });
    expect(await notified(dora.id, 'space_goal_reached')).toBe(1);
    expect((await api().post(`/spaces/${sid}/deposits`, { amount: 5, goalId: sid }, D)).body.error.code).toBe('SPACE_GOAL_NOT_FOUND');

    // --- Despesas pagas com o fundo: saem do que está livre e não criam dívidas.
    const tooMuch = await api().post(`/spaces/${sid}/expenses`, { title: 'Hotel', amount: 200, fromPot: true }, D);
    expect(tooMuch.body.error.code).toBe('SPACE_POT_INSUFFICIENT');
    expect(tooMuch.body.error.message).toContain('160');
    const hotel = await api().post(`/spaces/${sid}/expenses`, { title: 'Hotel', amount: 120, fromPot: true }, D);
    expect(hotel.status).toBe(201);
    expect(hotel.body.data).toMatchObject({ fromPot: true, paidBy: null, myShare: 60, myImpact: 0 });
    expect(await notified(edu.id, 'space_pot_expense')).toBe(1);
    expect(await notified(edu.id, 'space_expense')).toBe(0);
    const balances = await api().get(`/spaces/${sid}/balances`, E);
    expect(balances.body.data).toMatchObject({ myBalance: 0, suggested: [] });
    let fund = await fundOf(D);
    expect(fund).toMatchObject({ balance: 190, spent: 120, earmarked: 150, free: 40, my: { deposited: 200, share: 60, stake: 140, canWithdraw: 40 } });
    expect(fund.members.find((m: Member) => m.userId === edu.id)).toMatchObject({ deposited: 110, stake: 50, isMember: true });
    // Uma despesa do fundo não pode crescer para além do que lá está.
    expect((await api().patch(`/spaces/${sid}/expenses/${hotel.body.data.id}`, { amount: 170 }, D)).body.error.code).toBe('SPACE_POT_INSUFFICIENT');

    // --- Levantar: só a minha parte, e só do que está livre.
    const over = await api().post(`/spaces/${sid}/withdrawals`, { amount: 45 }, E);
    expect(over.body.error.code).toBe('SPACE_WITHDRAW_TOO_HIGH');
    expect(over.body.error.message).toContain('40');
    const out = await api().post(`/spaces/${sid}/withdrawals`, { amount: 40 }, E);
    expect(out.body.data).toMatchObject({ balance: 150, free: 0, my: { withdrawn: 40, stake: 10, canWithdraw: 0 } });
    expect(out.body.data.deposits[0]).toMatchObject({ amount: -40, kind: 'withdrawal', mine: true });
    expect(await notified(dora.id, 'space_withdrawal')).toBe(1);
    expect((await api().post(`/spaces/${sid}/expenses`, { title: 'Café', amount: 10, fromPot: true }, D)).body.error.code).toBe('SPACE_POT_INSUFFICIENT');

    // --- "Usar o dinheiro" da meta: fecha-a e o dinheiro volta a ficar livre.
    expect((await api().patch(`/spaces/${sid}/goals/${goalId}`, { status: 'ARCHIVED' }, D)).body.data).toMatchObject({ earmarked: 0, free: 150 });
    const flights = await api().post(`/spaces/${sid}/expenses`, { title: 'Voos', amount: 100, fromPot: true, categoryKey: 'transport' }, E);
    expect(flights.status).toBe(201);
    // Reabrir a meta voltaria a guardar 150 — já só lá estão 50.
    expect((await api().patch(`/spaces/${sid}/goals/${goalId}`, { status: 'ACTIVE' }, E)).body.error.code).toBe('SPACE_POT_INSUFFICIENT');
    fund = await fundOf(E);
    expect(fund).toMatchObject({ balance: 50, free: 50, my: { stake: -40, canWithdraw: 0 } });
    expect(fund.goals.find((x: Goal) => x.id === goalId)).toMatchObject({ status: 'ARCHIVED', saved: 150 });

    // --- Anular depósitos: os meus (com o movimento da minha conta) ou, sendo admin, os dos outros.
    const first = (await fundOf(D)).deposits.find((d: { note: string | null }) => d.note === 'Para começar').id as string;
    expect((await api().del(`/spaces/${sid}/deposits/${first}`, D)).body.error.code).toBe('SPACE_POT_INSUFFICIENT');
    expect((await api().del(`/spaces/${sid}/deposits/${first}`, E)).body.error.code).toBe('SPACE_ADMIN_REQUIRED');
    const extra = await api().post(`/spaces/${sid}/deposits`, { amount: 30, accountId: bank }, D);
    expect(await bankOf()).toBe(370);
    await api().del(`/spaces/${sid}/deposits/${extra.body.data.deposits[0].id}`, D).expect(200);
    expect(await bankOf()).toBe(400);
    const eduExtra = await api().post(`/spaces/${sid}/deposits`, { amount: 20 }, E);
    await api().del(`/spaces/${sid}/deposits/${eduExtra.body.data.deposits[0].id}`, D).expect(200);
    expect(await notified(edu.id, 'space_deposit_removed')).toBe(1);
    const activity = (await api().get(`/spaces/${sid}/activity`, E)).body.data as Array<{ kind: string; log?: { type: string; actorName: string; data: Record<string, unknown> } }>;
    expect(activity.filter((a) => a.kind === 'deposit').length).toBeGreaterThanOrEqual(5);
    expect(activity.filter((a) => a.kind === 'log' && a.log?.type === 'deposit_deleted').map((a) => a.log?.data.name).sort()).toEqual(['Dora Paz', 'Edu Sol']);

    // --- O plano do grupo: quanto se quer gastar em quê, comparado com as despesas.
    const dup = await api().put(`/spaces/${sid}/plan`, { lines: [{ categoryKey: 'food', amount: 10 }, { categoryKey: 'food', amount: 20 }] }, D);
    expect(dup.body.error.code).toBe('SPACE_PLAN_DUPLICATE');
    const plan = await api().put(`/spaces/${sid}/plan`, { lines: [{ categoryKey: 'transport', amount: 300 }, { title: 'Seguro de viagem', amount: 50 }] }, E);
    expect(plan.status).toBe(200);
    expect(plan.body.data).toMatchObject({ month: null, planned: 350, spent: 220, remaining: 130, perPerson: 175, unplanned: [{ categoryKey: null, spent: 120 }], can: { edit: true } });
    expect(plan.body.data.lines).toMatchObject([
      { categoryKey: 'transport', title: null, amount: 300, spent: 100, remaining: 200, pct: 33 },
      { categoryKey: null, title: 'Seguro de viagem', amount: 50, spent: null, remaining: null, pct: null },
    ]);
    expect((await api().get(`/spaces/${sid}/plan?month=2000-01`, D)).body.data).toMatchObject({ month: '2000-01', planned: 350, spent: 0, unplanned: [] });

    // --- Mensagens rápidas no grupo
    expect((await api().post(`/spaces/${sid}/messages`, { text: '   ' }, D)).body.error.code).toBe('VALIDATION_ERROR');
    const hello = await api().post(`/spaces/${sid}/messages`, { text: 'Olá grupo!' }, D);
    expect(hello.status).toBe(201);
    expect(hello.body.data).toMatchObject({ text: 'Olá grupo!', mine: true, deleted: false, sender: { id: dora.id, name: 'Dora Paz' } });
    const second = await api().post(`/spaces/${sid}/messages`, { text: 'Já comprei os bilhetes' }, D);
    // Dois avisos da mesma conversa juntam-se num só.
    const pendingNote = await prisma.notification.findMany({ where: { userId: edu.id, type: 'chat_message' } });
    expect(pendingNote).toHaveLength(1);
    expect(pendingNote[0].data).toMatchObject({ thread: `space:${sid}`, count: 2, text: 'Já comprei os bilhetes', from: 'Dora Paz', space: 'Viagem a Roma' });
    expect((await api().get(`/spaces/${sid}`, E)).body.data.unreadMessages).toBe(2);
    expect((await api().get('/chats/unread', E)).body.data.count).toBe(2);
    const threads = await api().get('/chats', E);
    expect(threads.body.data.threads[0]).toMatchObject({ thread: `space:${sid}`, kind: 'space', unread: 2, space: { name: 'Viagem a Roma', membersCount: 2 }, last: { text: 'Já comprei os bilhetes', mine: false } });
    // Abrir a conversa dá-a por lida (e o aviso também).
    const opened = await api().get(`/spaces/${sid}/messages`, E);
    expect(opened.body.data).toMatchObject({ thread: `space:${sid}`, kind: 'space', canSend: true, hasMore: false });
    expect(opened.body.data.messages.map((m: { text: string }) => m.text)).toEqual(['Olá grupo!', 'Já comprei os bilhetes']);
    expect((await api().get('/chats/unread', E)).body.data.count).toBe(0);
    expect(await prisma.notification.count({ where: { userId: edu.id, type: 'chat_message', readAt: null } })).toBe(0);
    // O outro responde; quem está na conversa só pede as novas.
    await api().post(`/spaces/${sid}/messages`, { text: 'Boa!' }, E).expect(201);
    const fresh = await api().get(`/spaces/${sid}/messages?after=${encodeURIComponent(second.body.data.at)}`, D);
    expect(fresh.body.data.messages.map((m: { text: string }) => m.text)).toEqual(['Já comprei os bilhetes', 'Boa!']);
    await api().post(`/spaces/${sid}/messages`, { text: 'Falta o seguro' }, D).expect(201);
    expect(await notified(edu.id, 'chat_message')).toBe(2);
    const older = await api().get(`/spaces/${sid}/messages?limit=2&before=${encodeURIComponent(second.body.data.at)}`, E);
    expect(older.body.data.messages.map((m: { text: string }) => m.text)).toEqual(['Olá grupo!']);
    expect((await api().get(`/spaces/${sid}/messages?limit=2`, E)).body.data).toMatchObject({ hasMore: true });
    // Apagar: só quem escreveu (ou um admin). Fica o lugar, sem o texto.
    expect((await api().del(`/chats/messages/${hello.body.data.id}`, E)).body.error.code).toBe('SPACE_ADMIN_REQUIRED');
    await api().del(`/chats/messages/${hello.body.data.id}`, D).expect(200);
    const afterDelete = await api().get(`/spaces/${sid}/messages?after=${encodeURIComponent(second.body.data.at)}`, E);
    expect(afterDelete.body.data.deletedIds).toEqual([hello.body.data.id]);
    expect((await api().get(`/spaces/${sid}/messages`, E)).body.data.messages[0]).toMatchObject({ id: hello.body.data.id, text: null, deleted: true });
    expect((await prisma.message.findUnique({ where: { id: hello.body.data.id } }))?.text).toBe('');
    // Quem não é do Space não lê nem escreve.
    expect((await api().get(`/spaces/${sid}/messages`, F)).body.error.code).toBe('NOT_SPACE_MEMBER');
    expect((await api().post(`/spaces/${sid}/messages`, { text: 'Olá' }, F)).body.error.code).toBe('NOT_SPACE_MEMBER');
    expect((await api().del(`/chats/messages/${second.body.data.id}`, F)).body.error.code).toBe('MESSAGE_NOT_FOUND');

    // --- Conversas a dois: só entre quem já tem alguma coisa em comum.
    expect((await api().post(`/chats/direct/${dora.id}`, { text: 'Olá Dora' }, F)).body.error.code).toBe('CHAT_NOT_ALLOWED');
    expect((await api().post(`/chats/direct/${dora.id}`, { text: 'Eu' }, D)).body.error.code).toBe('CHAT_SELF');
    expect((await api().get(`/chats/direct/${dora.id}`, F)).body.data).toMatchObject({ canSend: false, messages: [] });
    const direct = await api().post(`/chats/direct/${edu.id}`, { text: 'Só para ti: levo eu o carro.' }, D);
    expect(direct.status).toBe(201);
    expect(await notified(edu.id, 'chat_direct')).toBe(1);
    const eduThreads = await api().get('/chats', E);
    expect(eduThreads.body.data.unread).toBe(1);
    expect(eduThreads.body.data.threads[0]).toMatchObject({ kind: 'direct', unread: 1, user: { id: dora.id, name: 'Dora Paz' }, last: { text: 'Só para ti: levo eu o carro.' } });
    const conversation = await api().get(`/chats/direct/${dora.id}`, E);
    expect(conversation.body.data).toMatchObject({ kind: 'direct', canSend: true, user: { id: dora.id } });
    expect(conversation.body.data.messages).toHaveLength(1);
    expect((await api().get('/chats', E)).body.data.threads.find((t: { kind: string }) => t.kind === 'direct').unread).toBe(0);
    expect((await api().del(`/chats/messages/${direct.body.data.id}`, E)).status).toBe(403);
    expect((await api().del(`/chats/messages/${direct.body.data.id}`, F)).body.error.code).toBe('MESSAGE_NOT_FOUND');
    await api().post(`/chats/direct/${dora.id}`, { text: 'Combinado' }, E).expect(201);
    expect((await api().get('/chats', D)).body.data.threads[0]).toMatchObject({ kind: 'direct', unread: 1, user: { id: edu.id } });

    // --- Quem entra depois não fica com as mensagens antigas "por ler".
    await api().post('/spaces/join', { code: space.body.data.inviteCode }, F).expect(200);
    expect((await api().get(`/spaces/${sid}`, F)).body.data.unreadMessages).toBe(0);
    await api().post(`/spaces/${sid}/messages`, { text: 'Bem-vindo, Fred' }, D).expect(201);
    expect((await api().get(`/spaces/${sid}`, F)).body.data.unreadMessages).toBe(1);
    await api().post(`/spaces/${sid}/messages`, { text: 'Obrigado!' }, F).expect(201);

    // --- Sair: só com a parte do fundo acertada.
    const leave = await api().post(`/spaces/${sid}/leave`, {}, E);
    expect(leave.body.error.code).toBe('SPACE_POT_NOT_SETTLED');
    expect(leave.body.error.message).toContain('40');
    await api().post(`/spaces/${sid}/deposits`, { amount: 40 }, E).expect(201);
    await api().post(`/spaces/${sid}/leave`, {}, E).expect(200);
    fund = await fundOf(D);
    expect(fund.members.find((m: Member) => m.userId === edu.id)).toMatchObject({ isMember: false, stake: 0 });
    expect(fund.balance).toBe(90);

    // --- Apagar a conta leva as mensagens que a pessoa escreveu e as conversas a dois.
    const users = app.get(UsersService);
    await users.purgeAccount(fred.id);
    expect(await prisma.message.count({ where: { spaceId: sid, text: 'Obrigado!' } })).toBe(0);
    await users.purgeAccount(edu.id);
    expect(await prisma.message.count({ where: { directKey: { contains: edu.id } } })).toBe(0);
    expect(await prisma.message.count({ where: { spaceId: sid, senderId: dora.id } })).toBeGreaterThanOrEqual(3);
    // O dinheiro que a pessoa pôs continua no fundo (sem o nome).
    fund = await fundOf(D);
    expect(fund.balance).toBe(90);
    expect(fund.members.find((m: Member) => m.userId === null)).toMatchObject({ isMember: false });
    expect((await api().get('/chats', D)).body.data.threads.filter((t: { kind: string }) => t.kind === 'direct')).toHaveLength(0);
  });

  it('planos pagos: pagar uma vez ou subscrever, cancelar, reembolso e o que fica fechado sem o plano', async () => {
    const auth = app.get(AuthService);
    const username = `gil${stamp}`;
    const reg = await auth.register({ name: 'Gil Pago', username, email: `${username}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt', languageSource: 'auto', timezone: 'Europe/Lisbon' });
    const G = reg.accessToken;
    const gil = reg.user.id;
    const DAY = 86_400_000;
    let seq = 0;
    const hook = (event: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/v1/billing/webhooks/revenuecat')
        .set('Authorization', 'Bearer test-webhook-secret')
        .send({ event: { id: `pay-${stamp}-${++seq}`, app_user_id: gil, environment: 'PRODUCTION', store: 'PLAY_STORE', event_timestamp_ms: Date.now(), ...event } });
    const planOf = async () => (await api().get('/me', G)).body.data.plan;
    const daysLeft = (iso: string) => (new Date(iso).getTime() - Date.now()) / DAY;

    // --- O catálogo diz o que se pode comprar: subscrições e compras de uma só vez.
    const catalog = (await api().get('/billing/plans', '')).body.data.plans.find((p: { code: string }) => p.code === 'PREMIUM');
    expect(catalog.productIds).toEqual(['contalex_premium_monthly', 'contalex_premium_yearly']);
    expect(catalog.oneTimeProducts).toEqual({ contalex_premium_pass_month: 31, contalex_premium_pass_year: 366 });

    // --- Grátis: 3 objetivos e mais nenhum.
    const goalIds: string[] = [];
    for (const name of ['Férias', 'Carro', 'Portátil']) goalIds.push((await api().post('/goals', { name, targetAmount: 1000, initialAmount: 250 }, G)).body.data.id);
    expect((await api().post('/goals', { name: 'A mais', targetAmount: 10 }, G)).body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect((await planOf()).locked).toEqual({ goals: 0, budgets: 0, plans: 0, recurring: 0, rules: 0, total: 0 });

    // --- Pagar uma vez: dá 31 dias, sem renovação (não há nada para cancelar).
    const unknown = await hook({ type: 'NON_RENEWING_PURCHASE', product_id: 'produto_desconhecido', entitlement_ids: ['premium'], purchased_at_ms: Date.now(), price: 9.99, currency: 'EUR', price_in_purchased_currency: 9.99 });
    expect(unknown.body.data).toMatchObject({ ignored: 'unknown_product' });
    expect((await planOf()).code).toBe('FREE');
    const once = { type: 'NON_RENEWING_PURCHASE', product_id: 'contalex_premium_pass_month', purchased_at_ms: Date.now(), price: 5.49, currency: 'EUR', price_in_purchased_currency: 4.99 };
    expect((await hook(once)).body.data).toEqual({ ok: true });
    let plan = await planOf();
    expect(plan).toMatchObject({ code: 'PREMIUM', state: 'PREMIUM', source: 'STORE', kind: 'ONE_TIME', productId: 'contalex_premium_pass_month', autoRenew: false, canCancel: false, platform: 'ANDROID' });
    expect(daysLeft(plan.expirationDate)).toBeGreaterThan(30.9);
    expect(daysLeft(plan.expirationDate)).toBeLessThan(31.1);
    // O mesmo evento repetido não conta duas vezes; comprar outra vez soma ao que falta.
    const replay = await request(app.getHttpServer()).post('/v1/billing/webhooks/revenuecat').set('Authorization', 'Bearer test-webhook-secret').send({ event: { ...once, id: `pay-${stamp}-${seq}`, app_user_id: gil } });
    expect(replay.body.data).toEqual({ duplicate: true });
    await hook(once).expect(200);
    plan = await planOf();
    expect(daysLeft(plan.expirationDate)).toBeGreaterThan(61.9);
    expect(daysLeft(plan.expirationDate)).toBeLessThan(62.1);
    expect(await prisma.subscription.count({ where: { userId: gil } })).toBe(1);
    expect(await prisma.revenueEvent.count({ where: { userId: gil, type: 'NON_RENEWING_PURCHASE', productId: 'contalex_premium_pass_month' } })).toBe(2);

    // --- Com o plano pago, a pessoa faz mais do que o plano grátis deixa.
    for (const name of ['Casa', 'Curso']) goalIds.push((await api().post('/goals', { name, targetAmount: 2000, initialAmount: 500 }, G)).body.data.id);
    const food = (await api().get('/categories', G)).body.data.find((c: { key: string }) => c.key === 'food').id as string;
    const bank = (await api().post('/accounts', { name: 'Banco', type: 'BANK', initialBalance: 1000 }, G)).body.data.id as string;
    const budgetIds: string[] = [];
    for (let i = 1; i <= 6; i++) budgetIds.push((await api().post('/budgets', { name: `Limite ${i}`, amount: 100 + i, categoryIds: i === 6 ? [food] : [] }, G)).body.data.id);
    const planIds: string[] = [];
    for (let i = 1; i <= 4; i++) planIds.push((await api().post('/plans', { name: `Plano ${i}`, type: 'TRIP', items: [{ title: 'Voo', estimatedAmount: 200 }, { title: 'Hotel', estimatedAmount: 300 }] }, G)).body.data.id);
    const rule = await api().post('/rules', { value: 'uber', categoryId: food }, G);
    expect(rule.status).toBe(201);
    for (const price of [0.89, 0.95]) await api().post('/prices', { productName: 'Leite', price, storeName: 'Mercado' }, G).expect(201);
    // Um depósito automático para hoje no último objetivo (vai ficar fechado).
    await api().post(`/goals/${goalIds[4]}/deposits`, { amount: 50, date: today, frequency: 'MONTHLY', autoApply: true }, G).expect(201);
    expect((await planOf()).locked.total).toBe(0);

    // --- A loja devolve o dinheiro: saem os dias dessa compra; à segunda devolução o plano acaba já.
    const refund = { type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', product_id: 'contalex_premium_pass_month', price: -5.49, currency: 'EUR', price_in_purchased_currency: -4.99 };
    await hook(refund).expect(200);
    plan = await planOf();
    expect(plan.code).toBe('PREMIUM');
    expect(daysLeft(plan.expirationDate)).toBeLessThan(31.1);
    await hook(refund).expect(200);
    plan = await planOf();
    expect(plan).toMatchObject({ code: 'FREE', state: 'EXPIRED', refunded: true, canCancel: false });

    // --- Sem o plano: o que passa dos limites grátis fica fechado (os mais antigos ficam abertos).
    expect(plan.locked).toEqual({ goals: 2, budgets: 1, plans: 1, recurring: 0, rules: 1, total: 5 });
    // A pessoa é avisada de que o plano acabou e de que há coisas fechadas (uma vez).
    const notes = (type: string) => prisma.notification.findMany({ where: { userId: gil, type }, orderBy: { createdAt: 'asc' } });
    const ended = await notes('subscription_ended_locked');
    expect(ended).toHaveLength(1);
    expect(ended[0].data).toMatchObject({ plan: 'PREMIUM', locked: 5 });
    type Row = { id: string; name: string; locked: boolean };
    const goals = (await api().get('/goals', G)).body.data as Array<Row & { saved: number; progress: number; targetAmount: number }>;
    expect(goals).toHaveLength(5);
    expect(goals.filter((g) => !g.locked).map((g) => g.id).sort()).toEqual(goalIds.slice(0, 3).sort());
    // Do que está fechado vê-se uma amostra: o nome, o valor-alvo e a percentagem — não o que lá está.
    expect(goals.find((g) => g.id === goalIds[4])).toMatchObject({ name: 'Curso', locked: true, targetAmount: 2000, progress: 25, saved: 0 });
    const lockedGoal = await api().get(`/goals/${goalIds[4]}`, G);
    expect(lockedGoal.status).toBe(403);
    expect(lockedGoal.body.error).toMatchObject({ code: 'PLAN_ITEM_LOCKED', details: { limit: 'goals', max: 3, requiredPlan: 'PREMIUM', locked: true } });
    expect(lockedGoal.body.error.message).toContain('plano pago');
    expect((await api().patch(`/goals/${goalIds[4]}`, { name: 'Outro nome' }, G)).body.error.code).toBe('PLAN_ITEM_LOCKED');
    expect((await api().post(`/goals/${goalIds[4]}/contributions`, { amount: 10 }, G)).body.error.code).toBe('PLAN_ITEM_LOCKED');
    expect((await api().get(`/goals/${goalIds[0]}`, G)).status).toBe(200);
    // Fechado também deixa de trabalhar sozinho: nem aparece no que aí vem, nem deposita.
    expect((await api().get('/goals/deposits/upcoming', G)).body.data.items).toHaveLength(0);
    await app.get(GoalDepositsService).runDue();
    expect(await prisma.goalContribution.count({ where: { goalId: goalIds[4] } })).toBe(1);
    // Limites, planos e regras: o mesmo.
    const budgets = (await api().get('/budgets', G)).body.data as Array<Row & { spent: number; amount: number }>;
    expect(budgets.filter((b) => b.locked).map((b) => b.id)).toEqual([budgetIds[5]]);
    expect(budgets.find((b) => b.locked)).toMatchObject({ name: 'Limite 6', amount: 106, spent: 0, categoryIds: [] });
    expect((await api().get(`/budgets/${budgetIds[5]}`, G)).body.error.code).toBe('PLAN_ITEM_LOCKED');
    // Uma despesa na categoria do limite fechado não dá aviso nenhum.
    await api().post('/transactions', { type: 'EXPENSE', amount: 500, accountId: bank, categoryId: food, date: today, description: 'Uber Eats' }, G).expect(201);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await prisma.notification.count({ where: { userId: gil, type: { in: ['budget_alert', 'budget_exceeded'] }, data: { path: ['budgetId'], equals: budgetIds[5] } } })).toBe(0);
    const plans = (await api().get('/plans', G)).body.data as Array<Row & { estimated: number; itemsTotal: number }>;
    expect(plans.filter((p) => p.locked).map((p) => p.id)).toEqual([planIds[3]]);
    expect(plans.find((p) => p.locked)).toMatchObject({ name: 'Plano 4', itemsTotal: 2, estimated: 0 });
    expect((await api().post(`/plans/${planIds[3]}/duplicate`, {}, G)).body.error.code).toBe('PLAN_ITEM_LOCKED');
    // Nem se liga um movimento novo a um plano fechado; a um aberto, sim.
    expect((await api().post('/transactions', { type: 'EXPENSE', amount: 10, accountId: bank, date: today, description: 'Táxi', planId: planIds[3] }, G)).body.error.code).toBe('PLAN_ITEM_LOCKED');
    await api().post('/transactions', { type: 'EXPENSE', amount: 10, accountId: bank, date: today, description: 'Táxi', planId: planIds[0] }, G).expect(201);
    // O histórico de preços é pago: sem o plano, só se vê quantos produtos lá estão e o nome deles.
    expect((await api().get('/prices', G)).body.error.code).toBe('PREMIUM_REQUIRED');
    expect((await api().get('/prices/teaser', G)).body.data).toEqual({ products: 1, records: 2, sample: [{ name: 'Leite', count: 2 }], locked: true });
    expect((await api().get('/rules', G)).body.data).toMatchObject([{ value: 'uber', locked: true }]);
    expect((await api().patch(`/rules/${rule.body.data.id}`, { value: 'bolt' }, G)).status).toBe(403);
    // O Início e o calendário não mostram o que está fechado.
    const home = (await api().get('/dashboard', G)).body.data;
    expect(JSON.stringify(home)).not.toContain(goalIds[4]);
    expect(JSON.stringify(home)).not.toContain(budgetIds[5]);
    // Apagar é sempre possível; e apagar um dos abertos abre o fechado mais antigo.
    await api().del(`/goals/${goalIds[4]}`, G).expect(200);
    await api().del(`/goals/${goalIds[0]}`, G).expect(200);
    expect((await api().get(`/goals/${goalIds[3]}`, G)).status).toBe(200);
    expect((await planOf()).locked.goals).toBe(0);

    // --- Subscrever: volta tudo a abrir. Cancelar pára a renovação, mas o que está pago mantém-se.
    const end = Date.now() + 30 * DAY;
    const t0 = Date.now();
    await hook({ type: 'INITIAL_PURCHASE', product_id: 'contalex_premium_monthly', entitlement_ids: ['premium'], purchased_at_ms: t0, expiration_at_ms: end, price: 3.29, currency: 'EUR', price_in_purchased_currency: 2.99, event_timestamp_ms: t0 }).expect(200);
    plan = await planOf();
    expect(plan).toMatchObject({ code: 'PREMIUM', state: 'PREMIUM', kind: 'SUBSCRIPTION', productId: 'contalex_premium_monthly', autoRenew: true, canCancel: true, refunded: false });
    expect(plan.locked.total).toBe(0);
    expect((await api().get(`/budgets/${budgetIds[5]}`, G)).status).toBe(200);
    expect((await api().get('/rules', G)).body.data[0].locked).toBe(false);
    await hook({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', product_id: 'contalex_premium_monthly', entitlement_ids: ['premium'], expiration_at_ms: end, event_timestamp_ms: t0 + 2000 }).expect(200);
    plan = await planOf();
    expect(plan).toMatchObject({ code: 'PREMIUM', state: 'CANCELLED', autoRenew: false, canCancel: false });
    expect(new Date(plan.expirationDate).getTime()).toBe(end);
    expect((await api().get(`/plans/${planIds[3]}`, G)).status).toBe(200);
    // Um evento mais antigo que chega atrasado não repõe o estado anterior.
    const stale = await hook({ type: 'RENEWAL', product_id: 'contalex_premium_monthly', entitlement_ids: ['premium'], expiration_at_ms: end, event_timestamp_ms: t0 + 1000 });
    expect(stale.body.data).toMatchObject({ ignored: 'stale' });
    expect((await planOf()).state).toBe('CANCELLED');
    // Voltou atrás no cancelamento.
    await hook({ type: 'UNCANCELLATION', product_id: 'contalex_premium_monthly', entitlement_ids: ['premium'], expiration_at_ms: end, event_timestamp_ms: t0 + 3000 }).expect(200);
    expect(await planOf()).toMatchObject({ state: 'PREMIUM', autoRenew: true, canCancel: true });
    // A cobrança falhou, mas a loja dá uns dias de tolerância: mantém o acesso e avisa.
    await hook({ type: 'BILLING_ISSUE', product_id: 'contalex_premium_monthly', entitlement_ids: ['premium'], expiration_at_ms: Date.now() - 1000, grace_period_expiration_at_ms: Date.now() + 3 * DAY, event_timestamp_ms: t0 + 4000 }).expect(200);
    expect(await planOf()).toMatchObject({ code: 'PREMIUM', billingIssue: true });
    expect(await notes('subscription_billing_issue')).toHaveLength(1);
    // Reembolso da subscrição: acaba no momento — e o que passa dos limites volta a fechar.
    await hook({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', product_id: 'contalex_premium_monthly', entitlement_ids: ['premium'], expiration_at_ms: end, price: -3.29, currency: 'EUR', price_in_purchased_currency: -2.99, event_timestamp_ms: t0 + 5000 }).expect(200);
    plan = await planOf();
    expect(plan).toMatchObject({ code: 'FREE', state: 'EXPIRED', refunded: true });
    expect(plan.locked).toMatchObject({ budgets: 1, plans: 1, rules: 1 });
    expect(await notes('subscription_ended_locked')).toHaveLength(2);

    // --- Compras de teste das lojas (sandbox): só dão acesso se o servidor o permitir.
    process.env.BILLING_ACCEPT_SANDBOX = 'false';
    resetEnvCache();
    await hook({ type: 'INITIAL_PURCHASE', product_id: 'contalex_premium_yearly', entitlement_ids: ['premium'], environment: 'SANDBOX', purchased_at_ms: Date.now(), expiration_at_ms: Date.now() + 5 * DAY }).expect(200);
    expect((await planOf()).code).toBe('FREE');
    process.env.BILLING_ACCEPT_SANDBOX = 'true';
    resetEnvCache();
    expect((await planOf()).code).toBe('PREMIUM');
    // O atalho de testes nunca funciona num servidor de produção.
    process.env.NODE_ENV = 'production';
    resetEnvCache();
    expect((await api().post('/billing/dev/grant', { plan: 'PREMIUM_PLUS', days: 30 }, G)).status).toBe(403);
    process.env.NODE_ENV = 'test';
    resetEnvCache();

    // --- Um plano que acaba sem renovar: lembrete uns dias antes e aviso quando acaba (sem a loja dizer nada).
    const subs = app.get(SubscriptionsService);
    await hook({ type: 'EXPIRATION', product_id: 'contalex_premium_yearly', entitlement_ids: ['premium'], environment: 'SANDBOX', expiration_at_ms: Date.now() - 1000 }).expect(200);
    expect((await planOf()).code).toBe('FREE');
    const yearly = { product_id: 'contalex_premium_yearly', entitlement_ids: ['premium'], purchased_at_ms: Date.now() - 363 * DAY, expiration_at_ms: Date.now() + 2 * DAY };
    await hook({ ...yearly, type: 'INITIAL_PURCHASE' }).expect(200);
    await subs.remindEnding();
    expect(await notes('subscription_ending')).toHaveLength(0); // vai renovar: não há nada a lembrar
    await hook({ ...yearly, type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' }).expect(200);
    expect(await planOf()).toMatchObject({ code: 'PREMIUM', state: 'CANCELLED', canCancel: false });
    await subs.remindEnding();
    await subs.remindEnding();
    const ending = await notes('subscription_ending');
    expect(ending).toHaveLength(1);
    expect(ending[0].data).toMatchObject({ plan: 'PREMIUM' });
    // A data de fim passa (a loja não mandou nada): a tarefa fecha o plano e avisa.
    const endedBefore = (await notes('subscription_ended_locked')).length;
    await prisma.subscription.updateMany({ where: { userId: gil, status: 'CANCELLED' }, data: { expirationDate: new Date(Date.now() - 1000) } });
    expect((await planOf()).code).toBe('FREE');
    expect(await subs.expireLapsed()).toBeGreaterThanOrEqual(1);
    expect(await notes('subscription_ended_locked')).toHaveLength(endedBefore + 1);
    expect(await subs.expireLapsed()).toBe(0);
    expect(await notes('subscription_ended_locked')).toHaveLength(endedBefore + 1);
  });

  it('pagamentos: a loja é que manda (confirmação de servidor para servidor)', async () => {
    const auth = app.get(AuthService);
    const username = `ivo${stamp}`;
    const reg = await auth.register({ name: 'Ivo Loja', username, email: `${username}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt', languageSource: 'auto', timezone: 'Europe/Lisbon' });
    const I = reg.accessToken;
    const ivo = reg.user.id;
    const DAY = 86_400_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const planOf = async () => (await api().get('/me', I)).body.data.plan;
    const daysLeft = (value: string) => (new Date(value).getTime() - Date.now()) / DAY;
    let seq = 0;
    const hook = (event: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/v1/billing/webhooks/revenuecat')
        .set('Authorization', 'Bearer test-webhook-secret')
        .send({ event: { id: `store-${stamp}-${++seq}`, app_user_id: ivo, environment: 'PRODUCTION', store: 'PLAY_STORE', event_timestamp_ms: Date.now(), ...event } });

    // O que "a loja" (RevenueCat) responde ao servidor — muda ao longo do teste.
    let store: Record<string, unknown> = {};
    let storeDown = false;
    const calls: Array<{ url: string; auth: string }> = [];
    const realFetch = global.fetch;
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (input: unknown, init?: unknown) => {
      const url = String(input);
      if (!url.startsWith('https://api.revenuecat.com/')) return realFetch(input as never, init as never);
      const headers = ((init as { headers?: Record<string, string> } | undefined)?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers.Authorization ?? '' });
      if (storeDown) return { ok: false, status: 503, json: async () => ({}) } as never;
      return { ok: true, status: 200, json: async () => ({ subscriber: store }) } as never;
    });
    process.env.REVENUECAT_SECRET_API_KEY = 'sk_teste';
    resetEnvCache();
    try {
      // --- A app pede para confirmar sem ter comprado nada: a loja não conhece a compra → continua grátis.
      const nothing = await api().post('/billing/sync', {}, I);
      expect(nothing.status).toBe(200);
      expect(nothing.body.data).toMatchObject({ plan: 'FREE', managementUrl: null });
      expect(calls[0]).toEqual({ url: `https://api.revenuecat.com/v1/subscribers/${ivo}`, auth: 'Bearer sk_teste' });

      // --- Um aviso diz "comprou o Premium+", mas a loja não o confirma: não dá acesso.
      await hook({ type: 'INITIAL_PURCHASE', product_id: 'contalex_premium_plus_yearly', entitlement_ids: ['premium_plus'], purchased_at_ms: Date.now(), expiration_at_ms: Date.now() + 365 * DAY }).expect(200);
      expect((await planOf()).code).toBe('FREE');

      // --- A loja confirma uma subscrição mensal (na Google Play o produto vem com o plano-base).
      const manage = 'https://play.google.com/store/account/subscriptions?sku=contalex_premium_monthly&package=app.contalex';
      const sub = { purchase_date: iso(Date.now()), expires_date: iso(Date.now() + 30 * DAY), store: 'play_store', is_sandbox: false, period_type: 'normal', unsubscribe_detected_at: null as string | null, billing_issues_detected_at: null, refunded_at: null };
      store = { subscriptions: { contalex_premium_monthly: sub }, entitlements: { premium: { product_identifier: 'contalex_premium_monthly' } }, management_url: manage };
      const bought = await api().post('/billing/sync', {}, I);
      expect(bought.body.data).toMatchObject({ plan: 'PREMIUM', kind: 'SUBSCRIPTION', autoRenew: true, canCancel: true, managementUrl: manage, productId: 'contalex_premium_monthly' });
      await hook({ type: 'INITIAL_PURCHASE', product_id: 'contalex_premium_monthly:mensal', entitlement_ids: ['premium'], purchased_at_ms: Date.now(), expiration_at_ms: Date.now() + 30 * DAY, price: 3.29, currency: 'EUR', price_in_purchased_currency: 2.99 }).expect(200);
      // O aviso e a confirmação falam da mesma subscrição: uma linha só (mais a que a loja não confirmou, já sem efeito).
      expect(await prisma.subscription.count({ where: { userId: ivo, productId: 'contalex_premium_monthly' } })).toBe(1);
      expect(await prisma.subscription.count({ where: { userId: ivo, status: { in: ['ACTIVE', 'TRIAL', 'CANCELLED', 'BILLING_ISSUE'] } } })).toBe(1);
      expect(await prisma.revenueEvent.count({ where: { userId: ivo, productId: 'contalex_premium_monthly' } })).toBe(1);

      // --- Cancela na loja: deixa de renovar, mas o que pagou continua até ao fim.
      sub.unsubscribe_detected_at = iso(Date.now());
      const cancelled = (await api().post('/billing/sync', {}, I)).body.data;
      expect(cancelled).toMatchObject({ plan: 'PREMIUM', state: 'CANCELLED', autoRenew: false, canCancel: false });
      expect(daysLeft(cancelled.expirationDate)).toBeGreaterThan(29.9);

      // --- A loja está em baixo: fica tudo como estava (não se perde nem se ganha o plano).
      storeDown = true;
      const down = await api().post('/billing/sync', {}, I);
      expect(down.status).toBe(200);
      expect(down.body.data).toMatchObject({ plan: 'PREMIUM', state: 'CANCELLED', managementUrl: null });
      storeDown = false;

      // --- A subscrição acabou e a pessoa paga duas vezes "uma vez": os dias somam-se.
      const t = Date.now();
      store = {
        subscriptions: { contalex_premium_monthly: { ...sub, expires_date: iso(t - DAY) } },
        entitlements: {},
        non_subscriptions: {
          contalex_premium_pass_month: [
            { purchase_date: iso(t), store: 'play_store', is_sandbox: false, store_transaction_id: 'GPA.0001' },
            { purchase_date: iso(t), store: 'play_store', is_sandbox: false, store_transaction_id: 'GPA.0002' },
          ],
          produto_que_nao_existe: [{ purchase_date: iso(t), store: 'play_store', is_sandbox: false, store_transaction_id: 'GPA.0009' }],
        },
      };
      const passes = (await api().post('/billing/sync', {}, I)).body.data;
      expect(passes).toMatchObject({ plan: 'PREMIUM', kind: 'ONE_TIME', autoRenew: false, canCancel: false, productId: 'contalex_premium_pass_month' });
      expect(daysLeft(passes.expirationDate)).toBeGreaterThan(61.9);
      expect(daysLeft(passes.expirationDate)).toBeLessThan(62.1);
      // O aviso de uma dessas compras chega atrasado e, nesse momento, a loja não responde:
      // a compra já estava contada (a confirmação foi depois dela) — não soma outra vez.
      storeDown = true;
      await hook({ type: 'NON_RENEWING_PURCHASE', product_id: 'contalex_premium_pass_month', transaction_id: 'GPA.0002', purchased_at_ms: t, price: 5.49, currency: 'EUR', price_in_purchased_currency: 4.99 }).expect(200);
      storeDown = false;
      expect(daysLeft((await planOf()).expirationDate)).toBeLessThan(62.1);
      expect(await prisma.subscription.count({ where: { userId: ivo, kind: 'ONE_TIME', isPaid: true, verifiedAt: { not: null } } })).toBe(1);

      // --- A loja devolve uma das compras, mas ainda a lista: não volta a contar.
      const refund = { type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', product_id: 'contalex_premium_pass_month', price: -5.49, currency: 'EUR', price_in_purchased_currency: -4.99 };
      await hook({ ...refund, transaction_id: 'GPA.0002' }).expect(200);
      let plan = await planOf();
      expect(plan.code).toBe('PREMIUM');
      expect(daysLeft(plan.expirationDate)).toBeGreaterThan(30.9);
      expect(daysLeft(plan.expirationDate)).toBeLessThan(31.1);
      await api().post('/billing/sync', {}, I).expect(200);
      expect(daysLeft((await planOf()).expirationDate)).toBeLessThan(31.1);
      // Devolvida a outra também: o plano acaba no momento.
      await hook({ ...refund, transaction_id: 'GPA.0001' }).expect(200);
      plan = await planOf();
      expect(plan).toMatchObject({ code: 'FREE', state: 'EXPIRED', refunded: true });
      await api().post('/billing/sync', {}, I).expect(200);
      expect((await planOf()).code).toBe('FREE');
      // Avisos: um "bem-vindo" (quando a loja confirmou) e um "terminou" — o aviso que a loja não confirmou não gerou nenhum.
      expect(await prisma.notification.count({ where: { userId: ivo, type: 'subscription_active' } })).toBe(1);
      expect(await prisma.notification.count({ where: { userId: ivo, type: { in: ['subscription_ended', 'subscription_ended_locked'] } } })).toBe(1);
    } finally {
      spy.mockRestore();
      delete process.env.REVENUECAT_SECRET_API_KEY;
      resetEnvCache();
    }
  });

  it('limite do dia, total das linhas, objetivos com datas e passos, e reutilizar um plano antigo', async () => {
    const auth = app.get(AuthService);
    const username = `limite${stamp}`;
    const reg = await auth.register({ name: 'Lia Dia', username, email: `${username}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt', languageSource: 'auto', timezone: 'Europe/Lisbon' });
    const L = reg.accessToken;
    const lia = reg.user.id;
    const cats = (await api().get('/categories', L)).body.data as Array<{ id: string; key: string }>;
    const cat = (key: string) => (cats.find((c) => c.key === key) as { id: string }).id;
    const acc = (await api().post('/accounts', { name: 'Conta', type: 'BANK', initialBalance: 3000 }, L)).body.data.id;
    const spend = async (amount: number, extra: object = {}) => {
      await api().post('/transactions', { type: 'EXPENSE', amount, accountId: acc, categoryId: cat('food'), date: today, ...extra }, L).expect(201);
      await new Promise((r) => setTimeout(r, 300));
    };
    const alerts = (type: string) => prisma.notification.count({ where: { userId: lia, type } });
    const day = async (query = '') => (await api().get(`/daily-limit${query}`, L)).body.data;

    // --- Sem limite: o dia mostra-se, mas não há nada para cumprir.
    const none = await day('?week=true&suggest=true');
    expect(none).toMatchObject({ date: today, limit: null, spent: 0, left: null, percent: null, status: null, defaultLimit: null, onlyToday: false, suggestion: null, currency: 'EUR' });
    expect(none.week).toHaveLength(7);
    expect((await api().put('/daily-limit', { amount: -1 }, L)).status).toBe(400);

    // --- "Hoje podes gastar 20": gastei 10, faltam 10.
    const set = await api().put('/daily-limit', { amount: 20 }, L);
    expect(set.status).toBe(200);
    expect(set.body.data).toMatchObject({ limit: 20, spent: 0, left: 20, status: 'OK', defaultLimit: 20, onlyToday: false });
    await spend(10);
    expect(await day()).toMatchObject({ limit: 20, spent: 10, left: 10, percent: 50, status: 'OK' });
    expect(await alerts('daily_limit_warning')).toBe(0);
    // Aos 80% avisa uma vez…
    await spend(7);
    await spend(1);
    expect(await day()).toMatchObject({ spent: 18, left: 2, status: 'WARNING' });
    expect(await alerts('daily_limit_warning')).toBe(1);
    // …e ao chegar ao limite, outra (passar dele depois já não repete).
    await spend(2);
    expect(await day()).toMatchObject({ spent: 20, left: 0, percent: 100, status: 'REACHED' });
    await spend(5);
    expect(await alerts('daily_limit_reached')).toBe(1);
    expect(await alerts('daily_limit_exceeded')).toBe(0);
    const over = await day('?week=true');
    expect(over).toMatchObject({ spent: 25, left: -5, percent: 125, status: 'EXCEEDED' });
    expect(over.week[6]).toMatchObject({ date: today, limit: 20, spent: 25, status: 'EXCEEDED' });
    expect(over.week[5]).toMatchObject({ date: addDays(today, -1), limit: 20, spent: 0, status: 'OK' });

    // As despesas fixas (renda, mensalidades) e as de outros dias não contam para o dia de hoje.
    const rent = await api().post('/recurring', { type: 'EXPENSE', amount: 650, accountId: acc, description: 'Renda', frequency: 'MONTHLY', startDate: today }, L);
    expect(await prisma.transaction.count({ where: { recurringRuleId: rent.body.data.id } })).toBe(1);
    await spend(30, { date: addDays(today, -1) });
    const after = await day('?week=true');
    expect(after.spent).toBe(25);
    expect(after.week[5]).toMatchObject({ spent: 30, status: 'EXCEEDED' });

    // --- Só hoje: um dia diferente dos outros (o limite de todos os dias fica como estava).
    const todayOnly = await api().put('/daily-limit', { amount: 40, onlyToday: true }, L);
    expect(todayOnly.body.data).toMatchObject({ limit: 40, defaultLimit: 20, onlyToday: true, spent: 25, left: 15, status: 'OK' });
    expect(todayOnly.body.data.week[5].limit).toBe(20);
    expect((await api().get('/dashboard', L)).body.data.dailyLimit).toMatchObject({ limit: 40, left: 15, onlyToday: true });
    // Com o limite novo, os avisos recomeçam.
    await spend(8);
    expect(await day()).toMatchObject({ spent: 33, left: 7, status: 'WARNING' });
    expect(await alerts('daily_limit_warning')).toBe(2);
    // Tirar o de hoje volta ao de todos os dias; tirar esse deixa o dia sem limite.
    expect((await api().put('/daily-limit', { amount: null, onlyToday: true }, L)).body.data).toMatchObject({ limit: 20, onlyToday: false, status: 'EXCEEDED' });
    expect(await alerts('daily_limit_exceeded')).toBe(0); // quem muda o limite já está a ver o dia
    expect((await api().put('/daily-limit', { amount: null }, L)).body.data).toMatchObject({ limit: null, status: null, defaultLimit: null });
    // Um dia para não gastar nada: limite 0.
    expect((await api().put('/daily-limit', { amount: 0, onlyToday: true }, L)).body.data).toMatchObject({ limit: 0, left: -33, status: 'EXCEEDED', percent: null });
    await api().put('/daily-limit', { amount: null, onlyToday: true }, L).expect(200);
    // Saltar logo para lá do limite dá o aviso de "passaste".
    await api().put('/daily-limit', { amount: 100 }, L).expect(200);
    await spend(80);
    expect(await day()).toMatchObject({ limit: 100, spent: 113, status: 'EXCEEDED' });
    expect(await alerts('daily_limit_exceeded')).toBe(1);

    // --- Plano de compras: produto, quantidade e preço → o total faz-se sozinho.
    const shop = await api().post(
      '/plans',
      { name: 'Compras do mês', type: 'SHOPPING', items: [{ title: 'Arroz', quantity: 3, unitPrice: 1.2 }, { title: 'Azeite', estimatedAmount: 7.5 }, { title: 'Leite', quantity: 6, unitPrice: 0.89, estimatedAmount: 1 }] },
      L,
    );
    expect(shop.status).toBe(201);
    const [rice, oil, milk] = shop.body.data.items;
    expect(rice).toMatchObject({ quantity: 3, unitPrice: 1.2, estimatedAmount: 3.6 });
    expect(oil).toMatchObject({ quantity: 1, unitPrice: null, estimatedAmount: 7.5 });
    expect(milk).toMatchObject({ unitPrice: 0.89, estimatedAmount: 5.34 }); // com preço por unidade, é ele que manda
    expect(shop.body.data.estimated).toBe(16.44);
    const planId = shop.body.data.id;
    const itemOf = (plan: { items: Array<{ id: string }> }, id: string) => plan.items.find((i) => i.id === id);
    // Mudar a quantidade refaz o total; dar só o total larga o preço por unidade.
    const more = await api().patch(`/plans/${planId}/items/${rice.id}`, { quantity: 5 }, L);
    expect(itemOf(more.body.data, rice.id)).toMatchObject({ quantity: 5, unitPrice: 1.2, estimatedAmount: 6 });
    const total = await api().patch(`/plans/${planId}/items/${rice.id}`, { estimatedAmount: 10 }, L);
    expect(itemOf(total.body.data, rice.id)).toMatchObject({ quantity: 5, unitPrice: null, estimatedAmount: 10 });
    const priced = await api().patch(`/plans/${planId}/items/${oil.id}`, { unitPrice: 2, quantity: 4 }, L);
    expect(itemOf(priced.body.data, oil.id)).toMatchObject({ quantity: 4, unitPrice: 2, estimatedAmount: 8 });
    const added = await api().post(`/plans/${planId}/items`, { title: 'Ovos', quantity: 2, unitPrice: 2.5 }, L);
    expect(added.body.data.items.find((i: { title: string }) => i.title === 'Ovos')).toMatchObject({ unitPrice: 2.5, estimatedAmount: 5 });
    expect(added.body.data.estimated).toBe(28.34); // 10 + 8 + 5,34 + 5
    const copy = await api().post(`/plans/${planId}/duplicate`, {}, L);
    expect(copy.body.data.items.find((i: { title: string }) => i.title === 'Leite')).toMatchObject({ quantity: 6, unitPrice: 0.89, estimatedAmount: 5.34 });

    // --- Objetivo com dia de início e de fim, e os objetivos específicos lá dentro.
    expect((await api().post('/goals', { name: 'Ao contrário', targetAmount: 100, startDate: addDays(today, 10), targetDate: addDays(today, 5) }, L)).body.error.code).toBe('DATE_RANGE_INVALID');
    const late = await api().post('/goals', { name: 'Passo fora', targetAmount: 100, targetDate: addDays(today, 5), steps: [{ title: 'Tarde demais', dueDate: addDays(today, 9) }] }, L);
    expect(late.body.error.code).toBe('GOAL_STEP_AFTER_END');
    const house = await api().post(
      '/goals',
      {
        name: 'Casa',
        targetAmount: 1000,
        startDate: addDays(today, -10),
        targetDate: addDays(today, 90),
        steps: [{ title: 'Entrada', amount: 300, dueDate: addDays(today, 20) }, { title: 'Mobília', amount: 500 }, { title: 'Escolher o bairro' }],
      },
      L,
    );
    expect(house.status).toBe(201);
    const gid = house.body.data.id;
    // 10 de 100 dias já passaram: devia ter 100 de 1000 guardados.
    expect(house.body.data).toMatchObject({ startDate: addDays(today, -10), targetDate: addDays(today, 90), notStarted: false, daysLeft: 90, timePercent: 10, expectedSaved: 100, stepsTotal: 3, stepsDone: 0, stepsAmount: 800 });
    expect(house.body.data.steps.map((st: { title: string }) => st.title)).toEqual(['Entrada', 'Mobília', 'Escolher o bairro']);
    expect(house.body.data.steps[0]).toMatchObject({ amount: 300, dueDate: addDays(today, 20), done: false, covered: false, overdue: false });
    // O que se guarda vai cobrindo os passos pela ordem.
    const saved = await api().post(`/goals/${gid}/contributions`, { amount: 300 }, L);
    expect(saved.body.data.steps.map((st: { covered: boolean }) => st.covered)).toEqual([true, false, false]);
    const [entry, furniture, area] = saved.body.data.steps as Array<{ id: string }>;
    const done = await api().patch(`/goals/${gid}/steps/${area.id}`, { done: true }, L);
    expect(done.body.data).toMatchObject({ stepsDone: 1 });
    expect(done.body.data.steps[2].doneAt).toBeTruthy();
    expect((await api().patch(`/goals/${gid}/steps/${area.id}`, { done: false }, L)).body.data.stepsDone).toBe(0);
    expect((await api().patch(`/goals/${gid}/steps/${furniture.id}`, { dueDate: addDays(today, 91) }, L)).body.error.code).toBe('GOAL_STEP_AFTER_END');
    const dated = await api().patch(`/goals/${gid}/steps/${furniture.id}`, { dueDate: addDays(today, 80), title: 'Mobília da sala' }, L);
    expect(dated.body.data.steps[1]).toMatchObject({ title: 'Mobília da sala', dueDate: addDays(today, 80) });
    const extra = await api().post(`/goals/${gid}/steps`, { title: 'Notário', amount: 200, dueDate: addDays(today, 85) }, L);
    expect(extra.status).toBe(201);
    expect(extra.body.data).toMatchObject({ stepsTotal: 4, stepsAmount: 1000 });
    // Encurtar o objetivo puxa para o novo fim os passos que ficavam depois dele.
    const shorter = await api().patch(`/goals/${gid}`, { targetDate: addDays(today, 60) }, L);
    expect(shorter.body.data.steps.map((st: { dueDate: string | null }) => st.dueDate)).toEqual([addDays(today, 20), addDays(today, 60), null, addDays(today, 60)]);
    const removed = await api().del(`/goals/${gid}/steps/${entry.id}`, L);
    expect(removed.body.data).toMatchObject({ stepsTotal: 3, stepsAmount: 700 });
    expect((await api().del(`/goals/${gid}/steps/${entry.id}`, L)).body.error.code).toBe('GOAL_STEP_NOT_FOUND');
    // Um objetivo que só começa daqui a um mês: ainda não há ritmo para avaliar.
    const trip = await api().post('/goals', { name: 'Viagem', targetAmount: 600, startDate: addDays(today, 30), targetDate: addDays(today, 120) }, L);
    expect(trip.body.data).toMatchObject({ notStarted: true, timePercent: 0, expectedSaved: 0, onTrack: null, daysLeft: 120 });
    expect((await api().get('/goals', L)).body.data.find((g: { id: string }) => g.id === gid)).toMatchObject({ stepsTotal: 3, stepsDone: 0 });

    // --- Plano do mês: "o que vou comprar" é uma escolha por linha.
    const current = (await api().get('/monthly-plans/current', L)).body.data.period;
    const key = current.key as string;
    const savedPlan = await api().put(
      `/monthly-plans/${key}`,
      { plannedIncome: 1200, lines: [{ categoryId: cat('food'), amount: 400 }, { categoryId: cat('subscriptions'), amount: 30 }, { name: 'Prendas', amount: 40 }] },
      L,
    );
    expect(savedPlan.status).toBe(200);
    type Line = { id: string; categoryId: string | null; kind: string; list: boolean | null; canList: boolean };
    const lineOf = (plan: { lines: Line[] }, match: (l: Line) => boolean) => plan.lines.find(match) as Line;
    const food = lineOf(savedPlan.body.data.plan, (l) => l.categoryId === cat('food'));
    const subs = lineOf(savedPlan.body.data.plan, (l) => l.categoryId === cat('subscriptions'));
    const gifts = lineOf(savedPlan.body.data.plan, (l) => l.kind === 'CUSTOM');
    // Comida tem lista; as subscrições, à partida, não (não se "compram" numa lista).
    expect(food).toMatchObject({ list: null, canList: true });
    expect(subs).toMatchObject({ list: null, canList: false });
    expect(gifts).toMatchObject({ canList: false });
    const on = await api().patch(`/monthly-plans/${key}/lines/${subs.id}`, { list: true }, L);
    expect(lineOf(on.body.data.plan, (l) => l.categoryId === cat('subscriptions'))).toMatchObject({ list: true, canList: true });
    const off = await api().patch(`/monthly-plans/${key}/lines/${food.id}`, { list: false }, L);
    expect(lineOf(off.body.data.plan, (l) => l.categoryId === cat('food'))).toMatchObject({ list: false, canList: false });
    expect((await api().patch(`/monthly-plans/${key}/lines/${gifts.id}`, { list: true }, L)).body.error.code).toBe('MONTHLY_PLAN_NOT_FOUND');
    // Guardar o plano outra vez (sem falar na lista) não desfaz a escolha.
    const again = await api().put(`/monthly-plans/${key}`, { plannedIncome: 1200, lines: [{ categoryId: cat('food'), amount: 420 }, { categoryId: cat('subscriptions'), amount: 30 }] }, L);
    expect(lineOf(again.body.data.plan, (l) => l.categoryId === cat('food'))).toMatchObject({ list: false, canList: false });
    expect(lineOf(again.body.data.plan, (l) => l.categoryId === cat('subscriptions'))).toMatchObject({ list: true, canList: true });
    const auto = await api().patch(`/monthly-plans/${key}/lines/${lineOf(again.body.data.plan, (l) => l.categoryId === cat('food')).id}`, { list: null }, L);
    expect(lineOf(auto.body.data.plan, (l) => l.categoryId === cat('food'))).toMatchObject({ list: null, canList: true });
    // Com um plano do mês, o limite do dia tem uma sugestão ("o plano deixa gastar X por dia").
    expect((await day('?suggest=true')).suggestion).toBeGreaterThan(0);

    // --- Reutilizar um plano antigo, mesmo de há anos.
    await prisma.monthlyPlan.create({
      data: {
        userId: lia,
        periodKey: '2023-03',
        plannedIncome: 900,
        plannedSavings: 50,
        lines: { create: [{ categoryId: cat('food'), amount: 150, sortOrder: 0, list: false }, { categoryId: cat('transport'), amount: 45, sortOrder: 1 }, { name: 'Ginásio', amount: 25, sortOrder: 2 }] },
      },
    });
    const history = (await api().get('/monthly-plans?limit=60', L)).body.data.items as Array<{ key: string; isPast: boolean; linesCount: number; plannedExpenses: number }>;
    expect(history.map((h) => h.key)).toEqual([key, '2023-03']);
    expect(history[1]).toMatchObject({ isPast: true, linesCount: 3, plannedExpenses: 220 });
    expect(history[0].isPast).toBe(false);
    const nextKey = addDays(current.end, 1).slice(0, 7);
    expect((await api().post(`/monthly-plans/${nextKey}/copy-from/2019-01`, {}, L)).body.error.code).toBe('MONTHLY_PLAN_NOT_FOUND');
    expect((await api().post(`/monthly-plans/${nextKey}/copy-from/${nextKey}`, {}, L)).body.error.code).toBe('INVALID_REQUEST');
    expect((await api().post(`/monthly-plans/2023-04/copy-from/2023-03`, {}, L)).body.error.code).toBe('MONTHLY_PLAN_CLOSED');
    const reused = await api().post(`/monthly-plans/${nextKey}/copy-from/2023-03`, {}, L);
    expect(reused.status).toBe(200);
    expect(reused.body.data.plan).toMatchObject({ plannedIncome: 900, plannedSavings: 50, plannedExpenses: 220 });
    expect(reused.body.data.plan.lines).toHaveLength(3);
    expect(lineOf(reused.body.data.plan, (l) => l.categoryId === cat('food'))).toMatchObject({ list: false, canList: false });
    // O plano antigo fica como estava, e pode ser enviado a outra pessoa como modelo.
    expect((await api().get('/monthly-plans/2023-03', L)).body.data).toMatchObject({ exists: true, period: { isPast: true, editable: false } });
  });

  it('enviar objetivos, planos e limites; acompanhamento à medida; avisos e mensagens por ver', async () => {
    const auth = app.get(AuthService);
    const make = async (name: string, country = 'PT') => {
      const username = `envio.${name.toLowerCase()}${stamp}`;
      const r = await auth.register({ name: `${name} Envio`, username, email: `${username}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country, language: 'pt', languageSource: 'auto', timezone: 'Europe/Lisbon' });
      return { token: r.accessToken, id: r.user.id, username };
    };
    const ana = await make('Ana');
    const bia = await make('Bia');
    const caio = await make('Caio', 'BR');
    const A = ana.token;
    const B = bia.token;
    const C = caio.token;
    type Cat = { id: string; key: string | null; name: string };
    const catsOf = async (token: string) => (await api().get('/categories', token)).body.data as Cat[];
    const catsA = await catsOf(A);
    const catsB = await catsOf(B);
    const idOf = (list: Cat[], key: string) => (list.find((c) => c.key === key) as Cat).id;
    const notes = (userId: string, type: string) => prisma.notification.count({ where: { userId, type } });
    const healthA = idOf(catsA, 'health');

    // ====== Enviar um objetivo: vai o molde (alvo, duração e passos), nunca o dinheiro guardado.
    const goal = (
      await api().post(
        '/goals',
        {
          name: 'Casamento',
          targetAmount: 1000,
          startDate: addDays(today, -20),
          targetDate: addDays(today, 80),
          initialAmount: 400,
          steps: [{ title: 'Sinal da quinta', amount: 300, dueDate: addDays(today, 10) }, { title: 'Fato', amount: 200 }, { title: 'Convites', dueDate: addDays(today, 70), done: true }],
        },
        A,
      )
    ).body.data;
    expect((await api().post('/offers', { kind: 'GOAL', itemId: goal.id, username: ana.username }, A)).body.error.code).toBe('OFFER_SELF');
    expect((await api().post('/offers', { kind: 'GOAL', itemId: goal.id, username: 'ninguem.aqui' }, A)).body.error.code).toBe('USER_NOT_FOUND');
    // Só se envia o que é meu.
    expect((await api().post('/offers', { kind: 'GOAL', itemId: goal.id, username: ana.username }, B)).body.error.code).toBe('GOAL_NOT_FOUND');
    expect((await api().post('/offers', { kind: 'GOAL', itemId: goal.id }, A)).status).toBe(400);
    const sent = await api().post('/offers', { kind: 'GOAL', itemId: goal.id, username: bia.username, note: 'Usa este como ponto de partida' }, A);
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ kind: 'GOAL', status: 'PENDING', mine: true, title: 'Casamento', amount: 1000, days: 100, count: 3, currency: 'EUR', note: 'Usa este como ponto de partida' });
    const offerId = sent.body.data.id;
    // Voltar a enviar atualiza o mesmo envio e não repete o aviso.
    const resent = await api().post('/offers', { kind: 'GOAL', itemId: goal.id, userId: bia.id, note: 'Usa este como ponto de partida' }, A);
    expect(resent.body.data.id).toBe(offerId);
    expect(await notes(bia.id, 'item_offer')).toBe(1);

    const inboxB = (await api().get('/offers', B)).body.data;
    expect(inboxB).toMatchObject({ pendingCount: 1, sent: [] });
    expect(inboxB.received[0]).toMatchObject({ id: offerId, mine: false, from: { username: ana.username } });
    const asked = (await api().get('/me/requests', B)).body.data;
    expect(asked.items.find((r: { kind: string }) => r.kind === 'item')).toMatchObject({ id: offerId, itemKind: 'GOAL', title: 'Casamento' });
    const seen = (await api().get(`/offers/${offerId}`, B)).body.data;
    expect(seen.goal).toMatchObject({ name: 'Casamento', targetAmount: 1000, days: 100, suggestedStart: today, suggestedEnd: addDays(today, 100) });
    expect(seen.goal.steps).toEqual([
      { title: 'Sinal da quinta', amount: 300, offsetDays: 30 },
      { title: 'Fato', amount: 200, offsetDays: null },
      { title: 'Convites', amount: null, offsetDays: 90 },
    ]);
    expect(seen.goal.saved).toBeUndefined();
    expect((await api().get(`/offers/${offerId}`, C)).body.error.code).toBe('OFFER_NOT_FOUND');

    // Quem aceita ajusta à sua vida: o nome e o dia em que começa (o fim e os passos acompanham).
    expect((await api().post(`/offers/${offerId}/accept`, {}, A)).body.error.code).toBe('OFFER_NOT_FOUND');
    expect((await api().post(`/offers/${offerId}/accept`, { startDate: addDays(today, 5), targetDate: addDays(today, 1) }, B)).body.error.code).toBe('DATE_RANGE_INVALID');
    const accepted = await api().post(`/offers/${offerId}/accept`, { name: 'O meu casamento', startDate: addDays(today, 5) }, B);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.offer).toMatchObject({ status: 'ACCEPTED', createdItemId: accepted.body.data.createdItemId });
    const mineNow = (await api().get(`/goals/${accepted.body.data.createdItemId}`, B)).body.data;
    expect(mineNow).toMatchObject({ name: 'O meu casamento', targetAmount: 1000, saved: 0, startDate: addDays(today, 5), targetDate: addDays(today, 105), notStarted: true, stepsTotal: 3, stepsDone: 0 });
    expect(mineNow.steps.map((st: { dueDate: string | null }) => st.dueDate)).toEqual([addDays(today, 35), null, addDays(today, 95)]);
    expect(await notes(ana.id, 'item_offer_accepted')).toBe(1);
    expect((await api().post(`/offers/${offerId}/accept`, {}, B)).body.error.code).toBe('OFFER_CLOSED');
    expect((await api().post(`/offers/${offerId}/decline`, {}, B)).body.error.code).toBe('OFFER_CLOSED');
    // Quem enviou sabe que foi aceite, mas não fica com a chave do que a outra pessoa criou.
    expect((await api().get('/offers', A)).body.data.sent[0]).toMatchObject({ status: 'ACCEPTED', createdItemId: null });
    expect((await api().get('/me/requests', B)).body.data.items.some((r: { kind: string }) => r.kind === 'item')).toBe(false);

    // Para quem usa outra moeda, os valores chegam convertidos (1 EUR = 6 BRL nos testes).
    const toCaio = (await api().post('/offers', { kind: 'GOAL', itemId: goal.id, userId: caio.id }, A)).body.data;
    const real = await api().post(`/offers/${toCaio.id}/accept`, { targetDate: null }, C);
    const goalC = (await api().get(`/goals/${real.body.data.createdItemId}`, C)).body.data;
    expect(goalC).toMatchObject({ currency: 'BRL', targetAmount: 6000, startDate: today, targetDate: null });
    expect(goalC.steps.map((st: { amount: number | null }) => st.amount)).toEqual([1800, 1200, null]);

    // ====== Enviar um plano: quem recebe escolhe o mês em que o quer usar.
    const plan = (
      await api().post(
        '/plans',
        {
          name: 'Festa de anos',
          type: 'EVENT',
          budget: 200,
          description: 'No jardim',
          items: [{ title: 'Bolo', estimatedAmount: 35 }, { title: 'Sumos', quantity: 6, unitPrice: 1.5 }, { title: 'Balões', estimatedAmount: 8, isDone: true, actualAmount: 9.9 }],
        },
        A,
      )
    ).body.data;
    const planOffer = (await api().post('/offers', { kind: 'PLAN', itemId: plan.id, userId: bia.id }, A)).body.data;
    expect(planOffer).toMatchObject({ kind: 'PLAN', title: 'Festa de anos', amount: 200, count: 3, planType: 'EVENT' });
    const planSeen = (await api().get(`/offers/${planOffer.id}`, B)).body.data;
    expect(planSeen.months).toHaveLength(12);
    expect(planSeen.months[0].isCurrent).toBe(true);
    expect(planSeen.plan).toMatchObject({ name: 'Festa de anos', type: 'EVENT', description: 'No jardim', budget: 200 });
    // Vai o planeado; o que já está feito e quanto custou de facto fica com quem envia.
    expect(planSeen.plan.items[2]).toEqual({ title: 'Balões', notes: null, quantity: 1, unitPrice: null, estimatedAmount: 8, kind: 'COST', categoryKey: null });
    const month = planSeen.months[2].key as string;
    const planAccepted = await api().post(`/offers/${planOffer.id}/accept`, { periodKey: month }, B);
    expect(planAccepted.status).toBe(200);
    const planB = (await api().get(`/plans/${planAccepted.body.data.createdItemId}`, B)).body.data;
    expect(planB).toMatchObject({ name: 'Festa de anos', type: 'EVENT', budget: 200, periodKey: month, estimated: 52, spent: 0, itemsDone: 0 });
    expect(planB.items.find((i: { title: string }) => i.title === 'Sumos')).toMatchObject({ quantity: 6, unitPrice: 1.5, estimatedAmount: 9 });
    expect(planB.items.find((i: { title: string }) => i.title === 'Balões')).toMatchObject({ isDone: false, actualAmount: null });

    // ====== Enviar um limite de gastos: usa as categorias de quem recebe.
    const pets = (await api().post('/categories', { name: 'Animais', type: 'EXPENSE' }, A)).body.data;
    const budget = (await api().post('/budgets', { name: 'Comer e saúde', amount: 150, categoryIds: [idOf(catsA, 'food'), healthA, pets.id] }, A)).body.data;
    const budgetOffer = (await api().post('/offers', { kind: 'BUDGET', itemId: budget.id, userId: bia.id }, A)).body.data;
    expect(budgetOffer).toMatchObject({ kind: 'BUDGET', amount: 150, count: 3, period: 'MONTHLY' });
    const budgetSeen = (await api().get(`/offers/${budgetOffer.id}`, B)).body.data;
    expect(budgetSeen.budget.categories.map((c: { key: string | null; name: string | null; matched: boolean }) => `${c.key ?? c.name}:${c.matched}`).sort()).toEqual(['Animais:false', 'food:true', 'health:true']);
    const budgetAccepted = await api().post(`/offers/${budgetOffer.id}/accept`, {}, B);
    expect(budgetAccepted.status).toBe(200);
    const budgetB = (await api().get('/budgets', B)).body.data.find((b: { id: string }) => b.id === budgetAccepted.body.data.createdItemId);
    expect(budgetB).toMatchObject({ name: 'Comer e saúde', amount: 150 });
    expect([...budgetB.categoryIds].sort()).toEqual([idOf(catsB, 'food'), idOf(catsB, 'health')].sort());
    // Um limite só de categorias que a outra pessoa não tem não vira um limite de "todas as despesas".
    const petsOnly = (await api().post('/budgets', { name: 'Animais', amount: 40, categoryIds: [pets.id] }, A)).body.data;
    const petsOffer = (await api().post('/offers', { kind: 'BUDGET', itemId: petsOnly.id, userId: bia.id }, A)).body.data;
    expect((await api().post(`/offers/${petsOffer.id}/accept`, {}, B)).body.error.code).toBe('OFFER_NO_CATEGORY');
    await api().post(`/offers/${petsOffer.id}/decline`, {}, B).expect(200);
    expect(await notes(ana.id, 'item_offer_declined')).toBe(1);
    // Quem enviou pode tirar um envio da sua lista.
    expect((await api().del(`/offers/${petsOffer.id}`, B)).body.error.code).toBe('OFFER_NOT_FOUND');
    await api().del(`/offers/${petsOffer.id}`, A).expect(200);
    expect((await api().get('/offers', A)).body.data.sent.some((o: { id: string }) => o.id === petsOffer.id)).toBe(false);

    // ====== Acompanhamento: quem partilha escolhe o que mostra e o que fica só para si.
    const accA = (await api().post('/accounts', { name: 'Conta da Ana', type: 'BANK', initialBalance: 5000 }, A)).body.data.id;
    const move = (body: object) => api().post('/transactions', { accountId: accA, date: today, ...body }, A).expect(201);
    await move({ type: 'INCOME', amount: 2000, categoryId: idOf(catsA, 'salary'), description: 'Ordenado' });
    await move({ type: 'EXPENSE', amount: 60, categoryId: idOf(catsA, 'food'), description: 'Mercado do bairro' });
    await move({ type: 'EXPENSE', amount: 25, categoryId: idOf(catsA, 'transport'), description: 'Passe' });
    await move({ type: 'EXPENSE', amount: 90, categoryId: healthA, description: 'Consulta' });
    await move({ type: 'EXPENSE', amount: 15, description: 'Sem categoria' });
    const fixed = (body: object) => api().post('/recurring', { accountId: accA, frequency: 'MONTHLY', startDate: addDays(today, 3), autoCreate: false, ...body }, A).expect(201);
    await fixed({ type: 'EXPENSE', amount: 12, categoryId: idOf(catsA, 'subscriptions'), description: 'Música' });
    await fixed({ type: 'EXPENSE', amount: 30, categoryId: healthA, description: 'Seguro de saúde' });
    await fixed({ type: 'INCOME', amount: 2000, categoryId: idOf(catsA, 'salary'), description: 'Ordenado' });
    await api().post('/budgets', { name: 'Transportes', amount: 50, categoryIds: [idOf(catsA, 'transport')] }, A).expect(201);
    const keyA = (await api().get('/monthly-plans/current', A)).body.data.period.key as string;
    await api()
      .put(`/monthly-plans/${keyA}`, { plannedIncome: 2000, plannedSavings: 100, lines: [{ categoryId: idOf(catsA, 'food'), amount: 300 }, { categoryId: healthA, amount: 100 }, { categoryId: idOf(catsA, 'transport'), amount: 40 }] }, A)
      .expect(200);
    await prisma.monthlyPlan.create({
      data: { userId: ana.id, periodKey: '2024-05', plannedIncome: 1800, lines: { create: [{ categoryId: idOf(catsA, 'food'), amount: 250, sortOrder: 0 }, { categoryId: healthA, amount: 80, sortOrder: 1 }] } },
    });

    // Só se reservam categorias minhas.
    expect((await api().post('/sharing/invitations', { username: bia.username, hiddenCategoryIds: [idOf(catsB, 'health')] }, A)).body.error.code).toBe('CATEGORY_NOT_FOUND');
    const wanted = ['plan', 'budgets', 'goals', 'plans', 'recurring', 'transactions'];
    const invite = await api().post('/sharing/invitations', { username: bia.username, sections: wanted, hiddenCategoryIds: [healthA] }, A);
    expect(invite.status).toBe(201);
    expect(invite.body.data).toMatchObject({ scope: 'FULL', partial: true, hiddenCategoryIds: [healthA] });
    expect([...invite.body.data.sections].sort()).toEqual([...wanted].sort());
    const sid = invite.body.data.id;
    expect((await api().get('/me/requests', B)).body.data.items.find((r: { kind: string }) => r.kind === 'sharing').sections).toHaveLength(6);
    await api().post(`/sharing/${sid}/accept`, {}, B).expect(200);
    // Quem acompanha sabe que há coisas reservadas, mas não quais.
    expect((await api().get('/sharing', B)).body.data.received[0]).toMatchObject({ partial: true, hiddenCategoryIds: [] });

    const ov = (await api().get(`/sharing/${sid}/overview`, B)).body.data;
    expect(ov.status).toBeUndefined();
    // Sem o que entra, e sem a saúde em lado nenhum: 60 + 25 + 15.
    expect(ov).toMatchObject({ partial: true, income: null, net: null, savingsRate: null, expenses: 100 });
    expect([...ov.sections].sort()).toEqual([...wanted].sort());
    expect(JSON.stringify(ov)).not.toContain(healthA);
    expect(JSON.stringify(ov)).not.toContain('Seguro de saúde');
    expect(ov.plan).toMatchObject({ plannedIncome: null, plannedExpenses: 340 });
    expect(ov.plan.lines).toHaveLength(2);
    // Um limite que junta a saúde não se mostra; os outros sim.
    expect(ov.budgets.map((b: { name: string }) => b.name).sort()).toEqual(['Animais', 'Transportes']);
    expect(ov.goals).toHaveLength(1);
    expect(ov.goals[0]).toMatchObject({ name: 'Casamento', stepsTotal: 3, stepsDone: 1, startDate: addDays(today, -20) });
    expect(ov.plans.map((p: { name: string }) => p.name)).toEqual(['Festa de anos']);
    expect(ov.recurring.map((r: { description: string }) => r.description)).toEqual(['Música']);
    expect(ov.recurringMonthly).toBe(12);

    // A lista de movimentos, com filtros.
    const txs = async (query = '') => (await api().get(`/sharing/${sid}/transactions${query}`, B)).body;
    expect((await txs()).data.map((t: { description: string }) => t.description).sort()).toEqual(['Mercado do bairro', 'Passe', 'Sem categoria']);
    expect((await txs('?type=INCOME')).data).toEqual([]);
    expect((await txs(`?categoryId=${healthA}`)).data).toEqual([]);
    expect((await txs('?q=mercado')).data.map((t: { description: string }) => t.description)).toEqual(['Mercado do bairro']);
    expect((await txs('?minAmount=20&maxAmount=70')).data.map((t: { amount: number }) => t.amount).sort((a: number, b: number) => a - b)).toEqual([25, 60]);
    expect((await txs(`?categoryId=${idOf(catsA, 'transport')}`)).data).toHaveLength(1);
    expect((await txs(`?from=${addDays(today, -400)}&to=${addDays(today, -1)}`)).data).toEqual([]);
    expect((await txs(`?from=${addDays(today, -400)}`)).data).toHaveLength(3);
    expect((await txs(`?from=${today}&to=${addDays(today, -1)}`)).error.code).toBe('DATE_RANGE_INVALID');
    expect((await api().get(`/sharing/${sid}/transactions?limit=1000`, B)).status).toBe(400);

    // Os planos dos meses passados (e abrir um deles).
    const hist = (await api().get(`/sharing/${sid}/history`, B)).body.data;
    expect(hist.items.map((i: { key: string }) => i.key)).toEqual([keyA, '2024-05']);
    expect(hist.items[0]).toMatchObject({ isCurrent: true, plannedExpenses: 340, actualExpenses: 100 });
    expect(hist.items[1]).toMatchObject({ isCurrent: false, plannedExpenses: 250, actualExpenses: 0, difference: -250 });
    const old = (await api().get(`/sharing/${sid}/overview?month=2024-05`, B)).body.data;
    expect(old.period).toMatchObject({ key: '2024-05', isCurrent: false });
    expect(old.plan.lines).toHaveLength(1);

    // Quem partilha muda de ideias: agora só o que entra e os limites, sem nada reservado.
    expect((await api().patch(`/sharing/${sid}`, { sections: ['income'] }, B)).status).toBe(404);
    expect((await api().patch(`/sharing/${sid}`, {}, A)).status).toBe(400);
    const changed = await api().patch(`/sharing/${sid}`, { sections: ['income', 'budgets'], hiddenCategoryIds: [] }, A);
    expect(changed.body.data).toMatchObject({ scope: 'SUMMARY', partial: false, sections: ['income', 'budgets'], hiddenCategoryIds: [] });
    const ov2 = (await api().get(`/sharing/${sid}/overview`, B)).body.data;
    expect(ov2).toMatchObject({ partial: false, income: 2000, expenses: 190, net: 1810, plan: null, goals: [], plans: [], recurring: [], recurringMonthly: 0 });
    expect(ov2.budgets.map((b: { name: string }) => b.name).sort()).toEqual(['Animais', 'Comer e saúde', 'Transportes']);
    expect((await api().get(`/sharing/${sid}/history`, B)).body.error.code).toBe('SHARE_SECTION_HIDDEN');
    expect((await txs()).error.code).toBe('SHARE_SCOPE_SUMMARY');
    // "Completo" junta a lista de movimentos ao que já se mostrava.
    expect([...(await api().patch(`/sharing/${sid}`, { scope: 'FULL' }, A)).body.data.sections].sort()).toEqual(['budgets', 'income', 'transactions']);
    expect((await txs('?type=INCOME')).data.map((t: { amount: number }) => t.amount)).toEqual([2000]);

    // ====== O que há por ver: avisos e mensagens contam-se à parte, até serem vistos.
    const before = (await api().get('/inbox', B)).body.data;
    expect(before.messages).toBe(0);
    expect(before.notifications).toBeGreaterThan(0);
    expect(before.notifications).toBe((await api().get('/notifications/unread-count', B)).body.data.count);
    expect(typeof before.latest.type).toBe('string');
    await api().post(`/chats/direct/${bia.id}`, { text: 'Viste o plano que te enviei?' }, A).expect(201);
    await api().post(`/chats/direct/${bia.id}`, { text: 'Diz-me o que achas' }, A).expect(201);
    const withMessages = (await api().get('/inbox', B)).body.data;
    expect(withMessages).toMatchObject({ notifications: before.notifications, messages: 2, latest: { type: 'chat_direct' } });
    expect(withMessages.latest.id).not.toBe(before.latest.id);
    // As mensagens não entram na lista dos avisos: têm o seu sítio.
    expect((await api().get('/notifications', B)).body.data.some((n: { type: string }) => n.type === 'chat_direct')).toBe(false);
    expect((await api().get('/chats/unread', B)).body.data.count).toBe(2);
    // Abrir a conversa dá as mensagens por vistas; "ler tudo" trata dos avisos.
    await api().get(`/chats/direct/${ana.id}`, B).expect(200);
    expect((await api().get('/inbox', B)).body.data).toMatchObject({ notifications: before.notifications, messages: 0 });
    await api().post('/notifications/read-all', {}, B).expect(201);
    expect((await api().get('/inbox', B)).body.data).toEqual({ notifications: 0, messages: 0, latest: null, pending: 0 });
  });

  it('quem acompanha ajuda a gerir; perfis com "sobre mim"; lembretes nos empréstimos e nos Spaces', async () => {
    const auth = app.get(AuthService);
    const make = async (name: string) => {
      const username = `ajuda.${name.toLowerCase()}${stamp}`;
      const r = await auth.register({ name: `${name} Ajuda`, username, email: `${username}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt', languageSource: 'auto', timezone: 'Europe/Lisbon' });
      return { token: r.accessToken, id: r.user.id, username };
    };
    const dona = await make('Dona');
    const mae = await make('Mae');
    const outro = await make('Outro');
    const D = dona.token;
    const M = mae.token;
    // Pedidos de quem ajuda: os mesmos caminhos, com o cabeçalho do acesso.
    const helping = (accessId: string, token = M) => {
      const go = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('Accept-Language', 'pt').set('X-Contalex-Help', accessId);
      const http = () => request(app.getHttpServer());
      return {
        get: (url: string) => go(http().get(`/v1${url}`)),
        post: (url: string, body?: object) => go(http().post(`/v1${url}`)).send(body ?? {}),
        patch: (url: string, body: object) => go(http().patch(`/v1${url}`)).send(body),
        del: (url: string) => go(http().delete(`/v1${url}`)),
      };
    };

    const invite = await api().post('/sharing/invitations', { username: mae.username, sections: ['goals', 'budgets'] }, D);
    expect(invite.status).toBe(201);
    const accessId = invite.body.data.id;
    expect(invite.body.data.manage).toEqual([]);
    const as = helping(accessId);
    // Por aceitar, ou só a ver: não há ajuda.
    expect((await as.get('/goals')).body.error.code).toBe('SHARE_NOT_ACTIVE');
    await api().post(`/sharing/${accessId}/accept`, {}, M);
    expect((await as.get('/goals')).body.error.code).toBe('SHARE_HELP_OFF');

    // Deixa ajudar nos objetivos e no plano do mês (que mostra também o que entra).
    const upd = await api().patch(`/sharing/${accessId}`, { manage: ['goals', 'plan'] }, D);
    expect(upd.status).toBe(200);
    expect(upd.body.data.manage).toEqual(['goals', 'plan']);
    expect(upd.body.data.sections).toEqual(expect.arrayContaining(['goals', 'budgets', 'plan', 'income']));
    expect(await prisma.notification.count({ where: { userId: mae.id, type: 'sharing_help' } })).toBe(1);
    // Do lado de quem ajuda, o acesso diz onde pode ajudar.
    const received = (await api().get('/sharing', M)).body.data.received.find((a: { id: string }) => a.id === accessId);
    expect(received.manage).toEqual(['goals', 'plan']);

    // A mãe cria um objetivo na conta da filha e junta-lhe um passo.
    const created = await as.post('/goals', { name: 'Carta de condução', targetAmount: 600, targetDate: addDays(today, 120) });
    expect(created.status).toBe(201);
    const goalId = created.body.data.id;
    expect((await prisma.goal.findUnique({ where: { id: goalId } }))?.userId).toBe(dona.id);
    expect((await as.post(`/goals/${goalId}/steps`, { title: 'Exame de código', amount: 100 })).status).toBe(201);
    expect((await api().get('/goals', D)).body.data.some((g: { id: string }) => g.id === goalId)).toBe(true);
    expect((await api().get('/goals', M)).body.data.some((g: { id: string }) => g.id === goalId)).toBe(false);
    // Fica registado e a filha recebe um só aviso (os seguintes juntam-se).
    const activity = (await api().get(`/sharing/${accessId}/activity`, D)).body.data;
    expect(activity).toHaveLength(2);
    expect(activity[1]).toMatchObject({ section: 'goals', action: 'create', label: 'Carta de condução', mine: false });
    expect(activity[0]).toMatchObject({ section: 'goals', action: 'update', label: 'Carta de condução' });
    expect((await api().get(`/sharing/${accessId}/activity`, M)).body.data[0].mine).toBe(true);
    const warned = await prisma.notification.findMany({ where: { userId: dona.id, type: 'help_change' } });
    expect(warned).toHaveLength(1);
    expect(warned[0].data).toMatchObject({ section: 'goals', from: 'Mae Ajuda', count: 2 });

    // Limites só a ver; o resto da conta fica fechado.
    expect((await as.post('/budgets', { name: 'Comida', amount: 100 })).body.error.code).toBe('SHARE_HELP_SECTION');
    expect((await as.get('/me')).body.error.code).toBe('SHARE_HELP_NOT_ALLOWED');
    expect((await as.get('/dashboard')).body.error.code).toBe('SHARE_HELP_NOT_ALLOWED');
    // As contas (para o objetivo dizer onde se guarda) veem-se sem saldos.
    expect((await as.get('/accounts')).body.data.balancesHidden).toBe(true);
    expect((await as.get('/categories')).status).toBe(200);
    expect((await as.get('/monthly-plans/current')).status).toBe(200);
    // Ninguém mais usa este acesso: nem outra pessoa, nem a própria dona.
    expect((await helping(accessId, outro.token).get('/goals')).body.error.code).toBe('SHARE_NOT_FOUND');
    expect((await helping(accessId, D).get('/goals')).body.error.code).toBe('SHARE_NOT_FOUND');

    // Gastos sem ver o que entra: só despesas, e sem saldos das contas.
    const bank = (await api().post('/accounts', { name: 'Banco', type: 'BANK', initialBalance: 500 }, D)).body.data;
    const helpTx = await api().patch(`/sharing/${accessId}`, { sections: ['goals', 'budgets', 'transactions'], manage: ['goals', 'transactions'] }, D);
    expect(helpTx.body.data.manage).toEqual(['goals', 'transactions']);
    expect(helpTx.body.data.sections).not.toContain('income');
    const accounts = (await as.get('/accounts')).body.data;
    expect(accounts.balancesHidden).toBe(true);
    expect(accounts.accounts.find((a: { id: string }) => a.id === bank.id).balance).toBeNull();
    const groceries = ((await as.get('/categories')).body.data as Array<{ id: string; key: string | null }>).find((c) => c.key === 'food')!.id;
    const spent = await as.post('/transactions', { type: 'EXPENSE', amount: 12.5, accountId: bank.id, categoryId: groceries, date: today, description: 'Pão e leite' });
    expect(spent.status).toBe(201);
    expect((await prisma.transaction.findUnique({ where: { id: spent.body.data.id } }))?.userId).toBe(dona.id);
    expect((await as.post('/transactions', { type: 'INCOME', amount: 1000, accountId: bank.id, date: today, description: 'Salário' })).body.error.code).toBe('SHARE_SECTION_HIDDEN');
    const salary = (await api().post('/transactions', { type: 'INCOME', amount: 900, accountId: bank.id, date: today, description: 'Ordenado' }, D)).body.data;
    expect((await as.get(`/transactions/${salary.id}`)).body.error.code).toBe('TRANSACTION_NOT_FOUND');
    expect((await as.del(`/transactions/${salary.id}`)).body.error.code).toBe('TRANSACTION_NOT_FOUND');
    expect((await as.patch(`/transactions/${spent.body.data.id}`, { amount: 13 })).status).toBe(200);
    // Plano do mês já não: deixou de estar nas áreas de ajuda.
    expect((await as.get('/monthly-plans/current')).body.error.code).toBe('SHARE_HELP_SECTION');
    // Categorias reservadas e ajuda não andam juntas.
    expect((await api().patch(`/sharing/${accessId}`, { hiddenCategoryIds: [groceries] }, D)).body.error.code).toBe('SHARE_HELP_NEEDS_ALL');
    // Deixar de mostrar os movimentos tira também a ajuda neles.
    const less = await api().patch(`/sharing/${accessId}`, { sections: ['goals', 'budgets'] }, D);
    expect(less.body.data.manage).toEqual(['goals']);

    // Perfil: "sobre mim" e onde se pode ajudar.
    expect((await api().patch('/me', { bio: '  Estudante, a poupar para a carta.  ' }, D)).body.data.bio).toBe('Estudante, a poupar para a carta.');
    const profile = (await api().get(`/users/${dona.id}`, M)).body.data;
    expect(profile).toMatchObject({ bio: 'Estudante, a poupar para a carta.', sharing: { iFollow: accessId, followsMe: null, iCanHelp: ['goals'], theyCanHelp: [] } });
    expect((await api().patch('/me', { bio: '' }, D)).body.data.bio).toBeNull();

    // Lembretes num empréstimo ligado: um por dia de cada lado.
    const loan = (await api().post('/loans', { direction: 'LENT', counterpartUsername: mae.username, amount: 80, date: today }, D)).body.data;
    expect((await api().post(`/loans/${loan.id}/nudge`, {}, D)).body.error.code).toBe('LOAN_NOT_LINKED');
    expect((await api().post(`/loans/${loan.id}/accept`, {}, M)).status).toBe(200);
    expect((await api().post(`/loans/${loan.id}/nudge`, {}, D)).status).toBe(200);
    expect((await api().post(`/loans/${loan.id}/nudge`, {}, D)).body.error.code).toBe('REMINDER_SENT_TODAY');
    expect((await api().post(`/loans/${loan.id}/nudge`, { message: 'Devolvo no dia 30' }, M)).status).toBe(200);
    expect((await api().post(`/loans/${loan.id}/nudge`, {}, outro.token)).body.error.code).toBe('LOAN_NOT_FOUND');
    const toMae = await prisma.notification.findFirst({ where: { userId: mae.id, type: 'loan_nudge' } });
    expect(toMae?.data).toMatchObject({ loanId: loan.id, from: 'Dona Ajuda', remaining: 80 });
    const toDona = await prisma.notification.findFirst({ where: { userId: dona.id, type: 'loan_note' } });
    expect(toDona?.data).toMatchObject({ loanId: loan.id, from: 'Mae Ajuda', message: 'Devolvo no dia 30' });

    // Num Space: só se lembra quem deve mesmo.
    const space = (await api().post('/spaces', { name: 'Casa' }, D)).body.data;
    expect((await api().post(`/spaces/${space.id}/balances/remind`, { userId: mae.id }, D)).body.error.code).toBe('SPACE_NOTHING_OWED');
  });

  it('parte 8: códigos que fecham áreas, quotas por aniversário sem gastar duas vezes, privilégios dos grupos, listas de compras, bancos e feedback', async () => {
    const mk = async (tag: string) => {
      // Outro "IP": o limite de registos por minuto já foi gasto pelos testes anteriores.
      const r = await request(app.getHttpServer()).post('/v1/auth/register').set('X-Forwarded-For', `10.8.0.${tag.length}`).set('Accept-Language', 'pt').send({ name: `P8 ${tag}`, username: `p8${tag}${stamp}`, email: `p8.${tag}${stamp}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt', campaign: 'instagram_pt' });
      if (r.status !== 201) throw new Error(JSON.stringify(r.body));
      return { token: r.body.data.accessToken as string, id: r.body.data.user.id as string };
    };
    const ana = await mk('ana');
    const bia = await mk('bia');

    // Um código que dá Premium+ mas deixa os empréstimos e os Spaces fechados (e sem leitura de etiquetas).
    const code = await api().post('/admin/promo-codes', { code: `P8CODE${stamp}`, plan: 'PREMIUM_PLUS', durationDays: 30, blockedAreas: ['loans', 'spaces', 'nope'], blockedFeatures: ['scanner.prices'] });
    expect(code.status).toBe(201);
    expect(code.body.data).toMatchObject({ blockedAreas: ['loans', 'spaces'], blockedFeatures: ['scanner.prices'] });
    expect((await api().post('/billing/redeem', { code: `P8CODE${stamp}` }, ana.token)).status).toBe(200);
    const me = await api().get('/me', ana.token);
    expect(me.body.data.plan).toMatchObject({ code: 'PREMIUM_PLUS', blockedAreas: ['loans', 'spaces'] });
    expect(me.body.data.plan.features).not.toContain('scanner.prices');
    expect(me.body.data.plan.features).toContain('scanner.receipts');
    const blocked = await api().get('/loans', ana.token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('AREA_BLOCKED');
    expect((await api().get('/goals', ana.token)).status).toBe(200);
    const redemptions = await api().get(`/admin/promo-codes/${code.body.data.id}/redemptions`);
    expect(redemptions.body.data[0]).toMatchObject({ plan: 'PREMIUM_PLUS', active: true });
    expect(redemptions.body.data[0].activatedAt).toBeTruthy();
    expect(redemptions.body.data[0].expirationDate).toBeTruthy();
    // Abrir a área outra vez aplica-se logo a quem já usou o código.
    await api().patch(`/admin/promo-codes/${code.body.data.id}`, { blockedAreas: ['prices'] });
    expect((await api().get('/loans', ana.token)).status).toBe(200);

    // Quotas: o período começa no dia da ativação do plano, e repetir o mesmo pedido não gasta outra vez.
    fakeAi.enabled = true;
    const usage0 = await api().get('/ai/usage', ana.token);
    const activated = new Date(me.body.data.plan.expirationDate).getTime() - 30 * 86_400_000;
    expect(Math.abs(new Date(usage0.body.data.periodStart).getTime() - activated)).toBeLessThan(5000);
    expect(new Date(usage0.body.data.resetsAt).getTime()).toBeLessThanOrEqual(new Date(me.body.data.plan.expirationDate).getTime());
    const ask = () => request(app.getHttpServer()).post('/v1/ai/chat').set('Authorization', `Bearer ${ana.token}`).set('X-Idempotency-Key', `k-${stamp}`).send({ messages: [{ role: 'user', content: 'Olá' }] });
    const first = await ask();
    expect(first.status).toBe(200);
    expect(first.body.data.usage.questions.used).toBe(1);
    const again = await ask();
    expect(again.status).toBe(200);
    expect(again.body.data.reply).toBe(first.body.data.reply);
    expect((await api().get('/ai/usage', ana.token)).body.data.questions.used).toBe(1);
    expect(await prisma.usageCounter.count({ where: { userId: ana.id, feature: 'questions' } })).toBe(1);
    fakeAi.enabled = false;

    // Privilégios dos grupos: o dono decide tudo por papel.
    const space = await api().post('/spaces', { name: 'P8 Casa', type: 'HOUSEHOLD' }, ana.token);
    const sid = space.body.data.id;
    expect(space.body.data.privileges).toMatchObject({ MEMBER: { invite: true, chat: true, manageMembers: false }, ADMIN: { manageMembers: true } });
    const inv = await api().post(`/spaces/${sid}/invitations`, { username: `p8bia${stamp}` }, ana.token);
    await api().post(`/space-invitations/${inv.body.data.id}/accept`, {}, bia.token);
    expect((await api().post(`/spaces/${sid}/messages`, { text: 'olá' }, bia.token)).status).toBe(201);
    const denied = await api().patch(`/spaces/${sid}`, { privileges: { MEMBER: { chat: false, fund: false } } }, bia.token);
    expect(denied.status).toBe(403);
    const changed = await api().patch(`/spaces/${sid}`, { privileges: { MEMBER: { chat: false, fund: false, invite: false } } }, ana.token);
    expect(changed.status).toBe(200);
    expect(changed.body.data.privileges.MEMBER).toMatchObject({ chat: false, fund: false, invite: false, addExpense: true });
    expect(changed.body.data.settings.inviteBy).toBe('ADMINS');
    expect((await api().post(`/spaces/${sid}/messages`, { text: 'ainda?' }, bia.token)).status).toBe(403);
    expect((await api().get(`/spaces/${sid}/messages`, bia.token)).body.data.canSend).toBe(false);
    expect((await api().post(`/spaces/${sid}/deposits`, { amount: 10 }, bia.token)).status).toBe(403);
    expect((await api().post(`/spaces/${sid}/expenses`, { title: 'Pão', amount: 2 }, bia.token)).status).toBe(201);

    // Lista de compras: itens com e sem preço, marcar comprados, total pago diferente do estimado, fechar a lista.
    const acc = await api().post('/accounts', { name: 'P8 Carteira', type: 'CASH', initialBalance: 100 }, ana.token);
    const list = await api().post('/plans', { name: 'Compras da semana', type: 'SHOPPING', items: [{ title: 'Leite', quantity: 2, unitPrice: 1.1 }, { title: 'Pão' }, { title: 'Fruta', estimatedAmount: 4 }] }, ana.token);
    expect(list.status).toBe(201);
    const items = list.body.data.items;
    expect(list.body.data.estimated).toBe(6.2);
    await api().patch(`/plans/${list.body.data.id}/items/${items[1].id}`, { isDone: true }, ana.token);
    await api().patch(`/plans/${list.body.data.id}/items/${items[1].id}`, { isDone: false }, ana.token);
    const done = await api().post(`/plans/${list.body.data.id}/checkout`, { accountId: acc.body.data.id, items: items.map((i: { id: string }) => ({ itemId: i.id, actualAmount: 2 })), total: 7.5, close: true }, ana.token);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'DONE', estimated: 6.2, actual: 6, spent: 7.5, itemsDone: 3 });
    const txs = await api().get(`/transactions?planId=${list.body.data.id}`, ana.token);
    expect(txs.body.data[0]).toMatchObject({ amount: 7.5, items: [{ name: 'Leite', quantity: 2 }, { name: 'Pão' }, { name: 'Fruta' }] });
    expect((await api().get('/plans?type=SHOPPING&status=closed', ana.token)).body.data.map((p: { id: string }) => p.id)).toContain(list.body.data.id);

    // Bancos de referência (só logótipo) e feedback.
    const bank = await api().post('/admin/institutions', { name: 'Banco P8', country: 'PT' });
    expect(bank.status).toBe(201);
    const badUrl = await api().post('/admin/institutions', { name: 'Mau', logoUrl: 'http://example.com/x.png' });
    expect(badUrl.status).toBe(400);
    const banks = await api().get('/meta/institutions', ana.token);
    expect(banks.body.data.map((b: { name: string }) => b.name)).toContain('Banco P8');
    const bankAcc = await api().post('/accounts', { name: 'P8 Banco', type: 'BANK', institutionId: bank.body.data.id }, ana.token);
    expect(bankAcc.body.data.institutionId).toBe(bank.body.data.id);
    await api().del(`/admin/institutions/${bank.body.data.id}`);
    expect((await api().get(`/accounts/${bankAcc.body.data.id}`, ana.token)).body.data.institutionId).toBeNull();
    const fb = await api().post('/feedback', { kind: 'PROBLEM', message: 'O gráfico do mês não abre.', appVersion: '1.0.0', platform: 'android' }, ana.token);
    expect(fb.status).toBe(201);
    const fbList = await api().get('/admin/feedback?status=NEW');
    expect(fbList.body.data.items.find((f: { id: string }) => f.id === fb.body.data.id)).toMatchObject({ kind: 'PROBLEM', user: { country: 'PT' } });
    await api().patch(`/admin/feedback/${fb.body.data.id}`, { status: 'DONE', adminNote: 'Corrigido na 1.0.1' });
    expect((await api().get('/feedback', ana.token)).body.data[0].status).toBe('DONE');

    // Administração: filtros por país, registo e origem.
    const users = await api().get(`/admin/users?country=PT&signup=password&q=p8.ana${stamp}`);
    expect(users.body.data.items[0]).toMatchObject({ signup: 'password', signupCampaign: 'instagram_pt', plan: 'PREMIUM_PLUS' });
    expect((await api().get('/admin/users?country=XX')).body.data.total).toBe(0);
    const countries = await api().get('/admin/countries');
    const pt = countries.body.data.countries.find((c: { country: string }) => c.country === 'PT');
    expect(pt.users).toBeGreaterThan(0);
    expect(pt.byPlan.PREMIUM_PLUS).toBeGreaterThan(0);
    expect(countries.body.data.campaigns.find((c: { campaign: string }) => c.campaign === 'instagram_pt').count).toBeGreaterThanOrEqual(2);
    expect((await api().get('/admin/subscribers?country=PT&kind=promo&plan=PREMIUM_PLUS')).body.data.items.some((i: { user: { id: string } }) => i.user.id === ana.id)).toBe(true);
    expect((await api().get('/admin/subscribers?country=BR&kind=promo')).body.data.items.some((i: { user: { id: string } }) => i.user.id === ana.id)).toBe(false);
  });

  it('partes 9 e 10: créditos de IA, limite por minutos, bloqueio de conta, calculadora, investimentos, importação, WhatsApp e movimentos por confirmar', async () => {
    const mk = async (tag: string) => {
      const r = await request(app.getHttpServer()).post('/v1/auth/register').set('X-Forwarded-For', `10.9.0.${tag.length}`).set('Accept-Language', 'pt').send({ name: `P9 ${tag}`, username: `p9${tag}${stamp}`, email: `p9.${tag}${stamp}@ex.pt`, password: 'segredo123', birthDate: '1990-05-20', country: 'PT', language: 'pt' });
      if (r.status !== 201) throw new Error(JSON.stringify(r.body));
      return { token: r.body.data.accessToken as string, id: r.body.data.user.id as string, email: `p9.${tag}${stamp}@ex.pt` };
    };
    const rui = await mk('rui');
    const H = { Authorization: `Bearer ${rui.token}`, 'Accept-Language': 'pt' };

    // Créditos: quando a quota do período acaba, gasta-se um crédito comprado.
    fakeAi.enabled = true;
    for (let i = 0; i < 4; i++) expect((await api().post('/ai/forecast', {}, rui.token)).status).toBe(200);
    const blocked = await api().post('/ai/forecast', {}, rui.token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details).toMatchObject({ bucket: 'forecasts', credits: 0 });
    expect(blocked.body.error.details.creditProducts.length).toBeGreaterThan(0);
    expect((await api().post('/billing/dev/credits', { credits: 2 }, rui.token)).body.data.credits).toBe(2);
    expect((await api().get('/ai/usage', rui.token)).body.data.credits).toBe(2);
    expect((await api().post('/ai/forecast', {}, rui.token)).status).toBe(200);
    expect((await api().get('/billing/credits', rui.token)).body.data.credits).toBe(1);
    expect((await api().post('/ai/forecast', {}, rui.token)).status).toBe(200);
    expect((await api().post('/ai/forecast', {}, rui.token)).status).toBe(403);
    expect((await api().get('/billing/credits', rui.token)).body.data.history.filter((h: { reason: string }) => h.reason === 'USE').length).toBe(2);
    // Um pacote comprado na loja (webhook) junta créditos uma só vez.
    const hook = (id: string) => request(app.getHttpServer()).post('/v1/billing/webhooks/revenuecat').set('Authorization', 'test-webhook-secret').send({ event: { id, type: 'NON_RENEWING_PURCHASE', app_user_id: rui.id, product_id: 'contalex_ai_credits_50', store: 'PLAY_STORE', environment: 'PRODUCTION', price: 2.99, currency: 'EUR', event_timestamp_ms: Date.now() } });
    expect((await hook(`cred-${stamp}`)).body.data).toMatchObject({ credits: 50 });
    expect((await hook(`cred-${stamp}`)).body.data).toMatchObject({ duplicate: true });
    expect((await api().get('/billing/credits', rui.token)).body.data.credits).toBe(50);
    // Limite por minutos: renova sozinho; a resposta diz quando.
    process.env.AI_BURST_LIMIT_FREE = '1';
    resetEnvCache();
    const burst = await api().post('/ai/chat', { messages: [{ role: 'user', content: 'Olá' }] }, rui.token);
    expect(burst.status).toBe(429);
    expect(burst.body.error.code).toBe('AI_RATE_LIMIT');
    expect(burst.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect((await api().get('/ai/usage', rui.token)).body.data.burst).toMatchObject({ limit: 1 });
    process.env.AI_BURST_LIMIT_FREE = '50';
    resetEnvCache();
    fakeAi.enabled = false;

    // Conta bloqueada depois de muitas tentativas falhadas (além do limite por IP).
    for (let i = 0; i < 8; i++) {
      await request(app.getHttpServer()).post('/v1/auth/login').set('X-Forwarded-For', `10.9.1.${i}`).send({ login: rui.email, password: 'errada000' });
    }
    const locked = await request(app.getHttpServer()).post('/v1/auth/login').set('X-Forwarded-For', '10.9.2.1').send({ login: rui.email, password: 'segredo123' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('LOGIN_LOCKED');

    // Calculadora determinística.
    const sav = await api().post('/simulator/savings', { initial: 500, monthly: 100, annualRatePercent: 3, months: 24, target: 2000 }, rui.token);
    expect(sav.status).toBe(200);
    expect(sav.body.data.finalBalance).toBeGreaterThan(2900);
    expect(sav.body.data.targetMonth).toBeGreaterThan(10);

    // Investimentos e dividendos (recebidos entram como receita; previstos são projeção).
    const acc = await api().post('/accounts', { name: 'P9 Conta', type: 'BANK', initialBalance: 100 }, rui.token);
    const inv = await api().post('/investments', { name: 'ETF Mundo', type: 'ETF', invested: 1000, currentValue: 1100, expectedYield: 2 }, rui.token);
    expect(inv.status).toBe(201);
    expect(inv.body.data).toMatchObject({ gain: 100, gainPercent: 10 });
    const div = await api().post(`/investments/${inv.body.data.id}/dividends`, { amount: 12.5, date: '2026-10-01', accountId: acc.body.data.id }, rui.token);
    expect(div.status).toBe(201);
    expect(div.body.data.transactionId).toBeTruthy();
    expect((await api().post(`/investments/${inv.body.data.id}/dividends/project`, { amount: 10, every: 'MONTHLY', startDate: '2026-11-05', months: 6 }, rui.token)).body.data.dividends.filter((d: { expected: boolean }) => d.expected).length).toBe(6);
    const byMonth = await api().get('/investments/dividends?months=3', rui.token);
    expect(byMonth.body.data.months.find((m: { month: string }) => m.month === '2026-10')).toMatchObject({ received: 12.5 });
    expect(byMonth.body.data.upcoming.length).toBeGreaterThan(0);
    expect((await api().get('/investments', rui.token)).body.data.summary).toMatchObject({ invested: 1000, currentValue: 1100, dividendsReceived: 12.5 });
    expect((await api().get(`/accounts/${acc.body.data.id}`, rui.token)).body.data.balance).toBe(112.5);

    // Importar um CSV: pré-visualizar (duplicados assinalados) e confirmar.
    const csv = 'Data;Descrição;Débito;Crédito\n01/10/2026;ETF Mundo;;12,50\n03/10/2026;Padaria;3,20;\n04/10/2026;Farmácia;15,00;\n';
    const prev = await request(app.getHttpServer()).post('/v1/import/preview').set(H).attach('file', Buffer.from(csv, 'utf8'), 'extrato.csv');
    expect(prev.status).toBe(201);
    expect(prev.body.data).toMatchObject({ rowCount: 3, validCount: 3, duplicateCount: 1, mapping: { date: 0, debit: 2, credit: 3 } });
    const done = await api().post(`/import/${prev.body.data.batchId}/commit`, { accountId: acc.body.data.id, skipDuplicates: true }, rui.token);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ imported: 2, skipped: 1 });
    expect((await api().get(`/accounts/${acc.body.data.id}`, rui.token)).body.data.balance).toBe(94.3);
    expect((await api().post(`/import/${prev.body.data.batchId}/commit`, { accountId: acc.body.data.id }, rui.token)).body.error.code).toBe('IMPORT_ALREADY_DONE');

    // WhatsApp: sem credenciais fica desligado; o webhook recusa sem assinatura; os movimentos por confirmar funcionam.
    const wa = await api().get('/whatsapp', rui.token);
    expect(wa.body.data).toMatchObject({ configured: false, linked: false, allowed: false });
    expect((await api().post('/whatsapp/link', {}, rui.token)).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).status).toBe(403);
    expect((await request(app.getHttpServer()).post('/v1/whatsapp/webhook').send({ entry: [] })).status).toBe(503);
    await prisma.pendingTransaction.create({ data: { userId: rui.id, source: 'WHATSAPP', sourceId: `wa:test-${stamp}`, type: 'EXPENSE', amount: 7.5, currency: 'EUR', date: new Date('2026-10-10'), description: 'café', categoryKey: 'food' } });
    expect((await api().get('/inbox', rui.token)).body.data.pending).toBe(1);
    const pend = await api().get('/pending-transactions', rui.token);
    expect(pend.body.data[0]).toMatchObject({ amount: 7.5, description: 'café' });
    const conf = await api().post(`/pending-transactions/${pend.body.data[0].id}/confirm`, { accountId: acc.body.data.id }, rui.token);
    expect(conf.status).toBe(200);
    expect(conf.body.data).toMatchObject({ amount: 7.5, type: 'EXPENSE', tags: ['whatsapp'] });
    expect(conf.body.data.category.key).toBe('food');
    expect((await api().get('/pending-transactions', rui.token)).body.data.length).toBe(0);
    // Formas de pagamento por país (informativo).
    expect((await api().get('/billing/methods?country=BR&platform=android', rui.token)).body.data.methods.some((m: { key: string }) => m.key === 'boleto')).toBe(true);
  });

  it('apagar a conta: 30 dias para voltar atrás', async () => {
    const users = app.get(UsersService);
    const wrong = await api().post('/me/delete', { password: 'errada000' });
    expect(wrong.body.error.code).toBe('WRONG_PASSWORD');
    const asked = await api().post('/me/delete', { password: 'segredo123' });
    expect(asked.status).toBe(200);
    expect(asked.body.data).toMatchObject({ scheduled: true, days: 30 });
    // Não desaparece logo: fica marcada, com as sessões fechadas.
    expect((await prisma.user.findUnique({ where: { id: userId } }))?.deletionScheduledFor).toBeTruthy();
    expect(await prisma.refreshToken.count({ where: { userId, revokedAt: null } })).toBe(0);
    expect((await api().get(`/users/lookup?username=manuel${stamp}`, T2)).body.error.code).toBe('USER_NOT_FOUND');
    // A limpeza da noite não lhe toca antes do prazo.
    await users.purgeDue();
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
    // Entrar de novo cancela o pedido.
    const back = await api().post('/auth/login', { login: `manuel${stamp}`, password: 'segredo123' }, '');
    expect(back.body.data.deletionCancelled).toBe(true);
    expect(back.body.data.user.deletion).toBeNull();
    expect(await prisma.notification.count({ where: { userId, type: 'account_deletion_cancelled' } })).toBe(1);
    // Pede outra vez e deixa passar os 30 dias: agora sim, é apagada.
    await api().post('/me/delete', { password: 'segredo123' }, back.body.data.accessToken).expect(200);
    expect(await users.purgeDue(new Date(Date.now() + 29 * 86_400_000))).toBe(0);
    expect(await users.purgeDue(new Date(Date.now() + 31 * 86_400_000))).toBeGreaterThanOrEqual(1);
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
  });

  it('parte 11: data de nascimento, admins por área, créditos na lista, código com plano pago e a despesa da subscrição', async () => {
    const DAY = 86_400_000;
    const hook = (event: Record<string, unknown>) => request(app.getHttpServer()).post('/v1/billing/webhooks/revenuecat').set('Authorization', 'Bearer test-webhook-secret').send({ event });

    // --- Registo sem data de nascimento, com data impossível ou menor de 13: não passa.
    const base = { name: 'Nina Nova', username: `nina${stamp}`, email: `nina${stamp}@ex.pt`, password: 'segredo123', country: 'PT', language: 'pt' };
    let ip = 0;
    const reg = (body: object) => request(app.getHttpServer()).post('/v1/auth/register').set('X-Forwarded-For', `10.11.0.${++ip}`).set('Accept-Language', 'pt').send(body);
    const semData = await reg(base);
    expect(semData.status).toBe(400);
    expect(semData.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'birthDate' })]));
    expect((await reg({ ...base, birthDate: '2020-02-30' })).status).toBe(400);
    expect((await reg({ ...base, birthDate: new Date(Date.now() - 10 * 365 * DAY).toISOString().slice(0, 10) })).status).toBe(400);
    const nina = (await reg({ ...base, birthDate: '1995-08-15' })).body.data;
    const N = nina.accessToken;
    // O admin de tudo (a conta principal foi apagada no teste anterior).
    const chefe = (await reg({ ...base, name: 'Chefe', username: `chefe${stamp}`, email: `chefe${stamp}@ex.pt`, birthDate: '1980-01-01' })).body.data;
    await prisma.user.update({ where: { id: chefe.user.id }, data: { role: 'ADMIN' } });
    const C = chefe.accessToken;
    expect((await api().get('/me', N)).body.data.birthDate).toBe('1995-08-15');
    expect((await api().patch('/me', { birthDate: '1996-01-02' }, N)).body.data.birthDate).toBe('1996-01-02');

    // --- Admin só de algumas áreas: vê essas, não vê as outras, e não torna ninguém admin.
    const role = await api().patch(`/admin/users/${nina.user.id}/role`, { role: 'ADMIN', areas: ['users', 'feedback'] }, C);
    expect(role.status).toBe(200);
    expect(role.body.data).toMatchObject({ isAdmin: true, adminAreas: ['users', 'feedback'] });
    expect((await api().get('/me', N)).body.data).toMatchObject({ isAdmin: true, adminAreas: ['users', 'feedback'] });
    expect((await api().get('/admin/users?q=nina', N)).status).toBe(200);
    expect((await api().get('/admin/feedback', N)).status).toBe(200);
    expect((await api().get('/admin/overview', N)).body.error.code).toBe('ADMIN_AREA_REQUIRED');
    expect((await api().get('/admin/revenue', N)).status).toBe(403);
    expect((await api().patch(`/admin/users/${chefe.user.id}/role`, { role: 'USER' }, N)).status).toBe(403);
    // Quem acede a tudo tem adminAreas = null; um admin não pode tirar-se áreas a si próprio.
    expect((await api().get('/me', C)).body.data.adminAreas).toBeNull();
    expect((await api().patch(`/admin/users/${chefe.user.id}/role`, { role: 'ADMIN', areas: ['users'] }, C)).status).toBe(400);
    await api().patch(`/admin/users/${nina.user.id}/role`, { role: 'USER' }, C).expect(200);
    expect((await api().get('/admin/users', N)).status).toBe(403);
    // O primeiro admin (o mais antigo) não pode ser despromovido por outro admin, mesmo com acesso a tudo.
    const first = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    await prisma.user.update({ where: { id: nina.user.id }, data: { role: 'ADMIN', adminAreas: [] } });
    const demote = await api().patch(`/admin/users/${first!.id}/role`, { role: 'USER' }, N);
    expect(demote.status).toBe(403);
    expect(demote.body.error.code).toBe('ADMIN_PROTECTED');
    await prisma.user.update({ where: { id: nina.user.id }, data: { role: 'USER', adminAreas: [] } });

    // --- A lista de utilizadores mostra os créditos de IA e a data de nascimento.
    await api().post(`/admin/users/${nina.user.id}/credits`, { credits: 25, note: 'boas-vindas' }, C).expect(200);
    const row = (await api().get(`/admin/users?q=nina${stamp}`, C)).body.data.items.find((u: { id: string }) => u.id === nina.user.id);
    expect(row).toMatchObject({ aiCredits: 25, birthDate: '1996-01-02', adminAreas: [] });

    // --- Paga um mês na loja: a despesa fica logo registada, uma vez só.
    const accounts = (await api().get('/accounts', N)).body.data;
    const accountId = accounts.length ? accounts[0].id : (await api().post('/accounts', { name: 'Carteira', type: 'CASH', currency: 'EUR', initialBalance: 100 }, N)).body.data.id;
    const purchase = { id: `p11-${stamp}`, type: 'INITIAL_PURCHASE', app_user_id: nina.user.id, product_id: 'contalex_premium_monthly', entitlement_ids: ['premium'], store: 'PLAY_STORE', environment: 'PRODUCTION', purchased_at_ms: Date.now(), expiration_at_ms: Date.now() + 30 * DAY, price: 3.29, currency: 'EUR', price_in_purchased_currency: 2.99, event_timestamp_ms: Date.now() };
    await hook(purchase).expect(200);
    await hook(purchase).expect(200);
    const expenses = await prisma.transaction.findMany({ where: { userId: nina.user.id, merchant: 'Contalexy' } });
    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({ type: 'EXPENSE', accountId, currency: 'EUR', note: `rc:p11-${stamp}` });
    expect(Number(expenses[0].amount)).toBe(2.99);
    const cat = await prisma.category.findFirst({ where: { userId: nina.user.id, key: 'subscriptions' } });
    expect(expenses[0].categoryId).toBe(cat?.id ?? null);
    expect((await api().get('/me', N)).body.data.plan.code).toBe('PREMIUM');

    // --- Com o plano pago em vigor, um código do mesmo plano fica guardado para depois.
    const promo = (await api().post('/admin/promo-codes', { code: `fila${stamp}`, plan: 'PREMIUM', durationDays: 30 }, C)).body.data;
    // Com outro IP: os testes anteriores já gastaram o limite de códigos por minuto.
    const redeem = (code: string) => request(app.getHttpServer()).post('/v1/billing/redeem').set('X-Forwarded-For', '10.11.9.9').set('Authorization', `Bearer ${N}`).send({ code });
    const redeemed = await redeem(promo.code);
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.data).toMatchObject({ redeemed: true, queued: true, paidRenews: true });
    expect(Math.round((new Date(redeemed.body.data.startsAt).getTime() - Date.now()) / DAY)).toBe(30);
    const queued = await prisma.subscription.findFirst({ where: { userId: nina.user.id, provider: 'PROMO' } });
    expect(Math.round(((queued?.expirationDate as Date).getTime() - (queued?.startDate as Date).getTime()) / DAY)).toBe(30);
    // Continua pago (e não "código") enquanto o pago durar.
    expect((await api().get('/billing/subscription', N)).body.data).toMatchObject({ plan: 'PREMIUM', source: 'STORE' });
    // Um código de um plano melhor entra já.
    const plus = (await api().post('/admin/promo-codes', { code: `mais${stamp}`, plan: 'PREMIUM_PLUS', durationDays: 10 }, C)).body.data;
    const upRes = await redeem(plus.code);
    expect(upRes.body).toMatchObject({ success: true });
    expect(upRes.body.data).toMatchObject({ queued: false, plan: 'PREMIUM_PLUS' });
    expect((await api().get('/me', N)).body.data.plan.code).toBe('PREMIUM_PLUS');
  });

});
