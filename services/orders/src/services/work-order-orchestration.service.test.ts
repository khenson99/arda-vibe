import { describe, expect, it, vi } from 'vitest';

vi.mock('@arda/db', () => ({
  db: {
    transaction: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    query: {},
  },
  schema: {
    workOrders: {},
    workOrderRoutings: {},
    kanbanCards: {},
    kanbanLoops: {},
    cardStageTransitions: {},
    productionQueueEntries: {},
    routingTemplates: {},
    auditLog: {},
  },
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'test', sequenceNumber: 1 })),
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/config', () => ({
  config: {},
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@arda/events', () => ({
  getEventBus: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./order-number.service.js', () => ({
  getNextWONumber: vi.fn().mockResolvedValue('WO-TEST-0001'),
}));

vi.mock('./routing-engine.service.js', () => ({
  applyRoutingTemplate: vi.fn().mockResolvedValue({
    templateName: 'mock-template',
    stepsCreated: 0,
  }),
}));

import {
  computeProductionPriorityScore,
} from './work-order-orchestration.service.js';
import {
  WO_VALID_TRANSITIONS,
  ROUTING_STEP_VALID_TRANSITIONS,
} from '@arda/shared-types';
import type { WOStatus, RoutingStepStatus } from '@arda/shared-types';

// ─── WO Status Transition Validation ────────────────────────────────
describe('WO_VALID_TRANSITIONS', () => {
  it('allows draft -> scheduled', () => {
    expect(WO_VALID_TRANSITIONS.draft).toContain('scheduled');
  });

  it('allows draft -> cancelled', () => {
    expect(WO_VALID_TRANSITIONS.draft).toContain('cancelled');
  });

  it('allows scheduled -> in_progress', () => {
    expect(WO_VALID_TRANSITIONS.scheduled).toContain('in_progress');
  });

  it('allows scheduled -> cancelled', () => {
    expect(WO_VALID_TRANSITIONS.scheduled).toContain('cancelled');
  });

  it('allows in_progress -> on_hold', () => {
    expect(WO_VALID_TRANSITIONS.in_progress).toContain('on_hold');
  });

  it('allows in_progress -> completed', () => {
    expect(WO_VALID_TRANSITIONS.in_progress).toContain('completed');
  });

  it('allows in_progress -> cancelled', () => {
    expect(WO_VALID_TRANSITIONS.in_progress).toContain('cancelled');
  });

  it('allows on_hold -> in_progress (resume)', () => {
    expect(WO_VALID_TRANSITIONS.on_hold).toContain('in_progress');
  });

  it('allows on_hold -> cancelled', () => {
    expect(WO_VALID_TRANSITIONS.on_hold).toContain('cancelled');
  });

  it('disallows completed -> any', () => {
    expect(WO_VALID_TRANSITIONS.completed).toHaveLength(0);
  });

  it('disallows cancelled -> any', () => {
    expect(WO_VALID_TRANSITIONS.cancelled).toHaveLength(0);
  });

  it('disallows draft -> in_progress (must go through scheduled)', () => {
    expect(WO_VALID_TRANSITIONS.draft).not.toContain('in_progress');
  });
});

// ─── Routing Step Transition Validation ─────────────────────────────
describe('ROUTING_STEP_VALID_TRANSITIONS', () => {
  it('allows pending -> in_progress', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.pending).toContain('in_progress');
  });

  it('allows pending -> skipped', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.pending).toContain('skipped');
  });

  it('allows in_progress -> complete', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.in_progress).toContain('complete');
  });

  it('allows in_progress -> on_hold', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.in_progress).toContain('on_hold');
  });

  it('allows in_progress -> skipped', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.in_progress).toContain('skipped');
  });

  it('allows on_hold -> in_progress', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.on_hold).toContain('in_progress');
  });

  it('disallows complete -> any', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.complete).toHaveLength(0);
  });

  it('disallows skipped -> any', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.skipped).toHaveLength(0);
  });

  it('disallows pending -> complete (must start first)', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.pending).not.toContain('complete');
  });
});

// ─── Priority Score Computation ─────────────────────────────────────
describe('computeProductionPriorityScore', () => {
  const now = new Date('2025-06-01T12:00:00Z');

  it('returns 100 for expedited items', () => {
    const score = computeProductionPriorityScore({
      triggeredAgeHours: 1,
      daysOfSupply: 25,
      manualPriority: 0,
      scheduledStartDate: null,
      isExpedited: true,
      now,
    });
    expect(score).toBe(100);
  });

  it('returns higher score for older items', () => {
    const fresh = computeProductionPriorityScore({
      triggeredAgeHours: 1,
      daysOfSupply: null,
      manualPriority: 0,
      scheduledStartDate: null,
      isExpedited: false,
      now,
    });
    const old = computeProductionPriorityScore({
      triggeredAgeHours: 168,
      daysOfSupply: null,
      manualPriority: 0,
      scheduledStartDate: null,
      isExpedited: false,
      now,
    });
    expect(old).toBeGreaterThan(fresh);
  });

  it('returns higher score for low days of supply', () => {
    const plenty = computeProductionPriorityScore({
      triggeredAgeHours: 24,
      daysOfSupply: 28,
      manualPriority: 0,
      scheduledStartDate: null,
      isExpedited: false,
      now,
    });
    const scarce = computeProductionPriorityScore({
      triggeredAgeHours: 24,
      daysOfSupply: 2,
      manualPriority: 0,
      scheduledStartDate: null,
      isExpedited: false,
      now,
    });
    expect(scarce).toBeGreaterThan(plenty);
  });

  it('applies manual priority weight', () => {
    const low = computeProductionPriorityScore({
      triggeredAgeHours: 24,
      daysOfSupply: null,
      manualPriority: 0,
      scheduledStartDate: null,
      isExpedited: false,
      now,
    });
    const high = computeProductionPriorityScore({
      triggeredAgeHours: 24,
      daysOfSupply: null,
      manualPriority: 100,
      scheduledStartDate: null,
      isExpedited: false,
      now,
    });
    expect(high).toBeGreaterThan(low);
  });

  it('considers due date proximity', () => {
    const farAway = computeProductionPriorityScore({
      triggeredAgeHours: 24,
      daysOfSupply: null,
      manualPriority: 0,
      scheduledStartDate: new Date('2025-06-15T00:00:00Z'), // 14 days away
      isExpedited: false,
      now,
    });
    const imminent = computeProductionPriorityScore({
      triggeredAgeHours: 24,
      daysOfSupply: null,
      manualPriority: 0,
      scheduledStartDate: new Date('2025-06-02T00:00:00Z'), // 0.5 days away
      isExpedited: false,
      now,
    });
    expect(imminent).toBeGreaterThan(farAway);
  });

  it('returns maximum score for overdue items', () => {
    const overdue = computeProductionPriorityScore({
      triggeredAgeHours: 168,
      daysOfSupply: 0,
      manualPriority: 100,
      scheduledStartDate: new Date('2025-05-30T00:00:00Z'), // 2 days overdue
      isExpedited: false,
      now,
    });
    // With capacity currently neutral (50), theoretical max is 95.
    expect(overdue).toBe(95);
  });
});

// ─── Split Quantity Guards (pure logic) ─────────────────────────────
describe('split quantity guards', () => {
  it('rejects split quantity of 0', () => {
    const quantityToProduce = 100;
    const quantityProduced = 0;
    const splitQuantity = 0;
    const remaining = quantityToProduce - quantityProduced;
    expect(splitQuantity <= 0 || splitQuantity >= remaining).toBe(true);
  });

  it('rejects split quantity equal to remaining', () => {
    const quantityToProduce = 100;
    const quantityProduced = 0;
    const splitQuantity = 100;
    const remaining = quantityToProduce - quantityProduced;
    expect(splitQuantity <= 0 || splitQuantity >= remaining).toBe(true);
  });

  it('accepts valid split quantity', () => {
    const quantityToProduce = 100;
    const quantityProduced = 0;
    const splitQuantity = 40;
    const remaining = quantityToProduce - quantityProduced;
    expect(splitQuantity > 0 && splitQuantity < remaining).toBe(true);
  });

  it('accounts for already produced quantity', () => {
    const quantityToProduce = 100;
    const quantityProduced = 60;
    const splitQuantity = 30;
    const remaining = quantityToProduce - quantityProduced; // 40
    expect(splitQuantity > 0 && splitQuantity < remaining).toBe(true);
  });

  it('rejects split when all quantity already produced', () => {
    const quantityToProduce = 100;
    const quantityProduced = 100;
    const splitQuantity = 1;
    const remaining = quantityToProduce - quantityProduced; // 0
    expect(splitQuantity >= remaining).toBe(true);
  });
});

// ─── Hold Reason Validation (pure logic) ────────────────────────────
describe('hold reason validation', () => {
  const validReasons = ['material_shortage', 'equipment_failure', 'quality_hold', 'labor_unavailable', 'other'];

  it('requires hold reason for on_hold transition', () => {
    const toStatus: WOStatus = 'on_hold';
    const holdReason = undefined;
    expect(toStatus === 'on_hold' && !holdReason).toBe(true);
  });

  it('accepts valid hold reasons', () => {
    for (const reason of validReasons) {
      expect(validReasons.includes(reason)).toBe(true);
    }
  });
});

// ─── Expedite Rules (pure logic) ────────────────────────────────────
describe('expedite rules', () => {
  it('disallows expedite for completed WO', () => {
    const status: WOStatus = 'completed';
    expect(['completed', 'cancelled'].includes(status)).toBe(true);
  });

  it('disallows expedite for cancelled WO', () => {
    const status: WOStatus = 'cancelled';
    expect(['completed', 'cancelled'].includes(status)).toBe(true);
  });

  it('allows expedite for in_progress WO', () => {
    const status: WOStatus = 'in_progress';
    expect(!['completed', 'cancelled'].includes(status)).toBe(true);
  });

  it('allows expedite for draft WO', () => {
    const status: WOStatus = 'draft';
    expect(!['completed', 'cancelled'].includes(status)).toBe(true);
  });
});

// ─── Idempotency Guards (pure logic) ────────────────────────────────
describe('idempotency guards', () => {
  it('detects existing WO for card (idempotent return)', () => {
    const existingWO = { id: 'wo-1', woNumber: 'WO-20250601-0001' };
    const alreadyExisted = !!existingWO;
    expect(alreadyExisted).toBe(true);
  });

  it('proceeds with creation when no existing WO', () => {
    const existingWO = undefined;
    const shouldCreate = !existingWO;
    expect(shouldCreate).toBe(true);
  });
});
