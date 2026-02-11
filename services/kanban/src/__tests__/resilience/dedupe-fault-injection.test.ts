/**
 * Resilience / Fault-Injection Tests — ScanDedupeManager
 *
 * Ticket #88 — Phase 1: Deduplication fault injection
 *
 * Validates system behaviour under:
 * - Redis connection failures (GET / SET / DEL throwing)
 * - Corrupted / unparseable JSON in stored records
 * - Race conditions (SET NX fails between GET miss and SET)
 * - TTL expiry during multi-step operations
 * - Concurrent duplicate claim attempts
 * - markCompleted / markFailed when the key has already expired
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks (available inside vi.mock factories) ──────────────

const { store, redisMock } = vi.hoisted(() => {
  const store = new Map<string, { value: string; ttl: number }>();

  const redisMock = {
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      return entry ? entry.value : null;
    }),
    set: vi.fn(async (...args: unknown[]) => {
      const [key, value, , ttl, nx] = args as [string, string, string, number, string?];
      if (nx === 'NX' && store.has(key)) return null; // NX fails if key exists
      store.set(key, { value, ttl });
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    quit: vi.fn(async () => 'OK'),
  };

  return { store, redisMock };
});

vi.mock('@arda/config', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  config: { REDIS_URL: 'redis://localhost:6379' },
}));

vi.mock('ioredis', () => {
  function MockRedis() {
    return redisMock;
  }
  return { Redis: MockRedis };
});

import { ScanDedupeManager } from '../../services/scan-dedupe-manager.js';

// ─── Constants ───────────────────────────────────────────────────────

const CARD = 'card-001';
const IDEM = 'idem-aaa';
const TENANT = 'tenant-01';
const KEY_PREFIX = 'arda:scan:dedupe:';

// ─── Helpers ─────────────────────────────────────────────────────────

function buildRedisKey(cardId: string, idempotencyKey: string) {
  return `${KEY_PREFIX}${cardId}:${idempotencyKey}`;
}

function seedRecord(
  cardId: string,
  idempotencyKey: string,
  status: 'pending' | 'completed' | 'failed',
  extras: Record<string, unknown> = {},
) {
  const key = buildRedisKey(cardId, idempotencyKey);
  const record = {
    cardId,
    idempotencyKey,
    tenantId: TENANT,
    status,
    createdAt: new Date().toISOString(),
    ...extras,
  };
  store.set(key, { value: JSON.stringify(record), ttl: 300 });
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('ScanDedupeManager — Resilience / Fault Injection', () => {
  let manager: ScanDedupeManager;

  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    manager = new ScanDedupeManager('redis://localhost:6379');
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  // ── 1. Redis Connection Failures ─────────────────────────────────

  describe('Redis connection failures', () => {
    it('propagates error when GET throws during checkAndClaim', async () => {
      redisMock.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(
        manager.checkAndClaim(CARD, IDEM, TENANT),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('propagates error when SET NX throws during claim', async () => {
      // GET returns null (no existing key) → then SET throws
      redisMock.get.mockResolvedValueOnce(null);
      redisMock.set.mockRejectedValueOnce(new Error('Redis write timeout'));

      await expect(
        manager.checkAndClaim(CARD, IDEM, TENANT),
      ).rejects.toThrow('Redis write timeout');
    });

    it('propagates error when DEL throws while clearing a failed record', async () => {
      seedRecord(CARD, IDEM, 'failed');
      redisMock.del.mockRejectedValueOnce(new Error('Redis DEL failed'));

      // GET returns the failed record → DEL throws
      await expect(
        manager.checkAndClaim(CARD, IDEM, TENANT),
      ).rejects.toThrow('Redis DEL failed');
    });

    it('propagates error when GET throws inside markCompleted', async () => {
      redisMock.get.mockRejectedValueOnce(new Error('ECONNRESET'));

      await expect(
        manager.markCompleted(CARD, IDEM, { id: 'po-001' }),
      ).rejects.toThrow('ECONNRESET');
    });

    it('propagates error when SET throws inside markFailed', async () => {
      // markFailed: GET succeeds → SET throws
      seedRecord(CARD, IDEM, 'pending');
      // First call is GET inside markFailed, let default impl run.
      // Then SET should throw.
      redisMock.set.mockRejectedValueOnce(new Error('Redis SET failed'));

      await expect(
        manager.markFailed(CARD, IDEM, 'something broke'),
      ).rejects.toThrow('Redis SET failed');
    });
  });

  // ── 2. Corrupted / Unparseable JSON ──────────────────────────────

  describe('corrupted stored records', () => {
    it('throws when GET returns non-JSON garbage', async () => {
      const key = buildRedisKey(CARD, IDEM);
      store.set(key, { value: '<<<NOT-JSON>>>', ttl: 300 });

      await expect(
        manager.checkAndClaim(CARD, IDEM, TENANT),
      ).rejects.toThrow(); // JSON.parse will throw SyntaxError
    });

    it('throws when stored record has truncated JSON', async () => {
      const key = buildRedisKey(CARD, IDEM);
      store.set(key, { value: '{"status":"comple', ttl: 300 });

      await expect(
        manager.checkAndClaim(CARD, IDEM, TENANT),
      ).rejects.toThrow();
    });

    it('throws when markCompleted encounters corrupted JSON', async () => {
      const key = buildRedisKey(CARD, IDEM);
      store.set(key, { value: 'CORRUPT', ttl: 30 });

      await expect(
        manager.markCompleted(CARD, IDEM, { ok: true }),
      ).rejects.toThrow();
    });
  });

  // ── 3. Race Conditions (SET NX fails between GET and SET) ────────

  describe('race conditions', () => {
    it('returns not-allowed when SET NX fails due to concurrent claimer', async () => {
      // GET returns null → another process claims → SET NX returns null
      redisMock.get
        .mockResolvedValueOnce(null) // first GET: no key
        .mockResolvedValueOnce(     // second GET after SET NX fails (race re-check)
          JSON.stringify({
            cardId: CARD,
            idempotencyKey: IDEM,
            tenantId: TENANT,
            status: 'pending',
            createdAt: new Date().toISOString(),
          }),
        );
      redisMock.set.mockResolvedValueOnce(null); // NX fails

      const result = await manager.checkAndClaim(CARD, IDEM, TENANT);

      expect(result.allowed).toBe(false);
      expect(result.existingStatus).toBe('pending');
      expect(result.wasReplay).toBe(false);
    });

    it('reports "unknown" status when race re-check GET also returns null', async () => {
      // GET → null, SET NX → null, re-check GET → null (TTL expired in between)
      redisMock.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      redisMock.set.mockResolvedValueOnce(null);

      const result = await manager.checkAndClaim(CARD, IDEM, TENANT);

      expect(result.allowed).toBe(false);
      expect(result.existingStatus).toBe('unknown');
    });

    it('returns completed status when race re-check finds completed record', async () => {
      redisMock.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          JSON.stringify({
            cardId: CARD,
            idempotencyKey: IDEM,
            tenantId: TENANT,
            status: 'completed',
            result: { poId: 'po-123' },
            createdAt: new Date().toISOString(),
          }),
        );
      redisMock.set.mockResolvedValueOnce(null);

      const result = await manager.checkAndClaim(CARD, IDEM, TENANT);

      expect(result.allowed).toBe(false);
      expect(result.existingStatus).toBe('completed');
    });
  });

  // ── 4. TTL Expiry During Multi-Step Operations ───────────────────

  describe('TTL expiry during operations', () => {
    it('markCompleted is a no-op when key has already expired', async () => {
      // No key in store → GET returns null → markCompleted early-returns
      const result = await manager.markCompleted(CARD, IDEM, { poId: 'po-001' });

      expect(result).toBeUndefined();
      // SET should not have been called because GET returned null
      expect(redisMock.set).not.toHaveBeenCalled();
    });

    it('markFailed is a no-op when key has already expired', async () => {
      const result = await manager.markFailed(CARD, IDEM, 'timeout');

      expect(result).toBeUndefined();
      expect(redisMock.set).not.toHaveBeenCalled();
    });

    it('checkAndClaim succeeds (fresh claim) after a previous pending key expired', async () => {
      // Simulate: pending key existed but TTL expired → GET returns null → fresh claim succeeds
      // store is empty (expired)
      const result = await manager.checkAndClaim(CARD, IDEM, TENANT);

      expect(result.allowed).toBe(true);
      expect(result.wasReplay).toBe(false);
    });
  });

  // ── 5. Concurrent Duplicate Claim Attempts ───────────────────────

  describe('concurrent duplicate claims', () => {
    it('second checkAndClaim returns not-allowed when pending key exists', async () => {
      // First claim succeeds
      const first = await manager.checkAndClaim(CARD, IDEM, TENANT);
      expect(first.allowed).toBe(true);

      // Second claim should see the pending record
      const second = await manager.checkAndClaim(CARD, IDEM, TENANT);
      expect(second.allowed).toBe(false);
      expect(second.existingStatus).toBe('pending');
    });

    it('returns cached result for completed key', async () => {
      seedRecord(CARD, IDEM, 'completed', { result: { poId: 'po-999' } });

      const result = await manager.checkAndClaim(CARD, IDEM, TENANT);

      expect(result.allowed).toBe(false);
      expect(result.existingStatus).toBe('completed');
      expect(result.wasReplay).toBe(true);
      expect(result.cachedResult).toEqual({ poId: 'po-999' });
    });

    it('allows retry after failed key is cleared', async () => {
      seedRecord(CARD, IDEM, 'failed', { error: 'DB timeout' });

      // checkAndClaim should delete the failed key and then claim
      const result = await manager.checkAndClaim(CARD, IDEM, TENANT);

      expect(redisMock.del).toHaveBeenCalledTimes(1);
      expect(result.allowed).toBe(true);
    });

    it('handles rapid sequential claims for different cards', async () => {
      const r1 = await manager.checkAndClaim('card-A', IDEM, TENANT);
      const r2 = await manager.checkAndClaim('card-B', IDEM, TENANT);
      const r3 = await manager.checkAndClaim('card-C', IDEM, TENANT);

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(true);
      expect(store.size).toBe(3);
    });
  });

  // ── 6. End-to-End Lifecycle Under Fault Conditions ───────────────

  describe('full lifecycle with faults', () => {
    it('claim → action failure → markFailed → retry → claim succeeds', async () => {
      // Step 1: claim
      const claim1 = await manager.checkAndClaim(CARD, IDEM, TENANT);
      expect(claim1.allowed).toBe(true);

      // Step 2: action fails → markFailed
      await manager.markFailed(CARD, IDEM, 'API 500');

      // Step 3: retry → should clear failed key and claim
      const claim2 = await manager.checkAndClaim(CARD, IDEM, TENANT);
      expect(claim2.allowed).toBe(true);

      // Step 4: action succeeds → markCompleted
      await manager.markCompleted(CARD, IDEM, { poId: 'po-final' });

      // Step 5: duplicate → returns cached
      const claim3 = await manager.checkAndClaim(CARD, IDEM, TENANT);
      expect(claim3.allowed).toBe(false);
      expect(claim3.wasReplay).toBe(true);
      expect(claim3.cachedResult).toEqual({ poId: 'po-final' });
    });

    it('claim → Redis dies during markCompleted → key left as pending → blocks retry', async () => {
      const claim = await manager.checkAndClaim(CARD, IDEM, TENANT);
      expect(claim.allowed).toBe(true);

      // markCompleted GET succeeds but SET throws
      redisMock.set.mockRejectedValueOnce(new Error('Redis down'));

      await expect(
        manager.markCompleted(CARD, IDEM, { poId: 'po-abc' }),
      ).rejects.toThrow('Redis down');

      // Key is still "pending" in store → next attempt is blocked
      const retry = await manager.checkAndClaim(CARD, IDEM, TENANT);
      expect(retry.allowed).toBe(false);
      expect(retry.existingStatus).toBe('pending');
    });

    it('claim → markFailed → Redis dies during retry claim → error propagated', async () => {
      const claim = await manager.checkAndClaim(CARD, IDEM, TENANT);
      expect(claim.allowed).toBe(true);

      await manager.markFailed(CARD, IDEM, 'bad input');

      // Next checkAndClaim: GET returns the failed record → DEL succeeds → SET throws
      redisMock.set.mockRejectedValueOnce(new Error('Redis READONLY'));

      await expect(
        manager.checkAndClaim(CARD, IDEM, TENANT),
      ).rejects.toThrow('Redis READONLY');
    });
  });
});
