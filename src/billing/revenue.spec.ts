import { revenueFromEvent, sourceOf, SubscriptionsService } from './subscriptions.service';
import { normalizePromoCode, promoCodeState, randomPromoCode } from './promo.service';
import { isYearly, premiumKind } from '../admin/admin.service';
import { isAdminUser } from '../common/utils/admin';
import { resetEnvCache } from '../config/env';

describe('receita: só conta quem pagou', () => {
  const base = { id: 'e1', product_id: 'contalex_premium_monthly' };

  it('uma compra ou renovação com valor é receita', () => {
    expect(revenueFromEvent({ ...base, type: 'INITIAL_PURCHASE', price: 4.99, price_in_purchased_currency: 4.59, currency: 'eur' })).toEqual({ type: 'INITIAL_PURCHASE', amount: 4.59, amountUsd: 4.99, currency: 'EUR' });
    expect(revenueFromEvent({ ...base, type: 'RENEWAL', price: 4.99 })).toEqual({ type: 'RENEWAL', amount: 4.99, amountUsd: 4.99, currency: 'USD' });
  });

  it('período grátis, ofertas e mudanças de estado não são receita', () => {
    expect(revenueFromEvent({ ...base, type: 'INITIAL_PURCHASE', period_type: 'TRIAL', price: 0, price_in_purchased_currency: 0 })).toBeNull();
    expect(revenueFromEvent({ ...base, type: 'INITIAL_PURCHASE' })).toBeNull();
    expect(revenueFromEvent({ ...base, type: 'EXPIRATION' })).toBeNull();
    expect(revenueFromEvent({ ...base, type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' })).toBeNull();
  });

  it('um reembolso entra a negativo', () => {
    expect(revenueFromEvent({ ...base, type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', price: -4.99, price_in_purchased_currency: -4.59, currency: 'EUR' })).toEqual({ type: 'REFUND', amount: -4.59, amountUsd: -4.99, currency: 'EUR' });
    // Sem valor: fica a 0 e o serviço vai buscar o último pagamento
    expect(revenueFromEvent({ ...base, type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' })).toMatchObject({ type: 'REFUND', amountUsd: -0 });
  });

  it('origem do plano e quem conta como pagante', () => {
    expect(sourceOf('REVENUECAT')).toBe('STORE');
    expect(sourceOf('PROMO')).toBe('PROMO');
    expect(sourceOf('GRANT')).toBe('GRANT');
    expect(sourceOf('MANUAL')).toBe('DEV');
    expect(premiumKind({ provider: 'REVENUECAT', status: 'ACTIVE', isPaid: true, isSandbox: false })).toBe('paid');
    expect(premiumKind({ provider: 'REVENUECAT', status: 'TRIAL', isPaid: false, isSandbox: false })).toBe('trial');
    expect(premiumKind({ provider: 'REVENUECAT', status: 'ACTIVE', isPaid: true, isSandbox: true })).toBe('test');
    // Uma oferta feita no painel do RevenueCat também não é paga
    expect(premiumKind({ provider: 'REVENUECAT', status: 'ACTIVE', isPaid: false, isSandbox: false })).toBe('grant');
    expect(premiumKind({ provider: 'PROMO', status: 'ACTIVE', isPaid: false, isSandbox: false })).toBe('promo');
    expect(premiumKind({ provider: 'GRANT', status: 'ACTIVE', isPaid: false, isSandbox: false })).toBe('grant');
    expect(premiumKind({ provider: 'MANUAL', status: 'ACTIVE', isPaid: false, isSandbox: true })).toBe('test');
  });

  it('a assinatura em vigor: a paga na loja antes das ofertas', () => {
    const d = (days: number) => new Date(Date.UTC(2026, 9, 1) + days * 86_400_000);
    const subs = [
      { plan: 'PREMIUM', provider: 'PROMO', expirationDate: null },
      { plan: 'PREMIUM', provider: 'REVENUECAT', expirationDate: d(30) },
      { plan: 'PREMIUM_PLUS', provider: 'GRANT', expirationDate: d(5) },
    ];
    expect(SubscriptionsService.pickCurrent(subs, 'PREMIUM')?.provider).toBe('REVENUECAT');
    expect(SubscriptionsService.pickCurrent(subs, 'PREMIUM_PLUS')?.provider).toBe('GRANT');
    expect(SubscriptionsService.pickCurrent(subs, 'FREE')).toBeNull();
    expect(SubscriptionsService.pickCurrent([subs[0], { plan: 'PREMIUM', provider: 'GRANT', expirationDate: d(9) }], 'PREMIUM')?.provider).toBe('PROMO');
  });

  it('produtos anuais (para a receita mensal recorrente)', () => {
    expect(isYearly('contalex_premium_yearly')).toBe(true);
    expect(isYearly('contalex_premium_monthly')).toBe(false);
    expect(isYearly('prod_x', new Date('2026-01-01'), new Date('2027-01-01'))).toBe(true);
    expect(isYearly(null, new Date('2026-01-01'), new Date('2026-02-01'))).toBe(false);
  });
});

describe('códigos promocionais', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const code = { isActive: true, expiresAt: null, maxRedemptions: null, redeemedCount: 0 };

  it('normaliza o que a pessoa escreve', () => {
    expect(normalizePromoCode(' contalex 2026 ')).toBe('CONTALEX2026');
    expect(randomPromoCode()).toMatch(/^CONTALEX-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('estado do código', () => {
    expect(promoCodeState(code, now)).toBe('active');
    expect(promoCodeState({ ...code, isActive: false }, now)).toBe('inactive');
    expect(promoCodeState({ ...code, expiresAt: new Date('2026-10-01') }, now)).toBe('expired');
    expect(promoCodeState({ ...code, expiresAt: new Date('2026-11-01') }, now)).toBe('active');
    expect(promoCodeState({ ...code, maxRedemptions: 3, redeemedCount: 3 }, now)).toBe('exhausted');
    expect(promoCodeState({ ...code, maxRedemptions: 3, redeemedCount: 2 }, now)).toBe('active');
  });
});

describe('administradores', () => {
  const vars = { DATABASE_URL: 'postgresql://x', JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40) };
  const saved = { ...process.env };
  afterAll(() => {
    process.env = saved;
    resetEnvCache();
  });

  it('pelo papel ou pelo email em ADMIN_EMAILS', () => {
    process.env = { ...saved, ...vars, ADMIN_EMAILS: ' Dono@Rumo.app , outra@rumo.app' };
    resetEnvCache();
    expect(isAdminUser({ role: 'USER', email: 'dono@rumo.app' })).toBe(true);
    expect(isAdminUser({ role: 'USER', email: 'alguem@rumo.app' })).toBe(false);
    expect(isAdminUser({ role: 'ADMIN', email: 'alguem@rumo.app' })).toBe(true);
    process.env = { ...saved, ...vars, ADMIN_EMAILS: '' };
    resetEnvCache();
    expect(isAdminUser({ role: 'USER', email: 'dono@rumo.app' })).toBe(false);
  });
});
