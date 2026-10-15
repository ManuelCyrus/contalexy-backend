import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { env, isTrue } from '../config/env';
import { round2 } from '../common/utils/money';
import { fromDbDate, toDbDate } from '../common/utils/dates';
import { Prisma } from '../generated/prisma/client';

const BASE = 'EUR';

/// Câmbios do dia (base EUR), para mostrar totais na moeda principal
/// quando há contas noutras moedas. Fonte por defeito: open.er-api.com
/// (gratuita, inclui AOA, BRL, MZN, CVE…).
@Injectable()
export class ExchangeService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeService.name);
  private rates = new Map<string, number>([[BASE, 1]]);
  private ratesDate: string | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      await this.loadFromDb();
    } catch (err) {
      this.logger.warn(`Sem câmbios na base de dados: ${(err as Error).message}`);
    }
    if (!this.ratesDate && isTrue(env().EXCHANGE_RATES_ENABLED) && env().NODE_ENV !== 'test') {
      this.refresh().catch(() => undefined);
    }
  }

  private async loadFromDb() {
    const latest = await this.prisma.exchangeRate.findFirst({ where: { base: BASE }, orderBy: { date: 'desc' }, select: { date: true } });
    if (!latest) return;
    const rows = await this.prisma.exchangeRate.findMany({ where: { base: BASE, date: latest.date } });
    const map = new Map<string, number>([[BASE, 1]]);
    for (const row of rows) map.set(row.quote, Number(row.rate));
    this.rates = map;
    this.ratesDate = fromDbDate(latest.date);
  }

  @Cron('10 4 * * *')
  async refreshJob() {
    if (!isTrue(env().JOBS_ENABLED) || !isTrue(env().EXCHANGE_RATES_ENABLED)) return;
    await this.refresh();
  }

  async refresh(): Promise<boolean> {
    try {
      const response = await fetch(env().EXCHANGE_RATES_URL, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as { rates?: Record<string, number>; base_code?: string; base?: string };
      const base = json.base_code ?? json.base ?? BASE;
      if (base !== BASE || !json.rates) throw new Error('Resposta inesperada');
      const today = fromDbDate(new Date());
      const data = Object.entries(json.rates)
        .filter(([code, rate]) => /^[A-Z]{3}$/.test(code) && Number.isFinite(rate) && rate > 0)
        .map(([quote, rate]) => ({ base: BASE, quote, rate: new Prisma.Decimal(rate), date: toDbDate(today) }));
      await this.prisma.exchangeRate.createMany({ data, skipDuplicates: true });
      this.setRates(Object.fromEntries(data.map((d) => [d.quote, Number(d.rate)])), today);
      this.logger.log(`Câmbios atualizados (${data.length} moedas).`);
      return true;
    } catch (err) {
      this.logger.warn(`Não foi possível atualizar os câmbios: ${(err as Error).message}`);
      return false;
    }
  }

  /// Para testes.
  setRates(rates: Record<string, number>, date = fromDbDate(new Date())) {
    this.rates = new Map<string, number>([[BASE, 1], ...Object.entries(rates)]);
    this.ratesDate = date;
  }

  /// Quanto vale 1 `from` em `to` (null se não houver câmbio).
  rate(from: string, to: string): number | null {
    if (from === to) return 1;
    const rFrom = this.rates.get(from);
    const rTo = this.rates.get(to);
    if (!rFrom || !rTo) return null;
    return rTo / rFrom;
  }

  convert(amount: number, from: string, to: string): number | null {
    const r = this.rate(from, to);
    return r === null ? null : round2(amount * r);
  }

  /// Soma valores em várias moedas na moeda `to`. As que não têm câmbio
  /// ficam de fora e são indicadas (a app avisa).
  total(byCurrency: Record<string, number>, to: string): { total: number; unconverted: string[] } {
    let total = 0;
    const unconverted: string[] = [];
    for (const [currency, amount] of Object.entries(byCurrency)) {
      if (!amount) continue;
      const converted = this.convert(amount, currency, to);
      if (converted === null) unconverted.push(currency);
      else total += converted;
    }
    return { total: round2(total), unconverted };
  }

  latest(base = BASE) {
    const rates: Record<string, number> = {};
    for (const code of this.rates.keys()) {
      const r = this.rate(base, code);
      if (r !== null) rates[code] = Number(r.toFixed(8));
    }
    return { base, date: this.ratesDate, rates, source: 'ExchangeRate-API (open.er-api.com)' };
  }
}
