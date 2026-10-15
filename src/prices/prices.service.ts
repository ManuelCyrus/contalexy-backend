import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { ApiException } from '../common/errors/api.exception';
import { FEATURES } from '../billing/plans.catalog';
import { fromDbDate, todayIn, toDbDate } from '../common/utils/dates';
import { money, num, round2 } from '../common/utils/money';
import { dateOnly, positiveMoney, uuid } from '../accounts/accounts.dto';
import { PriceRecord } from '../generated/prisma/client';
import { toAttachmentDto } from '../storage/attachments.service';

export const UNITS = ['un', 'kg', 'g', 'l', 'ml'] as const;

export const createPriceSchema = z.object({
  productName: z.string().trim().min(1).max(120),
  brand: z.string().trim().max(60).nullable().optional(),
  price: positiveMoney,
  currency: z.string().trim().toUpperCase().length(3).optional(),
  quantity: z.number().positive().max(1e6).nullable().optional(),
  unit: z.enum(UNITS).nullable().optional(),
  storeName: z.string().trim().max(80).nullable().optional(),
  barcode: z.string().trim().max(32).nullable().optional(),
  date: dateOnly.optional(),
  attachmentId: uuid.nullable().optional(),
});
export type CreatePriceDto = z.infer<typeof createPriceSchema>;

/// "Leite Mimosa 1L" e "leite mimosa 1 l" contam como o mesmo produto.
export function normalizeProductName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\d)\s+(kg|g|l|ml|cl|un)\b/g, '$1$2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/// Preço por kg / litro / unidade (para comparar embalagens diferentes).
export function unitPrice(price: number, quantity: number | null, unit: string | null): { value: number; per: string } | null {
  if (!quantity || !unit) return null;
  switch (unit) {
    case 'g':
      return { value: round2(price / (quantity / 1000)), per: 'kg' };
    case 'kg':
      return { value: round2(price / quantity), per: 'kg' };
    case 'ml':
      return { value: round2(price / (quantity / 1000)), per: 'l' };
    case 'l':
      return { value: round2(price / quantity), per: 'l' };
    case 'un':
      return { value: round2(price / quantity), per: 'un' };
    default:
      return null;
  }
}

/// Histórico de preços (Premium): o que pagaste por cada produto, onde e
/// quando — para saber se está caro.
@Injectable()
export class PricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private dto(r: PriceRecord & { attachment?: { id: string; kind: never; mimeType: string; size: number; createdAt: Date } | null }) {
    const price = num(r.price);
    const quantity = r.quantity ? Number(r.quantity) : null;
    return {
      id: r.id,
      productName: r.productName,
      normalizedName: r.normalizedName,
      brand: r.brand,
      price,
      currency: r.currency,
      quantity,
      unit: r.unit,
      unitPrice: unitPrice(price, quantity, r.unit),
      storeName: r.storeName,
      barcode: r.barcode,
      date: fromDbDate(r.date),
      attachment: r.attachment ? toAttachmentDto(r.attachment) : null,
      createdAt: r.createdAt,
    };
  }

  async create(userId: string, dto: CreatePriceDto) {
    await this.entitlements.assertFeature(userId, FEATURES.pricesHistory);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { currency: true, timezone: true } });
    if (dto.attachmentId) {
      const a = await this.prisma.attachment.findFirst({ where: { id: dto.attachmentId, userId }, select: { id: true } });
      if (!a) throw ApiException.notFound('FILE_NOT_FOUND');
    }
    const record = await this.prisma.priceRecord.create({
      data: {
        userId,
        productName: dto.productName,
        normalizedName: normalizeProductName(dto.productName),
        brand: dto.brand ?? null,
        price: money(dto.price),
        currency: dto.currency ?? user?.currency ?? 'EUR',
        quantity: dto.quantity ?? null,
        unit: dto.unit ?? null,
        storeName: dto.storeName ?? null,
        barcode: dto.barcode ?? null,
        date: toDbDate(dto.date ?? todayIn(user?.timezone ?? 'UTC')),
        attachmentId: dto.attachmentId ?? null,
      },
      include: { attachment: true },
    });
    return this.dto(record as never);
  }

  /// Amostra para quem já não tem o plano: quantos produtos guardou e o nome
  /// de alguns — sem preços, lojas nem datas. Serve para a pessoa ver que os
  /// dados continuam lá à espera dela.
  async teaser(userId: string) {
    const [records, groups] = await Promise.all([
      this.prisma.priceRecord.count({ where: { userId } }),
      this.prisma.priceRecord.groupBy({ by: ['normalizedName'], where: { userId }, _count: { _all: true }, _max: { createdAt: true } }),
    ]);
    const recent = [...groups].sort((a, b) => (b._max.createdAt?.getTime() ?? 0) - (a._max.createdAt?.getTime() ?? 0)).slice(0, 3);
    const names = recent.length
      ? await this.prisma.priceRecord.findMany({
          where: { userId, normalizedName: { in: recent.map((g) => g.normalizedName) } },
          orderBy: { createdAt: 'desc' },
          select: { productName: true, normalizedName: true },
        })
      : [];
    return {
      products: groups.length,
      records,
      sample: recent.map((g) => ({ name: names.find((n) => n.normalizedName === g.normalizedName)?.productName ?? g.normalizedName, count: g._count._all })),
      locked: !(await this.entitlements.hasFeature(userId, FEATURES.pricesHistory)),
    };
  }

  /// Lista de produtos com o último preço, mínimo, máximo e tendência.
  async products(userId: string, q?: string) {
    await this.entitlements.assertFeature(userId, FEATURES.pricesHistory);
    const filter = q ? normalizeProductName(q) : '';
    const records = await this.prisma.priceRecord.findMany({
      where: { userId, ...(filter ? { normalizedName: { contains: filter } } : {}) },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 3000,
    });
    const groups = new Map<string, PriceRecord[]>();
    for (const r of records) {
      const key = `${r.normalizedName}|${r.currency}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    return [...groups.values()]
      .map((list) => {
        const prices = list.map((r) => num(r.price));
        const last = list[0];
        const previous = list[1];
        return {
          name: last.productName,
          normalizedName: last.normalizedName,
          brand: last.brand,
          currency: last.currency,
          lastPrice: prices[0],
          lastStore: last.storeName,
          lastDate: fromDbDate(last.date),
          minPrice: Math.min(...prices),
          maxPrice: Math.max(...prices),
          avgPrice: round2(prices.reduce((a, b) => a + b, 0) / prices.length),
          count: list.length,
          /// Último vs. anterior (% de diferença)
          change: previous ? round2(((prices[0] - num(previous.price)) / num(previous.price)) * 100) : null,
        };
      })
      .sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));
  }

  async history(userId: string, name: string) {
    await this.entitlements.assertFeature(userId, FEATURES.pricesHistory);
    const normalized = normalizeProductName(name);
    const records = await this.prisma.priceRecord.findMany({
      where: { userId, normalizedName: normalized },
      include: { attachment: true },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 300,
    });
    if (!records.length) throw ApiException.notFound('PRICE_NOT_FOUND');
    const items = records.map((r) => this.dto(r as never));
    const stores = new Map<string, { store: string; min: number; last: number; lastDate: string; count: number }>();
    for (const i of items) {
      // Sem loja: fica com o nome vazio (a app mostra "Sem loja").
      const key = (i.storeName ?? '').trim();
      const s = stores.get(key) ?? { store: key, min: i.price, last: i.price, lastDate: i.date, count: 0 };
      s.min = Math.min(s.min, i.price);
      s.count++;
      stores.set(key, s);
    }
    const prices = items.map((i) => i.price);
    return {
      name: items[0].productName,
      normalizedName: normalized,
      currency: items[0].currency,
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      avgPrice: round2(prices.reduce((a, b) => a + b, 0) / prices.length),
      cheapestStore: [...stores.values()].sort((a, b) => a.min - b.min)[0]?.store ?? null,
      stores: [...stores.values()].sort((a, b) => a.min - b.min),
      records: items,
    };
  }

  async remove(userId: string, id: string) {
    const result = await this.prisma.priceRecord.deleteMany({ where: { id, userId } });
    if (!result.count) throw ApiException.notFound('PRICE_NOT_FOUND');
    return { deleted: true };
  }
}
