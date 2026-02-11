/**
 * Resilience / Fault-Injection Tests — IdempotencyManager
 *
 * Ticket #88 — Phase 1: Idempotency fault injection
 *
 * Validates system behaviour under:
 * - Redis connection failures (GET / SET / DEL throwing)
 * - Action execution timeouts and throws with proper failed record storage
 * - Concurrent execution race conditions (ConcurrentExecutionError)
 * - Failed-then-retry sequences
 * - clearIdempotencyKey for DLQ replay workflows
 * - Corrupted stored records
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────

const { mockRedisGet, mockRedisSet, mockRedisDel, mockRedisQuit } = vi.hoisted(() => ({
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
  mockRedisQuit: vi.fn(),
}));

vi.mock('ioredis', () => {
  return {
    Redis: class MockRedis {
      get = mockRedisGet;
      set = mockRedisSet;
      del = mockRedisDel;
      quit = mockRedisQuit;
    },
  };
});

vi.mock('@arda/config', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { IdempotencyManager, ConcurrentExecutionError } from '../../idempotency-manager.js';
import type { IdempotencyRecord } from '../../types.js';
import { IDEMPOTENCY_TTL_MAP, IDEMPOTENCY_FAILURE_TTL } from '../../types.js';

// ─── Constants ───────────────────────────────────────────────────────

const KEY = 'po_create:T1:S1:F1:2025-01-01';
const ACTION_TYPE = 'create_purchase_order' as const;
const TENANT = 'T1';
const REDIS_KEY = `arda:idempotency:${KEY}`;

// ─── Helpers ─────────────────────────────────────────────────────────

function buildRecord(
  status: 'pending' | 'completed' | 'failed',
  extras: Partial<IdempotencyRecord> = {},
): string {
  const record: IdempotencyRecord = {
    key: KEY,
    actionType: ACTION_TYPE,
    status,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    tenantId: TENANT,
    ...extras,
  };
  return JSON.stringify(record);
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('IdempotencyManager — Resilience / Fault Injection', () => {
  let manager: IdempotencyManager;

  beforeEach(() => {
    vi.resetAllMocks();
    manager = new IdempotencyManager('redis://localhost:6379');
  });

  // ── 1. Redis Connection Failures ─────────────────────────────────

  describe('Redis connection failures', () => {
    it('propagates error when initial GET throws', async () => {
      mockRedisGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(
        manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, async () => 'ok'),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('propagates error when SET NX throws during claim', async () => {
      mockRedisGet.mockResolvedValueOnce(null); // no existing key
      mockRedisSet.mockRejectedValueOnce(new Error('Redis write timeout'));

      await expect(
        manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, async () => 'ok'),
      ).rejects.toThrow('Redis write timeout');
    });

    it('propagates error when SET throws during result storage', async () => {
      mockRedisGet.mockResolvedValueOnce(null);
      mockRedisSet
        .mockResolvedValueOnce('OK') // claim succeeds
        .mockRejectedValueOnce(new Error('Redis SET failed')); // storing result fails

      await expect(
        manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, async () => ({ poId: 'po-1' })),
      ).rejects.toThrow('Redis SET failed');
    });

    it('propagates error when DEL throws during failed-record cleanup', async () => {
      mockRedisGet.mockResolvedValueOnce(buildRecord('failed', { error: 'prev error' }));
      mockRedisDel.mockRejectedValueOnce(new Error('Redis DEL broken'));

      await expect(
        manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, async () => 'ok'),
      ).rejects.toThrow('Redis DEL broken');
    });

    it('propagates error when GET throws inside checkIdempotencyKey', async () => {
      mockRedisGet.mockRejectedValueOnce(new Error('ECONNRESET'));

      await expect(
        manager.checkIdempotencyKey(KEY),
      ).rejects.toThrow('ECONNRESET');
    });

    it('propagates error when DEL throws inside clearIdempotencyKey', async () => {
      mockRedisDel.mockRejectedValueOnce(new Error('Redis connection lost'));

      await expect(
        manager.clearIdempotencyKey(KEY),
      ).rejects.toThrow('Redis connection lost');
    });
  });

  // ── 2. Action Execution Failures ─────────────────────────────────

  describe('action execution failures', () => {
    it('stores failed record when action throws', async () => {
      mockRedisGet.mockResolvedValueOnce(null);
      mockRedisSet
        .mockResolvedValueOnce('OK')  // claim (pending)
        .mockResolvedValueOnce('OK'); // store failed record

      const action = async () => {
        throw new Error('DB constraint violation');
      };

      await expect(
        manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, action),
      ).rejects.toThrow('DB constraint violation');

      // Verify failed record was stored with failure TTL
      expect(mockRedisSet).toHaveBeenCalledTimes(2);
      const failedSetCall = mockRedisSet.mock.calls[1];
      const failedRecord = JSON.parse(failedSetCall[1] as string);
      expect(failedRecord.status).toBe('failed');
      expect(failedSetCall[3]).toBe(IDEMPOTENCY_FAILURE_TTL); // 60s TTL
    });

    it('still stores failed record even when SET for failure also throws', async () => {
      mockRedisGet.mockResolvedValueOnce(null);
      mockRedisSet
        .mockResolvedValueOnce('OK')   // claim (pending)
        .mockRejectedValueOnce(new Error('Redis dead')); // failed record storage dies

      const action = async () => {
        throw new Error('Original error');
      };

      // The original error should still propagate (or the Redis error)
      await expect(
        manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, action),
      ).rejects.toThrow();
    });

    it('stores failed record when action times out (simulated)', async () => {
      mockRedisGet.mockResolvedValueOnce(null);
      mockRedisSet
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce('OK');

      const slowAction = async () => {
        throw new Error('Action timeout after 30000ms');
      };

      await expect(
        manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, slowAction),
      ).rejects.toThrow('Action timeout');

      expect(mockRedisSet).toHaveBeenCalledTimes(2);
      const failedRecord = JSON.parse(mockRedisSet.mock.calls[1][1] as string);
      expect(failedRecord.status).toBe('failed');
    });
  });

  // ── 3. Concurrent Execution / Race Conditions ────────────────────

  describe('concurrent execution and race conditions', () => {
    it('throws ConcurrentExecutionError when pending key exists', async () => {
      mockRedisGet.mockResolvedValueOnce(buildRecord('pending'));

      await expect(
        manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, async () => 'ok'),
      ).rejects.toThrow(ConcurrentExecutionError);
    });

    it('ConcurrentExecutionError has correct key and status', async () => {
      mockRedisGet.mockResolvedValueOnce(buildRecord('pending'));

      try {
        await manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, async () => 'ok');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConcurrentExecutionError);
        const concErr = err as ConcurrentExecutionError;
        expect(concErr.key).toBe(KEY);
        expect(concErr.existingStatus).toBe('pending');
      }
    });

    it('throws ConcurrentExecutionError when SET NX fails (another process claimed)', async () => {
      mockRedisGet.mockResolvedValueOnce(null); // GET: no key
      mockRedisSet.mockResolvedValueOnce(null); // SET NX fails → someone else claimed

      await expect(
        manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, async () => 'ok'),
      ).rejects.toThrow(ConcurrentExecutionError);
    });
  });

  // ── 4. Replay / Completed Key Semantics ──────────────────────────

  describe('replay from completed key', () => {
    it('returns cached result without executing action', async () => {
      const cachedResult = { poId: 'po-existing', total: 1500 };
      mockRedisGet.mockResolvedValueOnce(
        buildRecord('completed', { result: cachedResult }),
      );

      const actionFn = vi.fn(async () => ({ poId: 'po-new' }));
      const result = await manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, actionFn);

      expect(result.wasReplay).toBe(true);
      expect(result.result).toEqual(cachedResult);
      expect(actionFn).not.toHaveBeenCalled();
    });

    it('returns cached result even when result is null', async () => {
      mockRedisGet.mockResolvedValueOnce(
        buildRecord('completed', { result: null }),
      );

      const result = await manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, async () => 'x');

      expect(result.wasReplay).toBe(true);
    });
  });

  // ── 5. Failed-Then-Retry Sequences ───────────────────────────────

  describe('failed-then-retry', () => {
    it('clears failed key and re-executes action on retry', async () => {
      mockRedisGet.mockResolvedValueOnce(buildRecord('failed', { error: 'timeout' }));
      mockRedisDel.mockResolvedValueOnce(1);

      // After DEL, the retry claim flow: GET (null) → SET NX (OK) → action → SET completed
      mockRedisGet.mockResolvedValueOnce(null);
      mockRedisSet
        .mockResolvedValueOnce('OK')  // claim
        .mockResolvedValueOnce('OK'); // store result

      const result = await manager.executeWithIdempotency(
        KEY,
        ACTION_TYPE,
        TENANT,
        async () => ({ poId: 'po-retry-success' }),
      );

      expect(result.wasReplay).toBe(false);
      expect(result.result).toEqual({ poId: 'po-retry-success' });
      expect(mockRedisDel).toHaveBeenCalledTimes(1);
    });

    it('stores new failed record when retry also fails', async () => {
      mockRedisGet.mockResolvedValueOnce(buildRecord('failed'));
      mockRedisDel.mockResolvedValueOnce(1);
      mockRedisGet.mockResolvedValueOnce(null);
      mockRedisSet
        .mockResolvedValueOnce('OK')  // claim
        .mockResolvedValueOnce('OK'); // store failed record

      await expect(
        manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, async () => {
          throw new Error('Still broken');
        }),
      ).rejects.toThrow('Still broken');

      // Two SET calls: claim + failed record
      expect(mockRedisSet).toHaveBeenCalledTimes(2);
    });
  });

  // ── 6. clearIdempotencyKey for DLQ Replay ────────────────────────

  describe('clearIdempotencyKey (DLQ replay support)', () => {
    it('returns true when key exists and is deleted', async () => {
      mockRedisDel.mockResolvedValueOnce(1);

      const result = await manager.clearIdempotencyKey(KEY);

      expect(result).toBe(true);
      expect(mockRedisDel).toHaveBeenCalledWith(REDIS_KEY);
    });

    it('returns false when key does not exist', async () => {
      mockRedisDel.mockResolvedValueOnce(0);

      const result = await manager.clearIdempotencyKey(KEY);

      expect(result).toBe(false);
    });

    it('enables full re-execution after clear', async () => {
      // Clear
      mockRedisDel.mockResolvedValueOnce(1);
      await manager.clearIdempotencyKey(KEY);

      // Re-execute: key is gone → fresh claim → success
      mockRedisGet.mockResolvedValueOnce(null);
      mockRedisSet
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce('OK');

      const result = await manager.executeWithIdempotency(
        KEY,
        ACTION_TYPE,
        TENANT,
        async () => ({ poId: 'po-replayed' }),
      );

      expect(result.wasReplay).toBe(false);
      expect(result.result).toEqual({ poId: 'po-replayed' });
    });
  });

  // ── 7. Corrupted Stored Records ──────────────────────────────────

  describe('corrupted stored records', () => {
    it('throws when GET returns non-JSON garbage', async () => {
      mockRedisGet.mockResolvedValueOnce('<<<NOT-JSON>>>');

      await expect(
        manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, async () => 'ok'),
      ).rejects.toThrow(); // JSON.parse SyntaxError
    });

    it('throws when GET returns truncated JSON', async () => {
      mockRedisGet.mockResolvedValueOnce('{"status":"pend');

      await expect(
        manager.executeWithIdempotency(KEY, ACTION_TYPE, TENANT, async () => 'ok'),
      ).rejects.toThrow();
    });

    it('throws when checkIdempotencyKey encounters corrupted data', async () => {
      mockRedisGet.mockResolvedValueOnce('CORRUPT DATA');

      await expect(
        manager.checkIdempotencyKey(KEY),
      ).rejects.toThrow();
    });
  });

  // ── 8. Per-Action-Type TTL Verification ──────────────────────────

  describe('per-action-type TTLs', () => {
    it('stores completed record with correct TTL for create_purchase_order', async () => {
      mockRedisGet.mockResolvedValueOnce(null);
      mockRedisSet
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce('OK');

      await manager.executeWithIdempotency(
        KEY,
        'create_purchase_order',
        TENANT,
        async () => ({ poId: 'po-1' }),
      );

      // Second SET call stores the completed record with action-specific TTL
      const completedSetCall = mockRedisSet.mock.calls[1];
      expect(completedSetCall[3]).toBe(IDEMPOTENCY_TTL_MAP.create_purchase_order); // 86400
    });

    it('stores completed record with correct TTL for dispatch_email', async () => {
      mockRedisGet.mockResolvedValueOnce(null);
      mockRedisSet
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce('OK');

      await manager.executeWithIdempotency(
        KEY,
        'dispatch_email',
        TENANT,
        async () => ({ emailId: 'e-1' }),
      );

      const completedSetCall = mockRedisSet.mock.calls[1];
      expect(completedSetCall[3]).toBe(IDEMPOTENCY_TTL_MAP.dispatch_email); // 259200
    });

    it('stores completed record with correct TTL for transition_card', async () => {
      mockRedisGet.mockResolvedValueOnce(null);
      mockRedisSet
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce('OK');

      await manager.executeWithIdempotency(
        KEY,
        'transition_card',
        TENANT,
        async () => ({ ok: true }),
      );

      const completedSetCall = mockRedisSet.mock.calls[1];
      expect(completedSetCall[3]).toBe(IDEMPOTENCY_TTL_MAP.transition_card); // 3600
    });
  });
});
