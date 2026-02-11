import { Redis } from 'ioredis';
import { createLogger } from '@arda/config';
import type { ScanDedupeResult } from '@arda/shared-types';

const log = createLogger('scan:dedupe');

const KEY_PREFIX = 'arda:scan:dedupe:';
const PENDING_TTL = 30;      // 30 seconds for in-flight scans
const COMPLETED_TTL = 300;   // 5 minutes for completed scan cache
const FAILED_TTL = 10;       // 10 seconds before retry allowed

interface DedupeRecord {
  cardId: string;
  idempotencyKey: string;
  tenantId: string;
  status: 'pending' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  createdAt: string;
}

export class ScanDuplicateError extends Error {
  constructor(
    public readonly cardId: string,
    public readonly idempotencyKey: string,
    public readonly existingStatus: string,
  ) {
    super(`Duplicate scan detected for card "${cardId}" (key: ${idempotencyKey}, status: ${existingStatus})`);
    this.name = 'ScanDuplicateError';
  }
}

export class ScanDedupeManager {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async checkAndClaim(
    cardId: string,
    idempotencyKey: string,
    tenantId: string,
  ): Promise<ScanDedupeResult> {
    const redisKey = `${KEY_PREFIX}${cardId}:${idempotencyKey}`;

    const existing = await this.redis.get(redisKey);

    if (existing) {
      const record: DedupeRecord = JSON.parse(existing);

      if (record.status === 'completed') {
        log.info({ cardId, idempotencyKey }, 'Scan dedupe: returning cached result');
        return {
          allowed: false,
          existingStatus: 'completed',
          cachedResult: record.result,
          wasReplay: true,
        };
      }

      if (record.status === 'pending') {
        log.warn({ cardId, idempotencyKey }, 'Scan dedupe: duplicate in progress');
        return {
          allowed: false,
          existingStatus: 'pending',
          wasReplay: false,
        };
      }

      if (record.status === 'failed') {
        log.info({ cardId, idempotencyKey }, 'Scan dedupe: previous attempt failed, allowing retry');
        await this.redis.del(redisKey);
      }
    }

    const pendingRecord: DedupeRecord = {
      cardId,
      idempotencyKey,
      tenantId,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    const claimed = await this.redis.set(
      redisKey,
      JSON.stringify(pendingRecord),
      'EX',
      PENDING_TTL,
      'NX',
    );

    if (!claimed) {
      // Race condition
      const raceRaw = await this.redis.get(redisKey);
      const raceStatus = raceRaw ? (JSON.parse(raceRaw) as DedupeRecord).status : 'unknown';
      log.warn({ cardId, idempotencyKey, raceStatus }, 'Scan dedupe: race condition on claim');
      return {
        allowed: false,
        existingStatus: raceStatus,
        wasReplay: false,
      };
    }

    return { allowed: true, wasReplay: false };
  }

  async markCompleted(
    cardId: string,
    idempotencyKey: string,
    result: unknown,
  ): Promise<void> {
    const redisKey = `${KEY_PREFIX}${cardId}:${idempotencyKey}`;
    const raw = await this.redis.get(redisKey);
    if (!raw) return;

    const record: DedupeRecord = JSON.parse(raw);
    record.status = 'completed';
    record.result = result;

    await this.redis.set(redisKey, JSON.stringify(record), 'EX', COMPLETED_TTL);
    log.info({ cardId, idempotencyKey }, 'Scan dedupe: marked completed');
  }

  async markFailed(
    cardId: string,
    idempotencyKey: string,
    error: string,
  ): Promise<void> {
    const redisKey = `${KEY_PREFIX}${cardId}:${idempotencyKey}`;
    const raw = await this.redis.get(redisKey);
    if (!raw) return;

    const record: DedupeRecord = JSON.parse(raw);
    record.status = 'failed';
    record.error = error;

    await this.redis.set(redisKey, JSON.stringify(record), 'EX', FAILED_TTL);
    log.info({ cardId, idempotencyKey, error }, 'Scan dedupe: marked failed');
  }

  async shutdown(): Promise<void> {
    await this.redis.quit();
  }
}
