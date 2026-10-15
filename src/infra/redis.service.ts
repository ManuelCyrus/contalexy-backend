import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../config/env';

/// Redis para cache, limites de pedidos e cadeados curtos. Sem REDIS_URL
/// funciona tudo em memória (só vale para um processo; em produção com
/// vários servidores põe o Redis).
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private readonly memory = new Map<string, { value: string; expiresAt: number }>();

  constructor() {
    const url = env().REDIS_URL;
    if (url) {
      this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false });
      this.client.on('error', (err) => this.logger.warn(`Redis: ${err.message}`));
      this.client.connect().catch((err) => this.logger.warn(`Redis sem ligação: ${err.message}`));
    }
  }

  get enabled() {
    return !!this.client && this.client.status === 'ready';
  }

  private sweep() {
    if (this.memory.size < 5000) return;
    const now = Date.now();
    for (const [k, v] of this.memory) if (v.expiresAt <= now) this.memory.delete(k);
  }

  async get(key: string): Promise<string | null> {
    if (this.enabled) return this.client!.get(key);
    const hit = this.memory.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    if (this.enabled) {
      await this.client!.set(key, value, 'EX', ttlSeconds);
      return;
    }
    this.sweep();
    this.memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string) {
    if (this.enabled) await this.client!.del(key);
    else this.memory.delete(key);
  }

  /// Soma 1 e devolve o total na janela; a janela começa na primeira chamada.
  async hit(key: string, ttlSeconds: number): Promise<{ count: number; ttl: number }> {
    if (this.enabled) {
      const results = await this.client!.multi().incr(key).pttl(key).exec();
      const count = Number(results?.[0]?.[1] ?? 1);
      let ttl = Number(results?.[1]?.[1] ?? -1);
      if (ttl < 0) {
        await this.client!.pexpire(key, ttlSeconds * 1000);
        ttl = ttlSeconds * 1000;
      }
      return { count, ttl: Math.ceil(ttl / 1000) };
    }
    this.sweep();
    const now = Date.now();
    const hit = this.memory.get(key);
    if (!hit || hit.expiresAt <= now) {
      this.memory.set(key, { value: '1', expiresAt: now + ttlSeconds * 1000 });
      return { count: 1, ttl: ttlSeconds };
    }
    hit.value = String(Number(hit.value) + 1);
    return { count: Number(hit.value), ttl: Math.ceil((hit.expiresAt - now) / 1000) };
  }

  /// Cadeado curto (só uma vez): true se este pedido o apanhou.
  async lock(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.enabled) return (await this.client!.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
    if (await this.get(key)) return false;
    await this.set(key, '1', ttlSeconds);
    return true;
  }

  /// Cache de um valor JSON (sem Redis fica em memória).
  async remember<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    const cached = await this.get(key).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached) as T;
      } catch {
        /* cache estragada: volta a calcular */
      }
    }
    const value = await fn();
    await this.set(key, JSON.stringify(value), ttlSeconds).catch(() => undefined);
    return value;
  }

  onModuleDestroy() {
    this.client?.disconnect();
  }
}
