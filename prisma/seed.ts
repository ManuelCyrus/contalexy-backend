/// Dados de demonstração: `npm run db:seed`
/// Cria a conta demo@contalex.app (palavra-passe: demo1234) com 4 meses de
/// movimentos, contas, orçamentos, objetivos, planos (viagem, lista de
/// compras e negócio), plano do mês, empréstimos, um Space e alguém a
/// acompanhar os gastos — para experimentar a app logo.
///
/// A conta demo fica ADMINISTRADORA (para entrares em /admin no site, projeto contalex-web) e com
/// Premium+ por oferta. Por isso isto NUNCA corre em produção.
import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, TransactionType } from '../src/generated/prisma/client';
import { DEFAULT_CATEGORIES } from '../src/categories/default-categories';
import { DEFAULT_PLANS } from '../src/billing/plans.catalog';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const D = (v: number) => new Prisma.Decimal(v.toFixed(2));
const day = (offset: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
};
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const between = (min: number, max: number) => min + rand() * (max - min);

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_FORCE !== 'true') {
    throw new Error('Os dados de demonstração criam uma conta administradora com palavra-passe conhecida: não se usam em produção.');
  }
  for (const plan of DEFAULT_PLANS) {
    await prisma.subscriptionPlan.upsert({
      where: { code: plan.code },
      create: { code: plan.code, rank: plan.rank, features: plan.features, limits: plan.limits as unknown as object, entitlementId: plan.entitlementId, productIds: plan.productIds },
      update: {},
    });
  }

  await prisma.space.deleteMany({ where: { inviteCode: 'CASA2026' } });
  await prisma.user.deleteMany({ where: { email: { in: ['demo@contalex.app', 'ana.demo@contalex.app', 'carlos.demo@contalex.app', 'demo@rumo.app', 'ana.demo@rumo.app', 'carlos.demo@rumo.app'] } } });
  await prisma.promoCode.deleteMany({ where: { code: { in: ['BEMVINDO', 'AMIGOS2026'] } } });
  await prisma.revenueEvent.deleteMany({ where: { eventId: { startsWith: 'demo-' } } });
  // Bancos de referência (só o nome; os logótipos carregam-se na administração).
  const banks: [string, string | null][] = [
    ['Caixa Geral de Depósitos', 'PT'], ['Millennium bcp', 'PT'], ['Santander', 'PT'], ['Novo Banco', 'PT'], ['BPI', 'PT'], ['ActivoBank', 'PT'], ['Crédito Agrícola', 'PT'], ['Montepio', 'PT'],
    ['Nubank', 'BR'], ['Itaú', 'BR'], ['Bradesco', 'BR'], ['Banco do Brasil', 'BR'], ['Caixa Econômica Federal', 'BR'], ['Santander Brasil', 'BR'], ['Banco Inter', 'BR'], ['PicPay', 'BR'], ['C6 Bank', 'BR'],
    ['Revolut', null], ['Wise', null], ['PayPal', null], ['N26', null],
  ];
  if (!(await prisma.institution.count())) {
    await prisma.institution.createMany({ data: banks.map(([name, country], i) => ({ name, country, sortOrder: i })) });
  }
  const passwordHash = await bcrypt.hash('demo1234', 11);
  const createUser = async (email: string, username: string, name: string) => {
    const user = await prisma.user.create({
      data: { email, username, name, passwordHash, country: 'PT', language: 'pt', languageSource: 'manual', currency: 'EUR', timezone: 'Europe/Lisbon', monthStartDay: 25, onboardedAt: new Date(), createdAt: day(-120) },
    });
    await prisma.category.createMany({ data: DEFAULT_CATEGORIES.map((c, i) => ({ userId: user.id, key: c.key, type: c.type, icon: c.icon, color: c.color, sortOrder: i })) });
    return user;
  };
  const demo = await createUser('demo@contalex.app', 'demo', 'Manuel Demo');
  const ana = await createUser('ana.demo@contalex.app', 'ana.demo', 'Ana Costa');
  const carlos = await createUser('carlos.demo@contalex.app', 'carlos.demo', 'Carlos Lima');
  await prisma.user.update({ where: { id: demo.id }, data: { role: 'ADMIN' } });

  const cats = Object.fromEntries((await prisma.category.findMany({ where: { userId: demo.id } })).map((c) => [c.key!, c.id]));
  const account = (name: string, type: 'BANK' | 'CASH' | 'SAVINGS' | 'CREDIT_CARD' | 'DIGITAL_WALLET', initial: number, color: string, icon: string, extra: object = {}) =>
    prisma.account.create({ data: { userId: demo.id, name, type, currency: 'EUR', initialBalance: D(initial), color, icon, ...extra } });
  const bank = await account('Conta à ordem', 'BANK', 1180, '#2D4BE0', 'account_balance', { institution: 'CGD', sortOrder: 0 });
  const wallet = await account('Carteira', 'CASH', 60, '#12B886', 'payments', { sortOrder: 1 });
  const savings = await account('Poupança', 'SAVINGS', 2600, '#F59E0B', 'savings', { sortOrder: 2 });
  const card = await account('Cartão de crédito', 'CREDIT_CARD', 0, '#EF4E62', 'credit_card', { creditLimit: D(1500), sortOrder: 3 });
  const revolut = await account('Revolut', 'DIGITAL_WALLET', 120, '#111827', 'account_balance_wallet', { institution: 'Revolut', sortOrder: 4 });

  const tx: Prisma.TransactionCreateManyInput[] = [];
  const today = day(0);
  // Cada evento num dia fixo do mês, nos últimos 4 meses (só até hoje).
  const onDay = (monthsAgo: number, dayOfMonth: number) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsAgo, 1));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(dayOfMonth, last));
    return d;
  };
  const add = (type: TransactionType, amount: number, accountId: string, category: string | null, date: Date, description: string, extra: Partial<Prisma.TransactionCreateManyInput> = {}) => {
    if (date > today) return;
    tx.push({ userId: demo.id, type, amount: D(amount), currency: 'EUR', accountId, categoryId: category ? cats[category] : null, date, description, ...extra });
  };

  for (let m = 0; m < 4; m++) {
    add('INCOME', 1450, bank.id, 'salary', onDay(m, 25), 'Salário');
    add('EXPENSE', 650, bank.id, 'home', onDay(m, 1), 'Renda', { merchant: 'Senhorio' });
    add('EXPENSE', between(38, 55), bank.id, 'home', onDay(m, 12), 'Luz e gás', { merchant: 'EDP' });
    add('EXPENSE', 15.99, card.id, 'subscriptions', onDay(m, 8), 'Netflix', { merchant: 'Netflix' });
    add('EXPENSE', 7.99, revolut.id, 'subscriptions', onDay(m, 14), 'Spotify', { merchant: 'Spotify' });
    add('EXPENSE', 29.9, bank.id, 'health', onDay(m, 3), 'Ginásio', { tags: ['subscricao'] });
    add('TRANSFER', 150, bank.id, null, onDay(m, 26), 'Poupança do mês', { toAccountId: savings.id, toAmount: D(150) });
    if (m === 1) add('INCOME', 380, revolut.id, 'freelance', onDay(m, 18), 'Site para cliente', { tags: ['trabalho'] });
    for (const [i, d] of [2, 9, 16, 23, 30].entries()) {
      add('EXPENSE', between(42, 88), i % 2 ? card.id : bank.id, 'food', onDay(m, d), i % 2 ? 'Continente' : 'Pingo Doce', { merchant: i % 2 ? 'Continente' : 'Pingo Doce', tags: ['casa'] });
      add('EXPENSE', between(9, 26), wallet.id, 'food', onDay(m, d + 2), i % 2 ? 'Jantar fora' : 'Almoço', { tags: ['restaurante'] });
    }
    // Pequenas despesas que se repetem (a análise de desperdícios dá por elas)
    for (const d of [2, 4, 7, 9, 11, 15, 17, 21, 23, 28]) add('EXPENSE', between(0.9, 1.6), wallet.id, 'food', onDay(m, d), 'Café', { merchant: 'Café da esquina' });
    add('EXPENSE', between(25, 45), bank.id, 'transport', onDay(m, 6), 'Combustível', { merchant: 'Galp' });
    add('EXPENSE', between(25, 45), bank.id, 'transport', onDay(m, 20), 'Combustível', { merchant: 'Galp' });
    add('EXPENSE', between(6, 14), revolut.id, 'transport', onDay(m, 13), 'Uber');
    add('EXPENSE', between(6, 14), revolut.id, 'transport', onDay(m, 28), 'Uber');
    add('EXPENSE', between(25, 70), card.id, 'shopping', onDay(m, 21), 'Roupa', { merchant: 'Zara' });
    add('EXPENSE', between(8, 22), wallet.id, 'health', onDay(m, 17), 'Farmácia');
    add('EXPENSE', between(12, 24), card.id, 'entertainment', onDay(m, 27), 'Cinema');
  }
  add('EXPENSE', 89.9, card.id, 'technology', onDay(1, 10), 'Auscultadores', { merchant: 'Worten' });
  add('EXPENSE', 120, bank.id, 'education', onDay(2, 15), 'Curso online', { tags: ['trabalho'] });
  add('EXPENSE', 1.2, wallet.id, 'food', today, 'Café', { merchant: 'Café da esquina' });
  await prisma.transaction.createMany({ data: tx });

  // A próxima vez que calha o dia X do mês (depois de hoje) — bate certo
  // com os movimentos criados acima, que usam os mesmos dias.
  const monthlyOn = (dayOfMonth: number) => {
    const next = onDay(0, dayOfMonth);
    return next > today ? next : onDay(-1, dayOfMonth);
  };
  // O início fica alinhado com a próxima data (3 meses antes).
  const startFor = (next: Date) => {
    const d = new Date(next);
    d.setUTCMonth(d.getUTCMonth() - 3);
    return d;
  };
  await prisma.recurringRule.createMany({
    data: [
      { userId: demo.id, type: 'INCOME', amount: D(1450), accountId: bank.id, categoryId: cats.salary, description: 'Salário', frequency: 'MONTHLY', startDate: startFor(monthlyOn(25)), nextDate: monthlyOn(25), kind: 'SALARY' },
      { userId: demo.id, type: 'EXPENSE', amount: D(650), accountId: bank.id, categoryId: cats.home, description: 'Renda', frequency: 'MONTHLY', startDate: startFor(monthlyOn(1)), nextDate: monthlyOn(1), autoCreate: false, remindDaysBefore: 3, kind: 'RENT' },
      { userId: demo.id, type: 'EXPENSE', amount: D(15.99), accountId: card.id, categoryId: cats.subscriptions, description: 'Netflix', frequency: 'MONTHLY', startDate: startFor(monthlyOn(8)), nextDate: monthlyOn(8), kind: 'SUBSCRIPTION' },
      { userId: demo.id, type: 'EXPENSE', amount: D(7.99), accountId: revolut.id, categoryId: cats.subscriptions, description: 'Spotify', frequency: 'MONTHLY', startDate: startFor(monthlyOn(14)), nextDate: monthlyOn(14), kind: 'SUBSCRIPTION' },
      { userId: demo.id, type: 'EXPENSE', amount: D(29.9), accountId: bank.id, categoryId: cats.health, description: 'Ginásio', frequency: 'MONTHLY', startDate: startFor(monthlyOn(3)), nextDate: monthlyOn(3), kind: 'SUBSCRIPTION' },
      { userId: demo.id, type: 'EXPENSE', amount: D(240), accountId: bank.id, categoryId: cats.home, description: 'Seguro da casa', frequency: 'YEARLY', startDate: (() => { const d = day(165); d.setUTCFullYear(d.getUTCFullYear() - 1); return d; })(), nextDate: day(165), kind: 'INSURANCE' },
    ],
  });

  await prisma.budget.createMany({
    data: [
      { userId: demo.id, name: 'Limite do mês', amount: D(1400), currency: 'EUR', period: 'MONTHLY', categoryIds: [] },
      { userId: demo.id, name: 'Alimentação', amount: D(320), currency: 'EUR', period: 'MONTHLY', categoryIds: [cats.food] },
      { userId: demo.id, name: 'Lazer', amount: D(70), currency: 'EUR', period: 'MONTHLY', categoryIds: [cats.entertainment] },
      { userId: demo.id, name: 'Transportes', amount: D(180), currency: 'EUR', period: 'MONTHLY', categoryIds: [cats.transport] },
    ],
  });

  const emergency = await prisma.goal.create({ data: { userId: demo.id, name: 'Fundo de emergência', targetAmount: D(5000), currency: 'EUR', icon: 'shield', color: '#12B886', accountId: savings.id } });
  const japan = await prisma.goal.create({ data: { userId: demo.id, name: 'Viagem ao Japão', targetAmount: D(3200), currency: 'EUR', targetDate: day(300), icon: 'flight', color: '#EF4E62', pinnedAt: new Date() } });
  await prisma.goalContribution.createMany({
    data: [
      { goalId: emergency.id, userId: demo.id, amount: D(2600), date: day(-110), note: 'Saldo inicial' },
      { goalId: emergency.id, userId: demo.id, amount: D(150), date: day(-65) },
      { goalId: emergency.id, userId: demo.id, amount: D(150), date: day(-35) },
      { goalId: emergency.id, userId: demo.id, amount: D(150), date: day(-5) },
      { goalId: japan.id, userId: demo.id, amount: D(400), date: day(-60) },
      { goalId: japan.id, userId: demo.id, amount: D(250), date: day(-20) },
    ],
  });

  const porto = await prisma.plan.create({
    data: {
      userId: demo.id, name: 'Fim de semana no Porto', type: 'TRIP', status: 'ACTIVE', icon: 'flight', color: '#2D4BE0', budget: D(350), currency: 'EUR', startDate: day(18), endDate: day(20),
      items: {
        create: [
          { title: 'Comboio Alfa Pendular (ida e volta)', quantity: 2, estimatedAmount: D(96), categoryKey: 'transport', sortOrder: 0 },
          { title: 'Hotel (2 noites)', quantity: 1, estimatedAmount: D(160), categoryKey: 'travel', sortOrder: 1 },
          { title: 'Jantares', quantity: 2, estimatedAmount: D(70), categoryKey: 'food', sortOrder: 2 },
          { title: 'Caves do vinho do Porto', quantity: 2, estimatedAmount: D(36), categoryKey: 'entertainment', sortOrder: 3 },
        ],
      },
    },
  });
  const ticket = await prisma.transaction.create({ data: { userId: demo.id, type: 'EXPENSE', amount: D(96), currency: 'EUR', accountId: bank.id, categoryId: cats.transport, date: day(-2), description: 'Comboio Alfa Pendular', planId: porto.id } });
  await prisma.planItem.updateMany({ where: { planId: porto.id, sortOrder: 0 }, data: { isDone: true, transactionId: ticket.id } });

  // Lista de compras: planeado vs. real (dois itens já comprados).
  const groceries = await prisma.plan.create({
    data: {
      userId: demo.id, name: 'Compras da semana', type: 'SHOPPING', status: 'ACTIVE', icon: 'shopping_cart', color: '#F59E0B', budget: D(60), currency: 'EUR',
      items: {
        create: [
          { title: 'Arroz e massa', quantity: 2, estimatedAmount: D(4), actualAmount: D(4.38), isDone: true, categoryKey: 'food', sortOrder: 0 },
          { title: 'Frango', quantity: 1, estimatedAmount: D(6.5), actualAmount: D(7.2), isDone: true, categoryKey: 'food', sortOrder: 1 },
          { title: 'Fruta e legumes', quantity: 1, estimatedAmount: D(12), categoryKey: 'food', sortOrder: 2 },
          { title: 'Leite e iogurtes', quantity: 1, estimatedAmount: D(7), categoryKey: 'food', sortOrder: 3 },
          { title: 'Detergente da roupa', quantity: 1, estimatedAmount: D(9), categoryKey: 'home', sortOrder: 4 },
        ],
      },
    },
  });
  const basket = await prisma.transaction.create({ data: { userId: demo.id, type: 'EXPENSE', amount: D(11.58), currency: 'EUR', accountId: card.id, categoryId: cats.food, date: day(-1), description: 'Compras da semana', merchant: 'Continente', planId: groceries.id } });
  await prisma.planItem.updateMany({ where: { planId: groceries.id, isDone: true }, data: { transactionId: basket.id } });

  // Plano de negócio: capital, custos, reserva e receita prevista — e os primeiros resultados reais.
  const shop = await prisma.plan.create({
    data: {
      userId: demo.id, name: 'Loja online de velas', type: 'BUSINESS', status: 'ACTIVE', icon: 'storefront', color: '#12B886', capital: D(900), currency: 'EUR', startDate: day(-10),
      description: 'Vender velas artesanais no Instagram e em feiras.',
      items: {
        create: [
          { title: 'Cera, pavios e essências', kind: 'COST', estimatedAmount: D(400), actualAmount: D(386.5), isDone: true, sortOrder: 0 },
          { title: 'Anúncios no Instagram', kind: 'COST', estimatedAmount: D(200), sortOrder: 1 },
          { title: 'Embalagens', kind: 'COST', estimatedAmount: D(50), sortOrder: 2 },
          { title: 'Envios', kind: 'COST', estimatedAmount: D(50), sortOrder: 3 },
          { title: 'Site e domínio', kind: 'MONTHLY_COST', estimatedAmount: D(12), sortOrder: 4 },
          { title: 'Reserva para imprevistos', kind: 'RESERVE', estimatedAmount: D(188), sortOrder: 5 },
          { title: 'Vendas (80 velas a 14 €)', kind: 'REVENUE', quantity: 80, estimatedAmount: D(1120), notes: '80 unidades × 14 €', sortOrder: 6 },
        ],
      },
    },
  });
  const wax = await prisma.transaction.create({ data: { userId: demo.id, type: 'EXPENSE', amount: D(386.5), currency: 'EUR', accountId: bank.id, categoryId: cats.shopping, date: day(-9), description: 'Cera, pavios e essências', planId: shop.id, excludeFromReports: true } });
  await prisma.planItem.updateMany({ where: { planId: shop.id, sortOrder: 0 }, data: { transactionId: wax.id } });
  await prisma.transaction.create({ data: { userId: demo.id, type: 'INCOME', amount: D(168), currency: 'EUR', accountId: revolut.id, categoryId: cats.sale, date: day(-3), description: 'Primeiras 12 velas', planId: shop.id } });

  // Plano do mês (o mês financeiro começa no dia 25, o dia do salário).
  const monthStart = (() => {
    const d = new Date(today);
    if (d.getUTCDate() < 25) d.setUTCMonth(d.getUTCMonth() - 1);
    return d;
  })();
  const periodKey = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;
  await prisma.monthlyPlan.create({
    data: {
      userId: demo.id, periodKey, plannedIncome: D(1450), plannedSavings: D(150), note: 'Mês calmo: poupar para o Japão.',
      lines: {
        create: [
          { categoryId: cats.home, amount: D(700), sortOrder: 0 },
          { categoryId: cats.food, amount: D(260), sortOrder: 1 },
          { categoryId: cats.transport, amount: D(90), sortOrder: 2 },
          { categoryId: cats.health, amount: D(40), sortOrder: 3 },
          { categoryId: cats.subscriptions, amount: D(24), sortOrder: 4 },
          { categoryId: cats.entertainment, amount: D(25), sortOrder: 5 },
          { categoryId: cats.shopping, amount: D(30), sortOrder: 6 },
          { goalId: japan.id, amount: D(100), sortOrder: 7 },
          { name: 'Prendas', amount: D(20), sortOrder: 8 },
        ],
      },
    },
  });

  // Empréstimos: o que me devem e o que devo (um fixado, um atrasado, um a meio).
  const loan = (data: Omit<Prisma.LoanUncheckedCreateInput, 'userId' | 'currency'>) => prisma.loan.create({ data: { userId: demo.id, currency: 'EUR', ...data } });
  await loan({ direction: 'LENT', personName: 'Pedro', amount: D(120), date: day(-12), dueDate: day(5), note: 'Para o arranjo do carro', accountId: bank.id, remindDaysBefore: [3, 1], pinnedAt: new Date() });
  await loan({ direction: 'LENT', personName: 'Rita', amount: D(40), date: day(-30), dueDate: day(-3), note: 'Jantar de anos' });
  const fromMum = await loan({ direction: 'BORROWED', personName: 'Mãe', amount: D(300), date: day(-40), dueDate: day(20), note: 'Caução da casa', remindDaysBefore: [7, 2] });
  await prisma.loanPayment.create({ data: { loanId: fromMum.id, amount: D(100), date: day(-10), note: 'Primeira parte' } });
  const settled = await loan({ direction: 'LENT', personName: 'Tiago', amount: D(25), date: day(-50), dueDate: day(-35), status: 'SETTLED', settledAt: day(-33) });
  await prisma.loanPayment.create({ data: { loanId: settled.id, amount: D(25), date: day(-33) } });

  // Acompanhamento: a Ana vê o resumo dos meus gastos (e deixou uma nota);
  // eu vejo os gastos da Ana ao pormenor.
  const anaBank = await prisma.account.create({ data: { userId: ana.id, name: 'Conta', type: 'BANK', currency: 'EUR', initialBalance: D(900), color: '#EC4899', icon: 'account_balance' } });
  const anaCats = Object.fromEntries((await prisma.category.findMany({ where: { userId: ana.id } })).map((c) => [c.key!, c.id]));
  await prisma.transaction.createMany({
    data: [
      { userId: ana.id, type: 'INCOME', amount: D(1320), currency: 'EUR', accountId: anaBank.id, categoryId: anaCats.salary, date: day(-11), description: 'Salário' },
      { userId: ana.id, type: 'EXPENSE', amount: D(480), currency: 'EUR', accountId: anaBank.id, categoryId: anaCats.home, date: day(-10), description: 'Renda' },
      { userId: ana.id, type: 'EXPENSE', amount: D(64.3), currency: 'EUR', accountId: anaBank.id, categoryId: anaCats.food, date: day(-8), description: 'Supermercado', merchant: 'Lidl' },
      { userId: ana.id, type: 'EXPENSE', amount: D(38), currency: 'EUR', accountId: anaBank.id, categoryId: anaCats.entertainment, date: day(-6), description: 'Concerto' },
      { userId: ana.id, type: 'EXPENSE', amount: D(22.9), currency: 'EUR', accountId: anaBank.id, categoryId: anaCats.transport, date: day(-4), description: 'Passe' },
      { userId: ana.id, type: 'EXPENSE', amount: D(51.75), currency: 'EUR', accountId: anaBank.id, categoryId: anaCats.shopping, date: day(-2), description: 'Sapatilhas', merchant: 'Decathlon' },
    ],
  });
  const toAna = await prisma.sharedAccess.create({ data: { ownerId: demo.id, viewerId: ana.id, status: 'ACTIVE', scope: 'SUMMARY', sections: ['income', 'plan', 'budgets', 'goals'], respondedAt: day(-20) } });
  await prisma.sharedNote.create({ data: { accessId: toAna.id, authorId: ana.id, text: 'Estás a ir bem. Só os cafés é que somam, experimenta levar de casa.' } });
  // A Ana mostra tudo e deixa-me ajudar a gerir os objetivos, os limites, os planos e os movimentos dela.
  await prisma.sharedAccess.create({
    data: {
      ownerId: ana.id,
      viewerId: demo.id,
      status: 'ACTIVE',
      scope: 'FULL',
      sections: ['income', 'plan', 'budgets', 'goals', 'plans', 'recurring', 'transactions'],
      manageSections: ['goals', 'budgets', 'plans', 'transactions'],
      respondedAt: day(-15),
    },
  });

  // Premium: eu por oferta (criador), a Ana por código promocional, o Carlos
  // com uma compra de TESTE — nenhum destes conta para a receita.
  await prisma.subscription.create({
    data: { userId: demo.id, plan: 'PREMIUM_PLUS', status: 'ACTIVE', platform: 'OTHER', provider: 'GRANT', providerSubscriptionId: `${demo.id}:grant`, startDate: day(-30), autoRenew: false, isPaid: false, grantedById: demo.id, note: 'Criador da app' },
  });
  const welcome = await prisma.promoCode.create({ data: { code: 'BEMVINDO', plan: 'PREMIUM', durationDays: 30, maxRedemptions: 100, redeemedCount: 1, note: 'Lançamento', createdById: demo.id } });
  await prisma.promoCode.create({ data: { code: 'AMIGOS2026', plan: 'PREMIUM', durationDays: 90, maxRedemptions: 20, expiresAt: day(60), note: 'Amigos e família', createdById: demo.id } });
  await prisma.promoRedemption.create({ data: { promoCodeId: welcome.id, userId: ana.id, redeemedAt: day(-7) } });
  await prisma.subscription.create({
    data: { userId: ana.id, plan: 'PREMIUM', status: 'ACTIVE', platform: 'OTHER', provider: 'PROMO', providerSubscriptionId: `${ana.id}:${welcome.id}`, startDate: day(-7), expirationDate: day(23), autoRenew: false, isPaid: false, promoCodeId: welcome.id },
  });
  await prisma.subscription.create({
    data: { userId: carlos.id, plan: 'PREMIUM', status: 'ACTIVE', platform: 'ANDROID', provider: 'REVENUECAT', providerSubscriptionId: `${carlos.id}:contalex_premium_monthly:sandbox`, productId: 'contalex_premium_monthly', startDate: day(-5), expirationDate: day(25), autoRenew: true, isPaid: true, isSandbox: true },
  });
  await prisma.revenueEvent.create({
    data: { userId: carlos.id, provider: 'REVENUECAT', eventId: `demo-${carlos.id}`, type: 'INITIAL_PURCHASE', plan: 'PREMIUM', productId: 'contalex_premium_monthly', platform: 'ANDROID', amount: D(4.99), currency: 'EUR', amountUsd: D(5.49), commissionRate: D(0.15), taxRate: D(0), isSandbox: true, occurredAt: day(-5) },
  });

  const space = await prisma.space.create({
    data: {
      name: 'Casa', type: 'HOUSEHOLD', icon: 'home', color: '#8B5CF6', currency: 'EUR', inviteCode: 'CASA2026', createdById: demo.id,
      members: { create: [{ userId: demo.id, role: 'OWNER', joinedAt: day(-90) }, { userId: ana.id, role: 'MEMBER', joinedAt: day(-89) }] },
    },
  });
  const shared = async (title: string, amount: number, paidById: string, offset: number, categoryKey: string) => {
    const half = Math.round(amount * 50) / 100;
    await prisma.spaceExpense.create({
      data: {
        spaceId: space.id, createdById: paidById, paidById, title, amount: D(amount), currency: 'EUR', date: day(offset), categoryKey, splitMethod: 'EQUAL',
        shares: { create: [{ userId: demo.id, amount: D(half) }, { userId: ana.id, amount: D(amount - half) }] },
      },
    });
  };
  await shared('Internet + TV', 39.99, demo.id, -25, 'home');
  await shared('Supermercado', 112.4, ana.id, -12, 'food');
  await shared('Detergentes', 18.6, demo.id, -6, 'home');
  await shared('Jantar de aniversário', 64, ana.id, -2, 'food');

  console.log('Demo pronta: demo@contalex.app / demo1234 (administrador; e ana.demo@contalex.app / demo1234)');
  console.log('Administração: no site (contalex-web), em /admin, com a conta demo.');
}

main()
  .catch((err) => {
    // P2021/P2022 = falta uma tabela ou uma coluna: as migrações não foram aplicadas.
    if (err?.code === 'P2021' || err?.code === 'P2022') {
      console.error('\nA base de dados ainda não tem as tabelas (ou falta aplicar uma atualização).\n\n  Corre primeiro:  npx prisma migrate deploy\n  e depois outra vez:  npm run db:seed\n\n  (ou tudo de uma vez:  npm run db:setup)\n');
    } else {
      console.error(err);
    }
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
