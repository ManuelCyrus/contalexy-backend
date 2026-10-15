import { estimateCost, limitLevel } from './ai-budget.service';
import { resetEnvCache } from '../config/env';

describe('teto global da IA', () => {
  const saved = { ...process.env };
  beforeAll(() => {
    process.env = {
      ...saved,
      DATABASE_URL: 'postgresql://x',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      AI_MODEL: 'modelo-base',
      AI_MODEL_ADVANCED: 'modelo-avancado',
      AI_PRICE_INPUT_PER_MTOK: '1',
      AI_PRICE_OUTPUT_PER_MTOK: '5',
      AI_PRICE_ADVANCED_INPUT_PER_MTOK: '3',
      AI_PRICE_ADVANCED_OUTPUT_PER_MTOK: '15',
    };
    resetEnvCache();
  });
  afterAll(() => {
    process.env = saved;
    resetEnvCache();
  });

  it('sem teto nunca limita; com teto, pesadas a 80% e tudo a 100%', () => {
    expect(limitLevel(999, 0)).toBe('none');
    expect(limitLevel(39.9, 50)).toBe('none');
    expect(limitLevel(40, 50)).toBe('heavy');
    expect(limitLevel(49.99, 50)).toBe('heavy');
    expect(limitLevel(50, 50)).toBe('all');
  });

  it('custo estimado pelos preços do modelo usado', () => {
    expect(estimateCost('modelo-base', 1_000_000, 0)).toBe(1);
    expect(estimateCost('modelo-base', 2000, 500)).toBeCloseTo(0.0045, 6);
    expect(estimateCost('modelo-avancado', 2000, 500)).toBeCloseTo(0.0135, 6);
  });
});
