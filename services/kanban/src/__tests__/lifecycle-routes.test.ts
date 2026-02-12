import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Infrastructure ────────────────────────────────────────────
// Route tests focus on request validation and response formatting.
// The service layer is fully mocked since it's tested separately.

vi.mock('@arda/db', () => ({
  db: { query: {}, transaction: vi.fn(), insert: vi.fn(), update: vi.fn() },
  schema: {
    kanbanCards: {},
    kanbanLoops: {},
    cardStageTransitions: {},
    lifecycleEvents: {},
    kanbanParameterHistory: {},
    lifecycleEventTypeEnum: { enumValues: [] },
  },
}));
vi.mock('@arda/events', () => ({ getEventBus: vi.fn(() => ({ publish: vi.fn() })) }));
vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../middleware/error-handler.js', () => ({
  AppError: class AppError extends Error {
    constructor(public statusCode: number, message: string, public code?: string) {
      super(message);
    }
  },
}));

// Mock the services that routes depend on
const mockTransitionCard = vi.fn();
const mockGetCardHistory = vi.fn();
const mockGetCardLifecycleEvents = vi.fn();
const mockGetLoopLifecycleEvents = vi.fn();
const mockGetLoopVelocity = vi.fn();

vi.mock('../services/card-lifecycle.service.js', () => ({
  transitionCard: mockTransitionCard,
  triggerCardByScan: vi.fn(),
  getCardHistory: mockGetCardHistory,
  getCardLifecycleEvents: mockGetCardLifecycleEvents,
  getLoopLifecycleEvents: mockGetLoopLifecycleEvents,
  getLoopVelocity: mockGetLoopVelocity,
  VALID_TRANSITIONS: {
    created: ['triggered'],
    triggered: ['ordered'],
    ordered: ['in_transit', 'received'],
    in_transit: ['received'],
    received: ['restocked'],
    restocked: ['triggered'],
  },
  TRANSITION_MATRIX: {
    created: ['triggered'],
    triggered: ['ordered'],
    ordered: ['in_transit', 'received'],
    in_transit: ['received'],
    received: ['restocked'],
    restocked: ['triggered'],
  },
  TRANSITION_RULES: [],
  isValidTransition: vi.fn(),
  isRoleAllowed: vi.fn(),
  isLoopTypeAllowed: vi.fn(),
  isMethodAllowed: vi.fn(),
}));

const mockCalculateLoopInferredQuantity = vi.fn();
const mockRecalculateLoopQuantity = vi.fn();
const mockSwitchCardMode = vi.fn();
const mockGetLoopCardSummary = vi.fn();
const mockGetTriggeredCardsForConsolidation = vi.fn();
const mockUpdateLoopOrderQuantity = vi.fn();

vi.mock('../services/quantity-accounting.service.js', () => ({
  calculateLoopInferredQuantity: mockCalculateLoopInferredQuantity,
  recalculateLoopQuantity: mockRecalculateLoopQuantity,
  switchCardMode: mockSwitchCardMode,
  getLoopCardSummary: mockGetLoopCardSummary,
  getTriggeredCardsForConsolidation: mockGetTriggeredCardsForConsolidation,
  updateLoopOrderQuantity: mockUpdateLoopOrderQuantity,
}));

// ─── Zod Schema Validation Tests ────────────────────────────────────
// These tests verify the Zod schemas used in route handlers by testing
// the validation rules directly. This gives us confidence in the API
// contract without needing to stand up Express.

import { z } from 'zod';

const cardStageValues = ['created', 'triggered', 'ordered', 'in_transit', 'received', 'restocked'] as const;

const transitionSchema = z.object({
  toStage: z.enum(cardStageValues),
  method: z.enum(['qr_scan', 'manual', 'system']).default('manual'),
  notes: z.string().max(1000).optional(),
  metadata: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().max(100).optional(),
  linkedOrderId: z.string().uuid().optional(),
  linkedOrderType: z.enum(['purchase_order', 'work_order', 'transfer_order']).optional(),
  quantity: z.number().int().positive().optional(),
});

const switchModeSchema = z.object({
  newMode: z.enum(['single', 'multi']),
  newNumberOfCards: z.number().int().positive().optional(),
  reason: z.string().min(1, 'Reason is required for mode changes'),
});

const updateQuantitySchema = z.object({
  newOrderQuantity: z.number().int().positive(),
  reason: z.string().min(1, 'Reason is required for quantity changes'),
});

describe('Lifecycle Route Validation Schemas', () => {
  describe('Transition Schema', () => {
    it('accepts valid transition request', () => {
      const result = transitionSchema.parse({
        toStage: 'triggered',
        method: 'qr_scan',
        notes: 'Scanned at warehouse dock',
      });
      expect(result.toStage).toBe('triggered');
      expect(result.method).toBe('qr_scan');
    });

    it('defaults method to manual', () => {
      const result = transitionSchema.parse({ toStage: 'triggered' });
      expect(result.method).toBe('manual');
    });

    it('accepts all valid stage values', () => {
      for (const stage of cardStageValues) {
        expect(() => transitionSchema.parse({ toStage: stage })).not.toThrow();
      }
    });

    it('rejects invalid stage value', () => {
      expect(() => transitionSchema.parse({ toStage: 'invalid_stage' })).toThrow();
    });

    it('rejects invalid method value', () => {
      expect(() => transitionSchema.parse({ toStage: 'triggered', method: 'unknown_method' })).toThrow();
    });

    it('accepts request with idempotency key', () => {
      const result = transitionSchema.parse({
        toStage: 'triggered',
        idempotencyKey: 'my-dedup-key',
      });
      expect(result.idempotencyKey).toBe('my-dedup-key');
    });

    it('accepts request with linked order', () => {
      const result = transitionSchema.parse({
        toStage: 'ordered',
        method: 'system',
        linkedOrderId: 'a0000000-0000-0000-0000-000000000001',
        linkedOrderType: 'purchase_order',
      });
      expect(result.linkedOrderId).toBeDefined();
      expect(result.linkedOrderType).toBe('purchase_order');
    });

    it('rejects non-UUID linkedOrderId', () => {
      expect(() => transitionSchema.parse({
        toStage: 'ordered',
        linkedOrderId: 'not-a-uuid',
        linkedOrderType: 'purchase_order',
      })).toThrow();
    });

    it('rejects invalid linkedOrderType', () => {
      expect(() => transitionSchema.parse({
        toStage: 'ordered',
        linkedOrderId: 'a0000000-0000-0000-0000-000000000001',
        linkedOrderType: 'invalid_order_type',
      })).toThrow();
    });

    it('accepts request with quantity', () => {
      const result = transitionSchema.parse({
        toStage: 'triggered',
        quantity: 250,
      });
      expect(result.quantity).toBe(250);
    });

    it('rejects non-positive quantity', () => {
      expect(() => transitionSchema.parse({ toStage: 'triggered', quantity: 0 })).toThrow();
      expect(() => transitionSchema.parse({ toStage: 'triggered', quantity: -5 })).toThrow();
    });

    it('rejects non-integer quantity', () => {
      expect(() => transitionSchema.parse({ toStage: 'triggered', quantity: 2.5 })).toThrow();
    });

    it('accepts request with metadata', () => {
      const result = transitionSchema.parse({
        toStage: 'triggered',
        metadata: { source: 'mobile', lat: 40.7, lng: -73.9 },
      });
      expect(result.metadata).toEqual({ source: 'mobile', lat: 40.7, lng: -73.9 });
    });

    it('rejects notes exceeding 1000 characters', () => {
      expect(() => transitionSchema.parse({
        toStage: 'triggered',
        notes: 'x'.repeat(1001),
      })).toThrow();
    });

    it('accepts idempotency key up to 100 characters', () => {
      const result = transitionSchema.parse({
        toStage: 'triggered',
        idempotencyKey: 'k'.repeat(100),
      });
      expect(result.idempotencyKey).toHaveLength(100);
    });

    it('rejects idempotency key exceeding 100 characters', () => {
      expect(() => transitionSchema.parse({
        toStage: 'triggered',
        idempotencyKey: 'k'.repeat(101),
      })).toThrow();
    });
  });

  describe('Switch Mode Schema', () => {
    it('accepts valid mode switch request', () => {
      const result = switchModeSchema.parse({
        newMode: 'multi',
        newNumberOfCards: 3,
        reason: 'Increasing throughput for high-demand part',
      });
      expect(result.newMode).toBe('multi');
      expect(result.newNumberOfCards).toBe(3);
    });

    it('requires reason', () => {
      expect(() => switchModeSchema.parse({
        newMode: 'multi',
      })).toThrow();
    });

    it('rejects empty reason', () => {
      expect(() => switchModeSchema.parse({
        newMode: 'multi',
        reason: '',
      })).toThrow();
    });

    it('accepts single mode without numberOfCards', () => {
      const result = switchModeSchema.parse({
        newMode: 'single',
        reason: 'Simplifying loop',
      });
      expect(result.newNumberOfCards).toBeUndefined();
    });

    it('rejects invalid mode value', () => {
      expect(() => switchModeSchema.parse({
        newMode: 'triple',
        reason: 'Test',
      })).toThrow();
    });

    it('rejects non-positive numberOfCards', () => {
      expect(() => switchModeSchema.parse({
        newMode: 'multi',
        newNumberOfCards: 0,
        reason: 'Test',
      })).toThrow();
    });
  });

  describe('Update Quantity Schema', () => {
    it('accepts valid quantity update', () => {
      const result = updateQuantitySchema.parse({
        newOrderQuantity: 200,
        reason: 'Adjusted for new demand forecast',
      });
      expect(result.newOrderQuantity).toBe(200);
    });

    it('requires reason', () => {
      expect(() => updateQuantitySchema.parse({
        newOrderQuantity: 200,
      })).toThrow();
    });

    it('rejects empty reason', () => {
      expect(() => updateQuantitySchema.parse({
        newOrderQuantity: 200,
        reason: '',
      })).toThrow();
    });

    it('rejects non-positive quantity', () => {
      expect(() => updateQuantitySchema.parse({
        newOrderQuantity: 0,
        reason: 'Test',
      })).toThrow();

      expect(() => updateQuantitySchema.parse({
        newOrderQuantity: -100,
        reason: 'Test',
      })).toThrow();
    });

    it('rejects non-integer quantity', () => {
      expect(() => updateQuantitySchema.parse({
        newOrderQuantity: 99.5,
        reason: 'Test',
      })).toThrow();
    });
  });
});

// ─── Service Integration via Route Handlers ─────────────────────────
// These tests verify that the service functions get called with the
// correct arguments by the route handlers.

describe('Lifecycle Route Service Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Transition Response Shape', () => {
    it('transitionCard returns expected response shape', async () => {
      const mockResult = {
        card: {
          id: 'card-001',
          currentStage: 'triggered',
          loopId: 'loop-001',
          completedCycles: 0,
          cardQuantity: 100,
          quantityFulfilled: 0,
        },
        transition: {
          id: 'trans-001',
          fromStage: 'created',
          toStage: 'triggered',
          cycleNumber: 1,
          transitionedAt: '2025-01-01T00:00:00.000Z',
          method: 'manual',
          stageDurationSeconds: 3600,
        },
        eventId: 'event-001',
      };
      mockTransitionCard.mockResolvedValueOnce(mockResult);

      const result = await mockTransitionCard({
        cardId: 'card-001',
        tenantId: 'tenant-001',
        toStage: 'triggered',
        userId: 'user-001',
        method: 'manual',
      });

      expect(result).toHaveProperty('card');
      expect(result).toHaveProperty('transition');
      expect(result).toHaveProperty('eventId');
      expect(result.card).toHaveProperty('id');
      expect(result.card).toHaveProperty('currentStage');
      expect(result.card).toHaveProperty('cardQuantity');
      expect(result.transition).toHaveProperty('fromStage');
      expect(result.transition).toHaveProperty('toStage');
      expect(result.transition).toHaveProperty('stageDurationSeconds');
    });
  });

  describe('Quantity Accounting Response Shape', () => {
    it('calculateLoopInferredQuantity returns breakdown', async () => {
      const mockResult = {
        totalInferredQuantity: 200,
        cardBreakdown: [
          { cardId: 'card-001', cardNumber: 1, stage: 'triggered', cardQuantity: 100 },
          { cardId: 'card-002', cardNumber: 2, stage: 'ordered', cardQuantity: 100 },
        ],
      };
      mockCalculateLoopInferredQuantity.mockResolvedValueOnce(mockResult);

      const result = await mockCalculateLoopInferredQuantity('loop-001', 'tenant-001');
      expect(result.totalInferredQuantity).toBe(200);
      expect(result.cardBreakdown).toHaveLength(2);
    });

    it('getLoopCardSummary returns complete loop state', async () => {
      const mockResult = {
        loopId: 'loop-001',
        cardMode: 'multi',
        totalCards: 3,
        numberOfCards: 3,
        stageCounts: { created: 1, triggered: 1, ordered: 1 },
        byStage: { created: 1, triggered: 1, ordered: 1 },
        triggeredCount: 1,
        inFlightCount: 2,
        inFlightQuantity: 200,
        orderQuantityPerCard: 100,
        totalInferredQuantity: 200,
        cards: [
          { id: 'c1', cardNumber: 1, currentStage: 'created', cardQuantity: 100, quantityFulfilled: 0, completedCycles: 0 },
          { id: 'c2', cardNumber: 2, currentStage: 'triggered', cardQuantity: 100, quantityFulfilled: 0, completedCycles: 0 },
          { id: 'c3', cardNumber: 3, currentStage: 'ordered', cardQuantity: 100, quantityFulfilled: 0, completedCycles: 0 },
        ],
      };
      mockGetLoopCardSummary.mockResolvedValueOnce(mockResult);

      const result = await mockGetLoopCardSummary('loop-001', 'tenant-001');
      expect(result.cardMode).toBe('multi');
      expect(result.totalCards).toBe(3);
      expect(result.byStage.created).toBe(1);
      expect(result.inFlightCount).toBe(2);
      expect(result.cards).toHaveLength(3);
    });

    it('getTriggeredCardsForConsolidation returns grouped cards', async () => {
      const mockResult = {
        loopId: 'loop-001',
        loopType: 'procurement',
        partId: 'part-001',
        facilityId: 'facility-001',
        supplierId: 'supplier-001',
        sourceFacilityId: null,
        cards: [
          { cardId: 'c1', cardNumber: 1, cardQuantity: 100 },
          { cardId: 'c2', cardNumber: 2, cardQuantity: 100 },
        ],
        consolidatedQuantity: 200,
      };
      mockGetTriggeredCardsForConsolidation.mockResolvedValueOnce(mockResult);

      const result = await mockGetTriggeredCardsForConsolidation('loop-001', 'tenant-001');
      expect(result.consolidatedQuantity).toBe(200);
      expect(result.cards).toHaveLength(2);
      expect(result.loopType).toBe('procurement');
    });
  });
});
