/**
 * Tests for ScanDedupeManager — Redis-backed deduplication for card scans.
 *
 * These tests mock ioredis to validate the SET NX claim logic,
 * TTL-based caching, and failure/retry semantics without requiring
 * a running Redis instance.
 */

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

// Mock infrastructure modules before any imports that trigger config validation
vi.mock('@arda/config', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  config: { REDIS_URL: 'redis://localhost:6379' },
}));

vi.mock('ioredis', () => {
  // Use a regular function so it can be called with `new`
  function MockRedis() {
    return redisMock;
  }
  return { Redis: MockRedis };
});

import { ScanDedupeManager, ScanDuplicateError } from '../services/scan-dedupe-manager.js';

// ─── Tests ─────────────────────────────────────────────────────────────

describe('ScanDedupeManager', () => {
  let manager: ScanDedupeManager;

  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    manager = new ScanDedupeManager('redis://localhost:6379');
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  describe('checkAndClaim', () => {
    it('should allow first scan for a card+key combination', async () => {
      const result = await manager.checkAndClaim('card-1', 'key-1', 'tenant-1');

      expect(result.allowed).toBe(true);
      expect(result.wasReplay).toBe(false);
      expect(redisMock.set).toHaveBeenCalledWith(
        expect.stringContaining('card-1:key-1'),
        expect.any(String),
        'EX',
        30, // PENDING_TTL
        'NX',
      );
    });

    it('should return cached result for completed scans', async () => {
      const cachedData = { card: { id: 'card-1' }, message: 'triggered' };
      const record = {
        cardId: 'card-1',
        idempotencyKey: 'key-1',
        tenantId: 'tenant-1',
        status: 'completed',
        result: cachedData,
        createdAt: new Date().toISOString(),
      };

      store.set('arda:scan:dedupe:card-1:key-1', {
        value: JSON.stringify(record),
        ttl: 300,
      });

      const result = await manager.checkAndClaim('card-1', 'key-1', 'tenant-1');

      expect(result.allowed).toBe(false);
      expect(result.existingStatus).toBe('completed');
      expect(result.cachedResult).toEqual(cachedData);
      expect(result.wasReplay).toBe(true);
    });

    it('should reject duplicate in-progress scans', async () => {
      const record = {
        cardId: 'card-1',
        idempotencyKey: 'key-1',
        tenantId: 'tenant-1',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      store.set('arda:scan:dedupe:card-1:key-1', {
        value: JSON.stringify(record),
        ttl: 30,
      });

      const result = await manager.checkAndClaim('card-1', 'key-1', 'tenant-1');

      expect(result.allowed).toBe(false);
      expect(result.existingStatus).toBe('pending');
      expect(result.wasReplay).toBe(false);
    });

    it('should allow retry after a failed scan', async () => {
      const record = {
        cardId: 'card-1',
        idempotencyKey: 'key-1',
        tenantId: 'tenant-1',
        status: 'failed',
        error: 'some error',
        createdAt: new Date().toISOString(),
      };

      store.set('arda:scan:dedupe:card-1:key-1', {
        value: JSON.stringify(record),
        ttl: 10,
      });

      const result = await manager.checkAndClaim('card-1', 'key-1', 'tenant-1');

      expect(result.allowed).toBe(true);
      expect(redisMock.del).toHaveBeenCalledWith(expect.stringContaining('card-1:key-1'));
    });
  });

  describe('markCompleted', () => {
    it('should update status to completed with result', async () => {
      const pending = {
        cardId: 'card-1',
        idempotencyKey: 'key-1',
        tenantId: 'tenant-1',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      store.set('arda:scan:dedupe:card-1:key-1', {
        value: JSON.stringify(pending),
        ttl: 30,
      });

      await manager.markCompleted('card-1', 'key-1', { success: true });

      const stored = store.get('arda:scan:dedupe:card-1:key-1');
      expect(stored).toBeDefined();
      const record = JSON.parse(stored!.value);
      expect(record.status).toBe('completed');
      expect(record.result).toEqual({ success: true });
    });

    it('should no-op if key does not exist', async () => {
      await manager.markCompleted('missing', 'key', { x: 1 });
      // Should not throw
      expect(redisMock.get).toHaveBeenCalled();
    });
  });

  describe('markFailed', () => {
    it('should update status to failed with error message', async () => {
      const pending = {
        cardId: 'card-1',
        idempotencyKey: 'key-1',
        tenantId: 'tenant-1',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };

      store.set('arda:scan:dedupe:card-1:key-1', {
        value: JSON.stringify(pending),
        ttl: 30,
      });

      await manager.markFailed('card-1', 'key-1', 'timeout');

      const stored = store.get('arda:scan:dedupe:card-1:key-1');
      expect(stored).toBeDefined();
      const record = JSON.parse(stored!.value);
      expect(record.status).toBe('failed');
      expect(record.error).toBe('timeout');
    });
  });
});

describe('ScanDuplicateError', () => {
  it('should include card ID and idempotency key in message', () => {
    const err = new ScanDuplicateError('card-1', 'key-1', 'pending');

    expect(err.name).toBe('ScanDuplicateError');
    expect(err.message).toContain('card-1');
    expect(err.message).toContain('key-1');
    expect(err.cardId).toBe('card-1');
    expect(err.idempotencyKey).toBe('key-1');
    expect(err.existingStatus).toBe('pending');
  });
});
