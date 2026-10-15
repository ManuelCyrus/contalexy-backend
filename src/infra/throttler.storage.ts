import { Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from './redis.service';

/// Os limites de pedidos (@nestjs/throttler) contados no Redis, para valerem
/// para todos os servidores; sem Redis ficam em memória.
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: RedisService) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const blockKey = `thr:block:${throttlerName}:${key}`;
    const blocked = await this.redis.get(blockKey);
    if (blocked) {
      const until = Number(blocked);
      return { totalHits: limit + 1, timeToExpire: 0, isBlocked: true, timeToBlockExpire: Math.max(0, Math.ceil((until - Date.now()) / 1000)) };
    }
    const { count, ttl: left } = await this.redis.hit(`thr:${throttlerName}:${key}`, Math.max(1, Math.ceil(ttl / 1000)));
    if (count > limit && blockDuration > 0) {
      const seconds = Math.max(1, Math.ceil(blockDuration / 1000));
      await this.redis.set(blockKey, String(Date.now() + seconds * 1000), seconds);
      return { totalHits: count, timeToExpire: left, isBlocked: true, timeToBlockExpire: seconds };
    }
    return { totalHits: count, timeToExpire: left, isBlocked: false, timeToBlockExpire: 0 };
  }
}
