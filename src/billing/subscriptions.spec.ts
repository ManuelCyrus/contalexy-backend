import { billingConfigWarnings, isRefund, platformForStore, stackPasses, statusForEvent } from './subscriptions.service';

describe('assinaturas (RevenueCat)', () => {
  const now = Date.UTC(2026, 9, 1);
  const future = now + 30 * 86_400_000;
  const past = now - 1000;

  it('estado de cada tipo de evento', () => {
    expect(statusForEvent({ id: '1', type: 'INITIAL_PURCHASE', expiration_at_ms: future }, now)).toBe('ACTIVE');
    expect(statusForEvent({ id: '1', type: 'INITIAL_PURCHASE', period_type: 'TRIAL', expiration_at_ms: future }, now)).toBe('TRIAL');
    expect(statusForEvent({ id: '1', type: 'CANCELLATION', expiration_at_ms: future }, now)).toBe('CANCELLED');
    expect(statusForEvent({ id: '1', type: 'CANCELLATION', expiration_at_ms: past }, now)).toBe('EXPIRED');
    expect(statusForEvent({ id: '1', type: 'BILLING_ISSUE', expiration_at_ms: future }, now)).toBe('BILLING_ISSUE');
    expect(statusForEvent({ id: '1', type: 'EXPIRATION', expiration_at_ms: past }, now)).toBe('EXPIRED');
    expect(statusForEvent({ id: '1', type: 'SUBSCRIBER_ALIAS' }, now)).toBeNull();
  });

  it('cancelar não tira o que está pago; reembolso tira logo', () => {
    const cancel = { id: '1', type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', expiration_at_ms: future };
    const refund = { id: '2', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', expiration_at_ms: future };
    expect(isRefund(cancel)).toBe(false);
    expect(isRefund(refund)).toBe(true);
    expect(statusForEvent(cancel, now)).toBe('CANCELLED');
    expect(statusForEvent(refund, now)).toBe('EXPIRED');
    expect(statusForEvent({ id: '3', type: 'UNCANCELLATION', expiration_at_ms: future }, now)).toBe('ACTIVE');
    expect(statusForEvent({ id: '4', type: 'SUBSCRIPTION_PAUSED', expiration_at_ms: future }, now)).toBe('CANCELLED');
    expect(statusForEvent({ id: '5', type: 'SUBSCRIPTION_PAUSED', expiration_at_ms: past }, now)).toBe('EXPIRED');
  });

  it('cobrança falhada: o acesso dura só enquanto a loja der tolerância', () => {
    expect(statusForEvent({ id: '1', type: 'BILLING_ISSUE', expiration_at_ms: past, grace_period_expiration_at_ms: future }, now)).toBe('BILLING_ISSUE');
    expect(statusForEvent({ id: '1', type: 'BILLING_ISSUE', expiration_at_ms: future, grace_period_expiration_at_ms: past }, now)).toBe('EXPIRED');
    expect(statusForEvent({ id: '1', type: 'BILLING_ISSUE', expiration_at_ms: past }, now)).toBe('EXPIRED');
  });

  it('pagar uma vez: os dias somam-se ao que ainda faltava', () => {
    const day = 86_400_000;
    const at = (d: number) => new Date(now + d * day);
    expect(stackPasses([])).toBeNull();
    // Uma compra: 31 dias a contar do dia da compra.
    expect(stackPasses([{ at: at(0), days: 31 }])).toEqual({ start: at(0), end: at(31) });
    // Segunda compra ao 10.º dia: soma ao fim (62), não ao dia da compra (41).
    expect(stackPasses([{ at: at(0), days: 31 }, { at: at(10), days: 31 }])).toEqual({ start: at(0), end: at(62) });
    // A ordem em que chegam não interessa.
    expect(stackPasses([{ at: at(10), days: 31 }, { at: at(0), days: 31 }])).toEqual({ start: at(0), end: at(62) });
    // Com um intervalo sem plano, recomeça no dia da compra nova.
    expect(stackPasses([{ at: at(0), days: 31 }, { at: at(100), days: 31 }])).toEqual({ start: at(100), end: at(131) });
    // Um passe sem fim fica para sempre, venha o que vier depois.
    expect(stackPasses([{ at: at(0), days: null }, { at: at(5), days: 31 }])).toEqual({ start: at(0), end: null });
    expect(stackPasses([{ at: at(0), days: 31 }, { at: at(5), days: null }])).toEqual({ start: at(0), end: null });
  });

  it('avisa ao arrancar quando os pagamentos estão mal configurados (só em produção)', () => {
    const ok = { NODE_ENV: 'production', REVENUECAT_WEBHOOK_AUTH: 'Bearer ' + 'x'.repeat(40), REVENUECAT_SECRET_API_KEY: 'sk_test', BILLING_DEV_GRANTS: 'false' };
    expect(billingConfigWarnings(ok)).toEqual([]);
    expect(billingConfigWarnings({ ...ok, REVENUECAT_WEBHOOK_AUTH: '' })).toHaveLength(1);
    expect(billingConfigWarnings({ ...ok, REVENUECAT_WEBHOOK_AUTH: 'Bearer curto' })).toHaveLength(1);
    expect(billingConfigWarnings({ ...ok, REVENUECAT_SECRET_API_KEY: undefined, BILLING_DEV_GRANTS: 'true' })).toHaveLength(2);
    expect(billingConfigWarnings({ NODE_ENV: 'development', BILLING_DEV_GRANTS: 'true' })).toEqual([]);
  });

  it('plataforma pela loja', () => {
    expect(platformForStore('APP_STORE')).toBe('IOS');
    expect(platformForStore('PLAY_STORE')).toBe('ANDROID');
    expect(platformForStore('STRIPE')).toBe('WEB');
    expect(platformForStore('PROMOTIONAL')).toBe('OTHER');
  });
});
