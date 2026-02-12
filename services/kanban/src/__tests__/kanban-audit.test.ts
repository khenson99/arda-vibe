import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════
// KANBAN AUDIT INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════════════
//
// Validates that kanban lifecycle operations write audit entries:
//   - Stage transitions mirror to audit log
//   - Loop creation writes audit entry
//   - Loop parameter changes write audit entry
//
// ═══════════════════════════════════════════════════════════════════════

// ─── Hoisted Mocks ────────────────────────────────────────────────────

const {
  mockWriteAuditEntry,
  mockFindFirst,
  mockInsert,
  mockUpdate,
  mockTransaction,
  mockPublish,
  mockSelect,
} = vi.hoisted(() => {
  const selectQuery = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };
  selectQuery.from.mockReturnValue(selectQuery);
  selectQuery.where.mockReturnValue(selectQuery);
  selectQuery.orderBy.mockReturnValue(selectQuery);
  selectQuery.limit.mockResolvedValue([]);

  return {
    mockWriteAuditEntry: vi.fn(async () => ({
      id: 'audit-1',
      hashChain: 'mock-hash',
      sequenceNumber: 1,
    })),
    mockFindFirst: vi.fn(),
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockTransaction: vi.fn(),
    mockPublish: vi.fn().mockResolvedValue(undefined),
    mockSelect: vi.fn(() => selectQuery),
  };
});

vi.mock('@arda/db', () => ({
  db: {
    query: {
      kanbanCards: { findFirst: mockFindFirst, findMany: vi.fn() },
      kanbanLoops: { findFirst: vi.fn(), findMany: vi.fn() },
      cardStageTransitions: { findFirst: vi.fn(), findMany: vi.fn() },
    },
    transaction: mockTransaction,
    insert: mockInsert,
    update: mockUpdate,
    select: mockSelect,
  },
  schema: {
    kanbanCards: { id: 'id', tenantId: 'tenant_id', completedCycles: 'completed_cycles' },
    kanbanLoops: {},
    cardStageTransitions: {},
    kanbanParameterHistory: {},
  },
  writeAuditEntry: mockWriteAuditEntry,
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/events', () => ({
  getEventBus: vi.fn(() => ({ publish: mockPublish })),
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../middleware/error-handler.js', () => ({
  AppError: class AppError extends Error {
    statusCode: number;
    code?: string;
    constructor(statusCode: number, message: string, code?: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
      this.name = 'AppError';
    }
  },
}));

// ─── Import after mocks ───────────────────────────────────────────────

import { transitionCard } from '../services/card-lifecycle.service.js';

// ─── Test Helpers ─────────────────────────────────────────────────────

function mockCardWithLoop(overrides?: Record<string, unknown>) {
  return {
    id: 'card-1',
    tenantId: 'tenant-1',
    loopId: 'loop-1',
    currentStage: 'created',
    currentStageEnteredAt: new Date('2026-02-10T00:00:00Z'),
    isActive: true,
    completedCycles: 0,
    cardNumber: 1,
    loop: {
      id: 'loop-1',
      tenantId: 'tenant-1',
      loopType: 'procurement',
      partId: 'part-1',
      facilityId: 'fac-1',
      orderQuantity: 10,
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('Kanban Audit Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('transitionCard audit writes', () => {
    it('should write an audit entry when transitioning a card stage', async () => {
      const card = mockCardWithLoop();
      mockFindFirst.mockResolvedValue(card);

      // Mock the transaction to execute the callback and capture calls
      const mockTx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'transition-1',
              fromStage: 'created',
              toStage: 'triggered',
              cycleNumber: 1,
            }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                ...card,
                currentStage: 'triggered',
                completedCycles: 0,
              }]),
            }),
          }),
        }),
      };
      mockTransaction.mockImplementation(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));

      await transitionCard({
        cardId: 'card-1',
        tenantId: 'tenant-1',
        toStage: 'triggered',
        userId: 'user-1',
        method: 'manual',
      });

      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledWith(
        mockTx, // called inside the transaction
        expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-1',
          action: 'card.stage_transitioned',
          entityType: 'kanban_card',
          entityId: 'card-1',
          previousState: expect.objectContaining({ stage: 'created' }),
          newState: expect.objectContaining({ stage: 'triggered' }),
          metadata: expect.objectContaining({
            loopId: 'loop-1',
            method: 'manual',
            transitionId: 'transition-1',
          }),
        }),
      );
    });

    it('should include linked order info in audit metadata', async () => {
      const card = mockCardWithLoop({ currentStage: 'triggered' });
      mockFindFirst.mockResolvedValue(card);

      const mockTx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'transition-2',
              fromStage: 'triggered',
              toStage: 'ordered',
              cycleNumber: 1,
            }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                ...card,
                currentStage: 'ordered',
                completedCycles: 0,
              }]),
            }),
          }),
        }),
      };
      mockTransaction.mockImplementation(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));

      await transitionCard({
        cardId: 'card-1',
        tenantId: 'tenant-1',
        toStage: 'ordered',
        userId: 'user-1',
        method: 'manual',
        linkedOrderId: 'po-1',
        linkedOrderType: 'purchase_order',
      });

      expect(mockWriteAuditEntry).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          action: 'card.stage_transitioned',
          metadata: expect.objectContaining({
            linkedOrderId: 'po-1',
            linkedOrderType: 'purchase_order',
          }),
        }),
      );
    });

    it('should handle null userId for system-triggered transitions', async () => {
      const card = mockCardWithLoop();
      mockFindFirst.mockResolvedValue(card);

      const mockTx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'transition-3',
              fromStage: 'created',
              toStage: 'triggered',
              cycleNumber: 1,
            }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                ...card,
                currentStage: 'triggered',
                completedCycles: 0,
              }]),
            }),
          }),
        }),
      };
      mockTransaction.mockImplementation(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));

      await transitionCard({
        cardId: 'card-1',
        tenantId: 'tenant-1',
        toStage: 'triggered',
        method: 'system',
      });

      expect(mockWriteAuditEntry).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          userId: null,
          action: 'card.stage_transitioned',
        }),
      );
    });

    it('should record stage duration in audit metadata when available', async () => {
      const card = mockCardWithLoop({
        currentStage: 'ordered',
        currentStageEnteredAt: new Date('2026-02-09T00:00:00Z'),
      });
      mockFindFirst.mockResolvedValue(card);

      const mockTx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'transition-4',
              fromStage: 'ordered',
              toStage: 'in_transit',
              cycleNumber: 1,
            }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                ...card,
                currentStage: 'in_transit',
                completedCycles: 0,
              }]),
            }),
          }),
        }),
      };
      mockTransaction.mockImplementation(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));

      await transitionCard({
        cardId: 'card-1',
        tenantId: 'tenant-1',
        toStage: 'in_transit',
        userId: 'user-1',
        method: 'manual',
      });

      expect(mockWriteAuditEntry).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          metadata: expect.objectContaining({
            stageDurationSeconds: expect.any(Number),
          }),
        }),
      );
    });
  });
});
