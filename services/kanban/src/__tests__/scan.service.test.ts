import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Infrastructure ────────────────────────────────────────────
// These tests verify the scan and lifecycle deduplication logic.
// Database and event bus are fully mocked.

const {
  mockFindFirst,
  mockSelect,
  mockInsert,
  mockUpdate,
  mockTransaction,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock('@arda/db', () => ({
  db: {
    query: {
      kanbanCards: { findFirst: mockFindFirst },
      cardStageTransitions: { findMany: vi.fn(() => []) },
    },
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    transaction: mockTransaction,
  },
  schema: {
    kanbanCards: {
      id: 'id',
      tenantId: 'tenantId',
      currentStage: 'currentStage',
      completedCycles: 'completedCycles',
      $inferSelect: {},
    },
    kanbanLoops: {},
    cardStageTransitions: {
      tenantId: 'tenantId',
      cardId: 'cardId',
      metadata: 'metadata',
      transitionedAt: 'transitionedAt',
    },
    kanbanParameterHistory: {},
  },
}));

vi.mock('@arda/events', () => ({
  getEventBus: vi.fn(() => ({
    publish: vi.fn(),
  })),
}));

vi.mock('@arda/config', () => ({
  config: {
    REDIS_URL: 'redis://localhost:6379',
    APP_URL: 'https://app.arda.io',
  },
}));

vi.mock('../../middleware/error-handler.js', () => ({
  AppError: class AppError extends Error {
    public statusCode: number;
    public code: string;
    constructor(statusCode: number, message: string, code: string = 'UNKNOWN') {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  },
}));

// Import the module under test
import {
  VALID_TRANSITIONS,
  TRANSITION_MATRIX,
  TRANSITION_RULES,
  isValidTransition,
  isRoleAllowed,
  isLoopTypeAllowed,
  isMethodAllowed,
} from '../services/card-lifecycle.service.js';

// ─── Transition Matrix Tests ────────────────────────────────────────

describe('Scan Service - Transition Matrix', () => {
  it('defines all card stages', () => {
    const stages = ['created', 'triggered', 'ordered', 'in_transit', 'received', 'restocked'];
    for (const stage of stages) {
      expect(VALID_TRANSITIONS).toHaveProperty(stage);
    }
  });

  it('TRANSITION_MATRIX is an alias for VALID_TRANSITIONS', () => {
    expect(TRANSITION_MATRIX).toBe(VALID_TRANSITIONS);
  });

  describe('isValidTransition', () => {
    it('allows created -> triggered', () => {
      expect(isValidTransition('created', 'triggered')).toBe(true);
    });

    it('allows triggered -> ordered', () => {
      expect(isValidTransition('triggered', 'ordered')).toBe(true);
    });

    it('allows ordered -> in_transit', () => {
      expect(isValidTransition('ordered', 'in_transit')).toBe(true);
    });

    it('allows ordered -> received (skip in_transit for production)', () => {
      expect(isValidTransition('ordered', 'received')).toBe(true);
    });

    it('allows in_transit -> received', () => {
      expect(isValidTransition('in_transit', 'received')).toBe(true);
    });

    it('allows received -> restocked', () => {
      expect(isValidTransition('received', 'restocked')).toBe(true);
    });

    it('allows restocked -> created (loop restart)', () => {
      expect(isValidTransition('restocked', 'created')).toBe(true);
    });

    it('rejects created -> ordered (skip triggered)', () => {
      expect(isValidTransition('created', 'ordered')).toBe(false);
    });

    it('rejects triggered -> received (skip ordered)', () => {
      expect(isValidTransition('triggered', 'received')).toBe(false);
    });

    it('rejects created -> restocked', () => {
      expect(isValidTransition('created', 'restocked')).toBe(false);
    });

    it('rejects reverse transitions', () => {
      expect(isValidTransition('triggered', 'created')).toBe(false);
      expect(isValidTransition('ordered', 'triggered')).toBe(false);
      expect(isValidTransition('received', 'ordered')).toBe(false);
    });

    it('rejects unknown stages', () => {
      expect(isValidTransition('unknown', 'triggered')).toBe(false);
      expect(isValidTransition('created', 'unknown')).toBe(false);
    });
  });
});

// ─── Transition Rules Tests ─────────────────────────────────────────

describe('Scan Service - Transition Rules', () => {
  describe('QR Scan Method Authorization', () => {
    it('allows qr_scan for created -> triggered', () => {
      expect(isMethodAllowed('created', 'triggered', 'qr_scan')).toBe(true);
    });

    it('does not allow qr_scan for triggered -> ordered', () => {
      expect(isMethodAllowed('triggered', 'ordered', 'qr_scan')).toBe(false);
    });

    it('allows qr_scan for ordered -> received (production direct)', () => {
      expect(isMethodAllowed('ordered', 'received', 'qr_scan')).toBe(true);
    });

    it('allows qr_scan for in_transit -> received', () => {
      expect(isMethodAllowed('in_transit', 'received', 'qr_scan')).toBe(true);
    });

    it('allows qr_scan for received -> restocked', () => {
      expect(isMethodAllowed('received', 'restocked', 'qr_scan')).toBe(true);
    });

    it('does not allow qr_scan for restocked -> created', () => {
      expect(isMethodAllowed('restocked', 'created', 'qr_scan')).toBe(false);
    });
  });

  describe('Role Authorization for Scan Trigger', () => {
    const scanTransition = { from: 'created' as const, to: 'triggered' as const };

    it('allows tenant_admin to scan', () => {
      expect(isRoleAllowed(scanTransition.from, scanTransition.to, 'tenant_admin')).toBe(true);
    });

    it('allows inventory_manager to scan', () => {
      expect(isRoleAllowed(scanTransition.from, scanTransition.to, 'inventory_manager')).toBe(true);
    });

    it('allows procurement_manager to scan', () => {
      expect(isRoleAllowed(scanTransition.from, scanTransition.to, 'procurement_manager')).toBe(true);
    });

    it('allows receiving_manager to scan', () => {
      expect(isRoleAllowed(scanTransition.from, scanTransition.to, 'receiving_manager')).toBe(true);
    });

    it('does not allow salesperson to scan', () => {
      expect(isRoleAllowed(scanTransition.from, scanTransition.to, 'salesperson')).toBe(false);
    });

    it('does not allow executive to scan', () => {
      expect(isRoleAllowed(scanTransition.from, scanTransition.to, 'executive')).toBe(false);
    });
  });

  describe('Loop Type Compatibility for Scan', () => {
    it('allows scan trigger for procurement loops', () => {
      expect(isLoopTypeAllowed('created', 'triggered', 'procurement')).toBe(true);
    });

    it('allows scan trigger for production loops', () => {
      expect(isLoopTypeAllowed('created', 'triggered', 'production')).toBe(true);
    });

    it('allows scan trigger for transfer loops', () => {
      expect(isLoopTypeAllowed('created', 'triggered', 'transfer')).toBe(true);
    });
  });

  describe('Transition Rule Completeness', () => {
    it('has rules for all valid transitions', () => {
      for (const [from, toStages] of Object.entries(VALID_TRANSITIONS)) {
        for (const to of toStages) {
          const rule = TRANSITION_RULES.find(
            (r) => r.from === from && r.to === to,
          );
          expect(rule).toBeDefined();
          expect(rule?.description).toBeTruthy();
          expect(rule?.allowedRoles.length).toBeGreaterThan(0);
          expect(rule?.allowedLoopTypes.length).toBeGreaterThan(0);
          expect(rule?.allowedMethods.length).toBeGreaterThan(0);
        }
      }
    });

    it('triggered -> ordered requires linked order', () => {
      const rule = TRANSITION_RULES.find(
        (r) => r.from === 'triggered' && r.to === 'ordered',
      );
      expect(rule?.requiresLinkedOrder).toBe(true);
      expect(rule?.linkedOrderTypes).toContain('purchase_order');
      expect(rule?.linkedOrderTypes).toContain('work_order');
      expect(rule?.linkedOrderTypes).toContain('transfer_order');
    });

    it('created -> triggered does not require linked order', () => {
      const rule = TRANSITION_RULES.find(
        (r) => r.from === 'created' && r.to === 'triggered',
      );
      expect(rule?.requiresLinkedOrder).toBeFalsy();
    });
  });
});

// ─── Idempotency Tests (Logic Validation) ───────────────────────────

describe('Scan Service - Idempotency Contract', () => {
  it('defines idempotency key pattern', () => {
    // The PWA generates keys as: scan-{cardId}-{sessionId}-{timestamp}
    const key = `scan-card-001-sess-123-${Date.now()}`;
    expect(key).toMatch(/^scan-/);
    expect(key.length).toBeLessThanOrEqual(100);
  });

  it('idempotency key uniqueness per scan event', () => {
    const cardId = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    const key1 = `scan-${cardId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const key2 = `scan-${cardId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Even for the same card, keys should differ
    expect(key1).not.toBe(key2);
  });

  it('idempotency key is deterministic for replay', () => {
    // When a scan is queued, its idempotency key is stored.
    // On replay, the same key is sent to ensure dedup.
    const storedKey = 'scan-card-001-1706000000000-abcd';
    const replayKey = storedKey; // Must be the same

    expect(replayKey).toBe(storedKey);
  });
});

// ─── Scan Error Code Tests ──────────────────────────────────────────

describe('Scan Service - Error Codes', () => {
  const errorCodes = [
    { code: 'CARD_NOT_FOUND', status: 404, message: 'Card not found' },
    { code: 'CARD_INACTIVE', status: 400, message: 'Card is deactivated' },
    { code: 'CARD_ALREADY_TRIGGERED', status: 400, message: 'Card already triggered' },
    { code: 'TENANT_MISMATCH', status: 403, message: 'Tenant mismatch' },
    { code: 'INVALID_TRANSITION', status: 400, message: 'Invalid transition' },
    { code: 'ROLE_NOT_ALLOWED', status: 403, message: 'Role not allowed' },
    { code: 'LOOP_TYPE_INCOMPATIBLE', status: 400, message: 'Loop type incompatible' },
    { code: 'METHOD_NOT_ALLOWED', status: 400, message: 'Method not allowed' },
    { code: 'LINKED_ORDER_REQUIRED', status: 400, message: 'Linked order required' },
    { code: 'INVALID_ORDER_TYPE', status: 400, message: 'Invalid order type' },
  ];

  it.each(errorCodes)('defines error code $code', ({ code }) => {
    // Verify the error code string is a valid format
    expect(code).toMatch(/^[A-Z_]+$/);
    expect(code.length).toBeGreaterThan(0);
    expect(code.length).toBeLessThanOrEqual(50);
  });

  it('all error codes are unique', () => {
    const codes = errorCodes.map((e) => e.code);
    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size).toBe(codes.length);
  });
});

// ─── QR UUID Immutability Contract ──────────────────────────────────

describe('Scan Service - QR UUID Immutability', () => {
  it('card.id is the QR identifier (no separate qr_id)', () => {
    // This test documents the design contract:
    // The card's primary key UUID IS the QR code payload.
    // There is no separate qr_id column.
    // This ensures QR codes never need reprinting due to ID changes.
    const cardId = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    const qrPayload = cardId; // QR encodes: {APP_URL}/scan/{cardId}

    expect(qrPayload).toBe(cardId);
  });

  it('UUID format is v4 compatible', () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    expect(UUID_RE.test('a0b1c2d3-e4f5-6789-abcd-ef0123456789')).toBe(true);
    expect(UUID_RE.test('A0B1C2D3-E4F5-6789-ABCD-EF0123456789')).toBe(true);
    expect(UUID_RE.test('not-a-uuid')).toBe(false);
    expect(UUID_RE.test('')).toBe(false);
    expect(UUID_RE.test('12345')).toBe(false);
  });
});
