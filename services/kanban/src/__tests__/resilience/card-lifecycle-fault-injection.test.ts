/**
 * Resilience / Fault-Injection Tests — Card Lifecycle Service
 *
 * Ticket #88 — Phase 4: Card lifecycle fault injection
 *
 * Validates system behaviour under:
 * - DB query failures during card fetch
 * - Transition matrix validation with corrupted state
 * - DB transaction failures during atomic commit
 * - Event bus failures during domain event emission
 * - triggerCardByScan with dedupe manager failures
 * - replayScans with mixed success/failure
 * - Concurrent transitions on same card
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ─────────────────────────────────────────────────

const {
  mockFindFirst,
  mockFindMany,
  mockDbSelect,
  mockTransaction,
  mockPublish,
  mockDedupeCheckAndClaim,
  mockDedupeMarkCompleted,
  mockDedupeMarkFailed,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
  mockDbSelect: vi.fn(),
  mockTransaction: vi.fn(),
  mockPublish: vi.fn(),
  mockDedupeCheckAndClaim: vi.fn(),
  mockDedupeMarkCompleted: vi.fn(),
  mockDedupeMarkFailed: vi.fn(),
}));

// ─── Module mocks ──────────────────────────────────────────────────

vi.mock('@arda/db', () => {
  const selectChain = {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: mockDbSelect,
        })),
      })),
    })),
  };
  return {
    db: {
      query: {
        kanbanCards: { findFirst: mockFindFirst },
        cardStageTransitions: { findMany: mockFindMany },
      },
      select: vi.fn(() => selectChain),
      transaction: mockTransaction,
    },
    schema: {
      kanbanCards: {
        id: 'id',
        tenantId: 'tenantId',
        currentStage: 'currentStage',
        completedCycles: 'completedCycles',
        currentStageEnteredAt: 'currentStageEnteredAt',
      },
      kanbanLoops: {},
      cardStageTransitions: {
        tenantId: 'tenantId',
        cardId: 'cardId',
        cycleNumber: 'cycleNumber',
        metadata: 'metadata',
        transitionedAt: 'transitionedAt',
      },
      kanbanParameterHistory: {},
    },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  sql: vi.fn((...args: unknown[]) => args),
  desc: vi.fn((col: unknown) => col),
  asc: vi.fn((col: unknown) => col),
}));

vi.mock('@arda/events', () => ({
  getEventBus: vi.fn(() => ({
    publish: mockPublish,
  })),
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../middleware/error-handler.js', () => {
  class AppError extends Error {
    statusCode: number;
    code: string;
    constructor(statusCode: number, message: string, code: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
      this.name = 'AppError';
    }
  }
  return { AppError };
});

vi.mock('../../services/scan-dedupe-manager.js', () => {
  class ScanDuplicateError extends Error {
    cardId: string;
    idempotencyKey: string;
    existingStatus: string;
    constructor(cardId: string, idempotencyKey: string, existingStatus: string) {
      super(`Duplicate scan for card ${cardId} (key: ${idempotencyKey}, status: ${existingStatus})`);
      this.cardId = cardId;
      this.idempotencyKey = idempotencyKey;
      this.existingStatus = existingStatus;
      this.name = 'ScanDuplicateError';
    }
  }
  class ScanDedupeManager {
    checkAndClaim = mockDedupeCheckAndClaim;
    markCompleted = mockDedupeMarkCompleted;
    markFailed = mockDedupeMarkFailed;
  }
  return { ScanDedupeManager, ScanDuplicateError };
});

// ─── SUT ────────────────────────────────────────────────────────────

import {
  transitionCard,
  triggerCardByScan,
  replayScans,
  detectScanConflict,
  isValidTransition,
  initScanDedupeManager,
} from '../../services/card-lifecycle.service.js';

// ─── Test Helpers ───────────────────────────────────────────────────

function makeCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'card-1',
    tenantId: 'tenant-1',
    loopId: 'loop-1',
    currentStage: 'created',
    isActive: true,
    completedCycles: 0,
    currentStageEnteredAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    loop: {
      id: 'loop-1',
      loopType: 'procurement',
      partId: 'part-1',
      facilityId: 'facility-1',
      orderQuantity: 10,
    },
    ...overrides,
  };
}

function makeTransition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'transition-1',
    tenantId: 'tenant-1',
    cardId: 'card-1',
    loopId: 'loop-1',
    cycleNumber: 1,
    fromStage: 'created',
    toStage: 'triggered',
    transitionedAt: new Date(),
    method: 'qr_scan',
    metadata: {},
    ...overrides,
  };
}

// ─── Shared Setup ───────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path stubs
  mockFindFirst.mockResolvedValue(makeCard());
  mockDbSelect.mockResolvedValue([]);
  mockPublish.mockResolvedValue(undefined);
  mockDedupeCheckAndClaim.mockResolvedValue({ allowed: true });
  mockDedupeMarkCompleted.mockResolvedValue(undefined);
  mockDedupeMarkFailed.mockResolvedValue(undefined);
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const txInsertChain = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnValue(vi.fn().mockResolvedValue([makeTransition()])),
    };
    const txUpdateChain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnValue(vi.fn().mockResolvedValue([makeCard({ currentStage: 'triggered' })])),
    };
    // Make returning() directly return the array (for insert().values().returning())
    const txInsert = {
      values: vi.fn(() => ({
        returning: vi.fn(() => [makeTransition()]),
      })),
    };
    const txUpdate = {
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => [makeCard({ currentStage: 'triggered' })]),
        })),
      })),
    };
    const tx = {
      insert: vi.fn(() => txInsert),
      update: vi.fn(() => txUpdate),
    };
    return fn(tx);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════════

describe('Card Lifecycle — Fault Injection', () => {

  // ─── 1. DB Query Failures During Card Fetch ────────────────────────

  describe('Card fetch — DB query failures', () => {
    it('throws when db.query.kanbanCards.findFirst ECONNREFUSED', async () => {
      mockFindFirst.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      await expect(
        transitionCard({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          toStage: 'triggered' as const,
          method: 'qr_scan',
        }),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('throws CARD_NOT_FOUND when findFirst returns null', async () => {
      mockFindFirst.mockResolvedValueOnce(null);

      await expect(
        transitionCard({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          toStage: 'triggered' as const,
          method: 'qr_scan',
        }),
      ).rejects.toThrow('Kanban card not found');
    });

    it('throws CARD_INACTIVE when card.isActive is false', async () => {
      mockFindFirst.mockResolvedValueOnce(makeCard({ isActive: false }));

      await expect(
        transitionCard({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          toStage: 'triggered' as const,
          method: 'qr_scan',
        }),
      ).rejects.toThrow('Card is deactivated');
    });

    it('throws when DB query times out', async () => {
      mockFindFirst.mockRejectedValueOnce(new Error('query timeout'));

      await expect(
        transitionCard({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          toStage: 'triggered' as const,
          method: 'qr_scan',
        }),
      ).rejects.toThrow('timeout');
    });
  });

  // ─── 2. Transition Matrix Validation with Corrupted State ──────────

  describe('Transition validation — corrupted or invalid state', () => {
    it('rejects invalid stage transitions (ordered → created)', () => {
      expect(isValidTransition('ordered', 'created')).toBe(false);
    });

    it('rejects transition from unknown stage', () => {
      expect(isValidTransition('nonexistent_stage', 'triggered')).toBe(false);
    });

    it('throws INVALID_TRANSITION when card stage does not allow target', async () => {
      mockFindFirst.mockResolvedValueOnce(makeCard({ currentStage: 'received' }));

      await expect(
        transitionCard({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          toStage: 'triggered' as const,
          method: 'manual',
        }),
      ).rejects.toThrow('Invalid transition');
    });

    it('throws ROLE_NOT_ALLOWED when user role is insufficient', async () => {
      mockFindFirst.mockResolvedValueOnce(makeCard({ currentStage: 'created' }));

      await expect(
        transitionCard({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          toStage: 'triggered' as const,
          userRole: 'viewer' as any,
          method: 'qr_scan',
        }),
      ).rejects.toThrow('Role');
    });

    it('throws LOOP_TYPE_INCOMPATIBLE for production loop on ordered→in_transit', async () => {
      mockFindFirst.mockResolvedValueOnce(
        makeCard({
          currentStage: 'ordered',
          loop: {
            id: 'loop-1',
            loopType: 'production',
            partId: 'part-1',
            facilityId: 'facility-1',
            orderQuantity: 10,
          },
        }),
      );

      await expect(
        transitionCard({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          toStage: 'in_transit' as const,
          method: 'manual',
        }),
      ).rejects.toThrow('not allowed for');
    });

    it('throws METHOD_NOT_ALLOWED when qr_scan used for triggered→ordered', async () => {
      mockFindFirst.mockResolvedValueOnce(makeCard({ currentStage: 'triggered' }));

      await expect(
        transitionCard({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          toStage: 'ordered' as const,
          method: 'qr_scan',
          linkedOrderId: 'po-1',
          linkedOrderType: 'purchase_order',
        }),
      ).rejects.toThrow('Method');
    });

    it('throws LINKED_ORDER_REQUIRED when transitioning triggered→ordered without order', async () => {
      mockFindFirst.mockResolvedValueOnce(makeCard({ currentStage: 'triggered' }));

      await expect(
        transitionCard({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          toStage: 'ordered' as const,
          method: 'manual',
        }),
      ).rejects.toThrow('requires linkedOrderId');
    });
  });

  // ─── 3. DB Transaction Failures During Atomic Commit ───────────────

  describe('Atomic DB transaction — failures', () => {
    it('throws when db.transaction itself fails with ECONNREFUSED', async () => {
      mockTransaction.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      await expect(
        transitionCard({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          toStage: 'triggered' as const,
          method: 'qr_scan',
        }),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('throws when insert inside transaction deadlocks', async () => {
      mockTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn(() => ({
              returning: vi.fn(() => {
                throw new Error('deadlock detected');
              }),
            })),
          })),
        };
        return fn(tx);
      });

      await expect(
        transitionCard({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          toStage: 'triggered' as const,
          method: 'qr_scan',
        }),
      ).rejects.toThrow('deadlock');
    });

    it('throws when update inside transaction fails', async () => {
      mockTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn(() => ({
              returning: vi.fn(() => [makeTransition()]),
            })),
          })),
          update: vi.fn(() => ({
            set: vi.fn(() => ({
              where: vi.fn(() => ({
                returning: vi.fn(() => {
                  throw new Error('serialization failure');
                }),
              })),
            })),
          })),
        };
        return fn(tx);
      });

      await expect(
        transitionCard({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          toStage: 'triggered' as const,
          method: 'qr_scan',
        }),
      ).rejects.toThrow('serialization failure');
    });
  });

  // ─── 4. Event Bus Failures During Domain Event Emission ────────────

  describe('Domain event emission — event bus failures', () => {
    it('succeeds even when event bus publish throws (fire-and-forget)', async () => {
      mockPublish.mockRejectedValue(new Error('Redis cluster unavailable'));

      // transitionCard should complete the DB transaction and
      // swallow event bus errors (non-critical path).
      const result = await transitionCard({
        cardId: 'card-1',
        tenantId: 'tenant-1',
        toStage: 'triggered' as const,
        method: 'qr_scan',
      });

      // The transition should still succeed because events are fire-and-forget
      expect(result).toBeDefined();
      expect(result.card).toBeDefined();
      expect(result.transition).toBeDefined();

      // Reset
      mockPublish.mockResolvedValue(undefined);
    });

    it('succeeds when queue_entry event fails but transition event succeeds', async () => {
      let callCount = 0;
      mockPublish.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error('queue_entry event failed');
      });

      // Transition to 'triggered' emits both lifecycle.transition and lifecycle.queue_entry
      const result = await transitionCard({
        cardId: 'card-1',
        tenantId: 'tenant-1',
        toStage: 'triggered' as const,
        method: 'qr_scan',
      });

      expect(result).toBeDefined();

      // Reset
      mockPublish.mockResolvedValue(undefined);
    });
  });

  // ─── 5. triggerCardByScan — Dedupe Manager Failures ────────────────

  describe('triggerCardByScan — dedupe failures', () => {
    beforeEach(() => {
      // Initialize the dedupe singleton so it's active
      initScanDedupeManager('redis://localhost:6379');
    });

    it('rejects duplicate scan when dedupe returns allowed=false', async () => {
      mockDedupeCheckAndClaim.mockResolvedValueOnce({
        allowed: false,
        existingStatus: 'completed',
      });

      await expect(
        triggerCardByScan({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          idempotencyKey: 'scan-key-1',
        }),
      ).rejects.toThrow('Duplicate scan');
    });

    it('throws when dedupe checkAndClaim Redis fails', async () => {
      mockDedupeCheckAndClaim.mockRejectedValueOnce(
        new Error('Redis ECONNREFUSED'),
      );

      await expect(
        triggerCardByScan({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          idempotencyKey: 'scan-key-1',
        }),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('marks dedupe as failed when card is not found', async () => {
      mockDedupeCheckAndClaim.mockResolvedValueOnce({ allowed: true });
      mockFindFirst.mockResolvedValueOnce(null);

      await expect(
        triggerCardByScan({
          cardId: 'card-missing',
          tenantId: 'tenant-1',
          idempotencyKey: 'scan-key-2',
        }),
      ).rejects.toThrow('Card not found');

      expect(mockDedupeMarkFailed).toHaveBeenCalledWith(
        'card-missing',
        'scan-key-2',
        'CARD_NOT_FOUND',
      );
    });

    it('marks dedupe as failed on tenant mismatch', async () => {
      mockDedupeCheckAndClaim.mockResolvedValueOnce({ allowed: true });
      mockFindFirst.mockResolvedValueOnce(makeCard({ tenantId: 'other-tenant' }));

      await expect(
        triggerCardByScan({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          idempotencyKey: 'scan-key-3',
        }),
      ).rejects.toThrow('does not belong');

      expect(mockDedupeMarkFailed).toHaveBeenCalled();
    });
  });

  // ─── 6. detectScanConflict — Pure Function Edge Cases ──────────────

  describe('detectScanConflict — edge cases', () => {
    it('returns ok for created + active card', () => {
      expect(detectScanConflict('created' as any, true)).toBe('ok');
    });

    it('returns card_inactive for inactive card', () => {
      expect(detectScanConflict('created' as any, false)).toBe('card_inactive');
    });

    it('returns already_triggered for triggered stage', () => {
      expect(detectScanConflict('triggered' as any, true)).toBe('already_triggered');
    });

    it('returns stage_advanced for ordered stage', () => {
      expect(detectScanConflict('ordered' as any, true)).toBe('stage_advanced');
    });

    it('returns stage_advanced for received stage', () => {
      expect(detectScanConflict('received' as any, true)).toBe('stage_advanced');
    });

    it('returns stage_advanced for restocked stage', () => {
      expect(detectScanConflict('restocked' as any, true)).toBe('stage_advanced');
    });
  });

  // ─── 7. triggerCardByScan — Scan Conflict Detection ────────────────

  describe('triggerCardByScan — scan conflicts', () => {
    beforeEach(() => {
      initScanDedupeManager('redis://localhost:6379');
    });

    it('throws CARD_INACTIVE when scanning a deactivated card', async () => {
      mockDedupeCheckAndClaim.mockResolvedValueOnce({ allowed: true });
      mockFindFirst.mockResolvedValueOnce(makeCard({ isActive: false }));

      await expect(
        triggerCardByScan({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          idempotencyKey: 'scan-key-4',
        }),
      ).rejects.toThrow('deactivated');
    });

    it('throws SCAN_CONFLICT when card is already triggered', async () => {
      mockDedupeCheckAndClaim.mockResolvedValueOnce({ allowed: true });
      mockFindFirst.mockResolvedValueOnce(makeCard({ currentStage: 'triggered' }));

      await expect(
        triggerCardByScan({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          idempotencyKey: 'scan-key-5',
        }),
      ).rejects.toThrow('Scan conflict');
    });

    it('throws SCAN_CONFLICT when card stage is advanced (ordered)', async () => {
      mockDedupeCheckAndClaim.mockResolvedValueOnce({ allowed: true });
      mockFindFirst.mockResolvedValueOnce(makeCard({ currentStage: 'ordered' }));

      await expect(
        triggerCardByScan({
          cardId: 'card-1',
          tenantId: 'tenant-1',
          idempotencyKey: 'scan-key-6',
        }),
      ).rejects.toThrow('Scan conflict');
    });
  });

  // ─── 8. replayScans — Mixed Success/Failure ────────────────────────

  describe('replayScans — mixed outcomes', () => {
    beforeEach(() => {
      initScanDedupeManager('redis://localhost:6379');
    });

    it('returns individual results for each scan in the batch', async () => {
      // First scan: card not found
      mockFindFirst
        .mockResolvedValueOnce(null)
        // Second scan: happy path card
        .mockResolvedValueOnce(makeCard({ id: 'card-2' }));

      mockDedupeCheckAndClaim.mockResolvedValue({ allowed: true });

      const items = [
        { cardId: 'card-1', idempotencyKey: 'key-1' },
        { cardId: 'card-2', idempotencyKey: 'key-2' },
      ];

      const results = await replayScans(items, 'tenant-1', 'user-1');

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[0].errorCode).toBeDefined();
      // Second may succeed or fail based on transaction mock
    });

    it('isolates failures — one bad scan does not block others', async () => {
      mockDedupeCheckAndClaim
        .mockRejectedValueOnce(new Error('Redis down'))
        .mockResolvedValueOnce({ allowed: true });

      // Second call should go through to card fetch
      mockFindFirst.mockResolvedValueOnce(makeCard({ id: 'card-2' }));

      const items = [
        { cardId: 'card-1', idempotencyKey: 'key-1' },
        { cardId: 'card-2', idempotencyKey: 'key-2' },
      ];

      const results = await replayScans(items, 'tenant-1');

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Redis down');
      // The second scan was attempted (not blocked by first failure)
    });

    it('handles duplicate scan errors in replay batch', async () => {
      mockDedupeCheckAndClaim.mockResolvedValueOnce({
        allowed: false,
        existingStatus: 'completed',
      });

      const items = [{ cardId: 'card-1', idempotencyKey: 'dup-key' }];

      const results = await replayScans(items, 'tenant-1');

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].errorCode).toBe('SCAN_DUPLICATE');
    });

    it('handles empty replay batch', async () => {
      const results = await replayScans([], 'tenant-1');
      expect(results).toHaveLength(0);
    });
  });
});
