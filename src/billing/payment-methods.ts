/// Formas de pagamento por loja e país. É só para a app mostrar o que a
/// pessoa vai encontrar ao comprar: quem cobra e aceita o pagamento é
/// sempre a App Store ou a Google Play (nunca guardamos cartões).
export type PaymentMethod = { key: string; kinds: ('SUBSCRIPTION' | 'ONE_TIME')[] };

const COMMON: PaymentMethod[] = [
  { key: 'card', kinds: ['SUBSCRIPTION', 'ONE_TIME'] },
  { key: 'debit', kinds: ['SUBSCRIPTION', 'ONE_TIME'] },
  { key: 'store_balance', kinds: ['SUBSCRIPTION', 'ONE_TIME'] },
  { key: 'gift_card', kinds: ['SUBSCRIPTION', 'ONE_TIME'] },
];

/// Métodos a mais em alguns países (como as lojas os anunciam).
const BY_COUNTRY: Record<string, { ios?: PaymentMethod[]; android?: PaymentMethod[] }> = {
  BR: {
    android: [
      { key: 'pix', kinds: ['ONE_TIME'] },
      { key: 'boleto', kinds: ['ONE_TIME'] },
      { key: 'carrier', kinds: ['SUBSCRIPTION', 'ONE_TIME'] },
    ],
    ios: [{ key: 'pix', kinds: ['ONE_TIME'] }],
  },
  PT: { android: [{ key: 'mbway', kinds: ['SUBSCRIPTION', 'ONE_TIME'] }, { key: 'paypal', kinds: ['SUBSCRIPTION', 'ONE_TIME'] }], ios: [] },
  AO: { android: [{ key: 'carrier', kinds: ['ONE_TIME'] }], ios: [] },
};

export function paymentMethodsFor(input: { country: string; platform?: string | null }) {
  const country = input.country.toUpperCase();
  const platform = (input.platform ?? 'android').toLowerCase() === 'ios' ? 'ios' : 'android';
  const extra = BY_COUNTRY[country]?.[platform] ?? [];
  const methods = [...COMMON, ...(platform === 'ios' ? [{ key: 'apple_pay', kinds: ['SUBSCRIPTION', 'ONE_TIME'] as ('SUBSCRIPTION' | 'ONE_TIME')[] }] : [{ key: 'google_pay', kinds: ['SUBSCRIPTION', 'ONE_TIME'] as ('SUBSCRIPTION' | 'ONE_TIME')[] }]), ...extra];
  return {
    country,
    platform,
    store: platform === 'ios' ? 'App Store' : 'Google Play',
    methods,
    /// A lista final é a da loja no momento da compra; esta serve para informar.
    note: 'store_decides',
  };
}
