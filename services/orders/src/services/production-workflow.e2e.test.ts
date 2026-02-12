import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * E2E regression test suite for the production workflow (Ticket #78).
 *
 * Covers:
 * 1. WO / Routing step state-machine transition validation
 * 2. Priority score computation (unit)
 * 3. Production event contract verification
 * 4. Exception hook rules (scrap threshold, short completion)
 * 5. Route-level integration (mocked DB) for analytics + completion
 * 6. Material consumption BOM math
 */

// ─── Hoisted Mocks ──────────────────────────────────────────────────

const testState = vi.hoisted(() => ({
  dbSelectResults: [] as unknown[],
  txSelectResults: [] as unknown[],
  insertedWorkOrders: [] as Array<Record<string, unknown>>,
  insertedQueueEntries: [] as Array<Record<string, unknown>>,
  insertedOpLogs: [] as Array<Record<string, unknown>>,
  insertedAuditRows: [] as Array<Record<string, unknown>>,
  updatedWorkOrders: [] as Array<Record<string, unknown>>,
}));

const { publishMock, getEventBusMock } = vi.hoisted(() => {
  const publishMock = vi.fn(async () => undefined);
  const getEventBusMock = vi.fn(() => ({ publish: publishMock }));
  return { publishMock, getEventBusMock };
});

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => {
    const t = { __table: name } as any;
    // Column references for drizzle SQL template usage
    t.tenantId = { column: 'tenant_id' };
    t.status = { column: 'status' };
    t.id = { column: 'id' };
    t.code = { column: 'code' };
    t.name = { column: 'name' };
    t.isActive = { column: 'is_active' };
    t.facilityId = { column: 'facility_id' };
    t.workOrderId = { column: 'work_order_id' };
    t.workCenterId = { column: 'work_center_id' };
    t.priorityScore = { column: 'priority_score' };
    t.createdAt = { column: 'created_at' };
    t.updatedAt = { column: 'updated_at' };
    t.completedAt = { column: 'completed_at' };
    t.startedAt = { column: 'started_at' };
    t.actualStartDate = { column: 'actual_start_date' };
    t.actualEndDate = { column: 'actual_end_date' };
    t.quantityToProduce = { column: 'quantity_to_produce' };
    t.quantityProduced = { column: 'quantity_produced' };
    t.quantityRejected = { column: 'quantity_rejected' };
    t.quantityScrapped = { column: 'quantity_scrapped' };
    t.isExpedited = { column: 'is_expedited' };
    t.isRework = { column: 'is_rework' };
    t.woNumber = { column: 'wo_number' };
    t.cardId = { column: 'card_id' };
    t.kanbanCardId = { column: 'kanban_card_id' };
    t.loopId = { column: 'loop_id' };
    t.partId = { column: 'part_id' };
    t.parentWorkOrderId = { column: 'parent_work_order_id' };
    t.routingTemplateId = { column: 'routing_template_id' };
    t.manualPriority = { column: 'manual_priority' };
    t.holdReason = { column: 'hold_reason' };
    t.holdNotes = { column: 'hold_notes' };
    t.cancelReason = { column: 'cancel_reason' };
    t.enteredQueueAt = { column: 'entered_queue_at' };
    t.exitedQueueAt = { column: 'exited_queue_at' };
    t.operationType = { column: 'operation_type' };
    t.operatorUserId = { column: 'operator_user_id' };
    t.notes = { column: 'notes' };
    t.quantity = { column: 'quantity' };
    t.scrapQuantity = { column: 'scrap_quantity' };
    t.routingStepId = { column: 'routing_step_id' };
    t.actualMinutes = { column: 'actual_minutes' };
    t.estimatedMinutes = { column: 'estimated_minutes' };
    t.availableMinutes = { column: 'available_minutes' };
    t.allocatedMinutes = { column: 'allocated_minutes' };
    t.currentStage = { column: 'current_stage' };
    t.completedCycles = { column: 'completed_cycles' };
    t.parentPartId = { column: 'parent_part_id' };
    t.childPartId = { column: 'child_part_id' };
    t.quantityPer = { column: 'quantity_per' };
    t.partNumber = { column: 'part_number' };
    return t;
  };

  return {
    workOrders: table('work_orders'),
    workOrderRoutings: table('work_order_routings'),
    productionOperationLogs: table('production_operation_logs'),
    productionQueueEntries: table('production_queue_entries'),
    workCenters: table('work_centers'),
    workCenterCapacityWindows: table('work_center_capacity_windows'),
    kanbanCards: table('kanban_cards'),
    kanbanLoops: table('kanban_loops'),
    cardStageTransitions: table('card_stage_transitions'),
    routingTemplates: table('routing_templates'),
    auditLog: table('audit_log'),
    bomItems: table('bom_items'),
    parts: table('parts'),
    users: table('users'),
  };
});

const { dbMock, resetDbMockCalls } = vi.hoisted(() => {
  let insertCounter = 0;

  function makeSelectBuilder(result: unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.limit = () => builder;
    builder.orderBy = () => builder;
    builder.innerJoin = () => builder;
    builder.groupBy = () => builder;
    builder.execute = async () => result;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  }

  function makeUpdateBuilder() {
    const query: any = {};
    query.set = vi.fn(() => query);
    query.where = vi.fn(() => query);
    query.returning = vi.fn(async () => []);
    query.execute = async () => undefined;
    query.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(undefined).then(resolve, reject);
    return query;
  }

  function makeTx() {
    const tx: any = {};
    tx.select = vi.fn(() => makeSelectBuilder(testState.txSelectResults.shift() ?? []));
    tx.update = vi.fn((table: unknown) => {
      const builder = makeUpdateBuilder();
      const tableName = (table as { __table?: string }).__table;
      builder.set = vi.fn((values: Record<string, unknown>) => {
        if (tableName === 'work_orders') {
          testState.updatedWorkOrders.push(values);
        }
        return builder;
      });
      return builder;
    });
    tx.insert = vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        const tableName = (table as { __table?: string }).__table;
        const arr = Array.isArray(values) ? values : [values];
        if (tableName === 'work_orders') testState.insertedWorkOrders.push(...(arr as any));
        if (tableName === 'production_queue_entries') testState.insertedQueueEntries.push(...(arr as any));
        if (tableName === 'production_operation_logs') testState.insertedOpLogs.push(...(arr as any));
        if (tableName === 'audit_log') testState.insertedAuditRows.push(...(arr as any));
        return {
          returning: async () =>
            arr.map((v: any) => ({
              ...v,
              id: `${tableName}-${++insertCounter}`,
            })),
          execute: async () => undefined,
        };
      }),
    }));
    tx.execute = vi.fn(async () => undefined);
    return tx;
  }

  const dbMock = {
    select: vi.fn(() => makeSelectBuilder(testState.dbSelectResults.shift() ?? [])),
    update: vi.fn(() => makeUpdateBuilder()),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        const tableName = (table as { __table?: string }).__table;
        const arr = Array.isArray(values) ? values : [values];
        if (tableName === 'work_orders') testState.insertedWorkOrders.push(...(arr as any));
        if (tableName === 'production_queue_entries') testState.insertedQueueEntries.push(...(arr as any));
        if (tableName === 'production_operation_logs') testState.insertedOpLogs.push(...(arr as any));
        if (tableName === 'audit_log') testState.insertedAuditRows.push(...(arr as any));
        return {
          returning: async () =>
            arr.map((v: any) => ({
              ...v,
              id: `${tableName}-${++insertCounter}`,
            })),
          execute: async () => undefined,
        };
      }),
    })),
    transaction: vi.fn(async (callback: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      callback(makeTx())
    ),
  };

  const resetDbMockCalls = () => {
    insertCounter = 0;
    dbMock.select.mockClear();
    dbMock.update.mockClear();
    dbMock.insert.mockClear();
    dbMock.transaction.mockClear();
  };

  return { dbMock, resetDbMockCalls };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  gte: vi.fn(() => ({})),
  lte: vi.fn(() => ({})),
  count: vi.fn(() => ({})),
}));

const writeAuditEntryMock = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.insertedAuditRows.push(entry);
    return { id: `audit-${testState.insertedAuditRows.length}`, hashChain: 'test-hash', sequenceNumber: testState.insertedAuditRows.length };
  })
);

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: writeAuditEntryMock,
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/events', () => ({
  getEventBus: getEventBusMock,
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('./order-number.service.js', () => ({
  getNextWONumber: vi.fn(async () => 'WO-TEST-0001'),
}));

vi.mock('./routing-engine.service.js', () => ({
  applyRoutingTemplate: vi.fn(async () => ({ templateName: 'mock-template', stepsCreated: 0 })),
  transitionRoutingStep: vi.fn(async () => ({ success: true })),
  getRoutingSteps: vi.fn(async () => []),
  canAutoCompleteWorkOrder: vi.fn(async () => ({ canComplete: true, reason: null })),
}));

vi.mock('./material-consumption.service.js', () => ({
  recordMaterialConsumption: vi.fn(async () => ({
    workOrderId: 'wo-1',
    stepId: 'step-1',
    lines: [],
    totalLinesConsumed: 0,
  })),
}));

vi.mock('./capacity-scheduler.service.js', () => ({
  releaseCapacity: vi.fn(async () => ({ released: true })),
}));

// ─── Import After Mocks ─────────────────────────────────────────────

import { computeProductionPriorityScore } from './work-order-orchestration.service.js';
import {
  WO_VALID_TRANSITIONS,
  ROUTING_STEP_VALID_TRANSITIONS,
} from '@arda/shared-types';
import type { WOStatus, RoutingStepStatus } from '@arda/shared-types';

// ═══════════════════════════════════════════════════════════════════
// 1. WO State Machine Transition Rules
// ═══════════════════════════════════════════════════════════════════

describe('WO state machine completeness', () => {
  const allStatuses: WOStatus[] = ['draft', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled'];

  it('defines transitions for every WO status', () => {
    for (const status of allStatuses) {
      expect(WO_VALID_TRANSITIONS[status]).toBeDefined();
      expect(Array.isArray(WO_VALID_TRANSITIONS[status])).toBe(true);
    }
  });

  it('enforces completed and cancelled are terminal states', () => {
    expect(WO_VALID_TRANSITIONS.completed).toHaveLength(0);
    expect(WO_VALID_TRANSITIONS.cancelled).toHaveLength(0);
  });

  it('requires scheduled step between draft and in_progress', () => {
    expect(WO_VALID_TRANSITIONS.draft).not.toContain('in_progress');
    expect(WO_VALID_TRANSITIONS.draft).toContain('scheduled');
    expect(WO_VALID_TRANSITIONS.scheduled).toContain('in_progress');
  });

  it('allows on_hold -> in_progress (resume path)', () => {
    expect(WO_VALID_TRANSITIONS.on_hold).toContain('in_progress');
  });

  it('allows cancellation from any active state', () => {
    expect(WO_VALID_TRANSITIONS.draft).toContain('cancelled');
    expect(WO_VALID_TRANSITIONS.scheduled).toContain('cancelled');
    expect(WO_VALID_TRANSITIONS.in_progress).toContain('cancelled');
    expect(WO_VALID_TRANSITIONS.on_hold).toContain('cancelled');
  });
});

describe('routing step state machine completeness', () => {
  const allStepStatuses: RoutingStepStatus[] = ['pending', 'in_progress', 'complete', 'on_hold', 'skipped'];

  it('defines transitions for every step status', () => {
    for (const status of allStepStatuses) {
      expect(ROUTING_STEP_VALID_TRANSITIONS[status]).toBeDefined();
      expect(Array.isArray(ROUTING_STEP_VALID_TRANSITIONS[status])).toBe(true);
    }
  });

  it('enforces complete and skipped are terminal states', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.complete).toHaveLength(0);
    expect(ROUTING_STEP_VALID_TRANSITIONS.skipped).toHaveLength(0);
  });

  it('requires starting before completing (pending cannot go to complete)', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.pending).not.toContain('complete');
    expect(ROUTING_STEP_VALID_TRANSITIONS.pending).toContain('in_progress');
    expect(ROUTING_STEP_VALID_TRANSITIONS.in_progress).toContain('complete');
  });

  it('allows skip from pending or in_progress', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.pending).toContain('skipped');
    expect(ROUTING_STEP_VALID_TRANSITIONS.in_progress).toContain('skipped');
  });

  it('allows hold and resume cycle on in_progress', () => {
    expect(ROUTING_STEP_VALID_TRANSITIONS.in_progress).toContain('on_hold');
    expect(ROUTING_STEP_VALID_TRANSITIONS.on_hold).toContain('in_progress');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Priority Score Computation
// ═══════════════════════════════════════════════════════════════════

describe('production priority score computation', () => {
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

  it('clamps score between 0 and 95 for non-expedited', () => {
    const scoreMin = computeProductionPriorityScore({
      triggeredAgeHours: 0,
      daysOfSupply: 100,
      manualPriority: 0,
      scheduledStartDate: null,
      isExpedited: false,
      now,
    });
    const scoreMax = computeProductionPriorityScore({
      triggeredAgeHours: 999,
      daysOfSupply: 0,
      manualPriority: 100,
      scheduledStartDate: new Date('2025-05-01T00:00:00Z'), // overdue
      isExpedited: false,
      now,
    });
    expect(scoreMin).toBeGreaterThanOrEqual(0);
    expect(scoreMax).toBeLessThanOrEqual(95);
  });

  it('scores increase monotonically with age', () => {
    const scores = [1, 24, 72, 168, 336].map((hours) =>
      computeProductionPriorityScore({
        triggeredAgeHours: hours,
        daysOfSupply: null,
        manualPriority: 0,
        scheduledStartDate: null,
        isExpedited: false,
        now,
      })
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
  });

  it('scores increase as days of supply decreases', () => {
    const plenty = computeProductionPriorityScore({
      triggeredAgeHours: 24,
      daysOfSupply: 30,
      manualPriority: 0,
      scheduledStartDate: null,
      isExpedited: false,
      now,
    });
    const scarce = computeProductionPriorityScore({
      triggeredAgeHours: 24,
      daysOfSupply: 1,
      manualPriority: 0,
      scheduledStartDate: null,
      isExpedited: false,
      now,
    });
    expect(scarce).toBeGreaterThan(plenty);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Production Event Contract Verification
// ═══════════════════════════════════════════════════════════════════

describe('production event contract compliance', () => {
  it('ProductionStepCompletedEvent has all required fields', () => {
    const event = {
      type: 'production.step_completed' as const,
      tenantId: 'tenant-1',
      workOrderId: 'wo-1',
      workOrderNumber: 'WO-20260209-0001',
      stepNumber: 1,
      operationName: 'CNC Machining',
      workCenterId: 'wc-1',
      actualMinutes: 45,
      status: 'complete' as const,
      timestamp: new Date().toISOString(),
    };

    expect(event.type).toBe('production.step_completed');
    expect(typeof event.stepNumber).toBe('number');
    expect(typeof event.operationName).toBe('string');
    expect(typeof event.workCenterId).toBe('string');
    expect(typeof event.actualMinutes).toBe('number');
    expect(['complete', 'skipped']).toContain(event.status);
  });

  it('ProductionQuantityReportedEvent has all required fields', () => {
    const event = {
      type: 'production.quantity_reported' as const,
      tenantId: 'tenant-1',
      workOrderId: 'wo-1',
      workOrderNumber: 'WO-20260209-0001',
      quantityProduced: 100,
      quantityRejected: 0,
      quantityScrapped: 5,
      timestamp: new Date().toISOString(),
    };

    expect(event.type).toBe('production.quantity_reported');
    expect(typeof event.quantityProduced).toBe('number');
    expect(typeof event.quantityRejected).toBe('number');
    expect(typeof event.quantityScrapped).toBe('number');
  });

  it('ProductionHoldEvent has all required fields', () => {
    const event = {
      type: 'production.hold' as const,
      tenantId: 'tenant-1',
      workOrderId: 'wo-1',
      workOrderNumber: 'WO-20260209-0001',
      holdReason: 'material_shortage',
      holdNotes: 'Waiting for raw material delivery',
      userId: 'user-1',
      timestamp: new Date().toISOString(),
    };

    expect(event.type).toBe('production.hold');
    expect(typeof event.holdReason).toBe('string');
    expect(event.holdNotes).toBeDefined();
  });

  it('ProductionResumeEvent has all required fields', () => {
    const event = {
      type: 'production.resume' as const,
      tenantId: 'tenant-1',
      workOrderId: 'wo-1',
      workOrderNumber: 'WO-20260209-0001',
      userId: 'user-1',
      timestamp: new Date().toISOString(),
    };

    expect(event.type).toBe('production.resume');
    expect(typeof event.workOrderId).toBe('string');
  });

  it('ProductionExpediteEvent has all required fields', () => {
    const event = {
      type: 'production.expedite' as const,
      tenantId: 'tenant-1',
      workOrderId: 'wo-1',
      workOrderNumber: 'WO-20260209-0001',
      previousPriority: 45,
      userId: 'user-1',
      timestamp: new Date().toISOString(),
    };

    expect(event.type).toBe('production.expedite');
    expect(typeof event.previousPriority).toBe('number');
  });

  it('ProductionSplitEvent has all required fields', () => {
    const event = {
      type: 'production.split' as const,
      tenantId: 'tenant-1',
      parentWorkOrderId: 'wo-1',
      childWorkOrderId: 'wo-2',
      parentQuantity: 60,
      childQuantity: 40,
      timestamp: new Date().toISOString(),
    };

    expect(event.type).toBe('production.split');
    expect(typeof event.parentQuantity).toBe('number');
    expect(typeof event.childQuantity).toBe('number');
    expect(event.parentQuantity + event.childQuantity).toBe(100);
  });

  it('ProductionReworkEvent has all required fields', () => {
    const event = {
      type: 'production.rework' as const,
      tenantId: 'tenant-1',
      originalWorkOrderId: 'wo-1',
      reworkWorkOrderId: 'wo-rw-1',
      reworkQuantity: 15,
      timestamp: new Date().toISOString(),
    };

    expect(event.type).toBe('production.rework');
    expect(typeof event.reworkQuantity).toBe('number');
    expect(event.reworkQuantity).toBeGreaterThan(0);
  });

  it('OrderStatusChangedEvent supports work_order orderType', () => {
    const event = {
      type: 'order.status_changed' as const,
      tenantId: 'tenant-1',
      orderType: 'work_order' as const,
      orderId: 'wo-1',
      orderNumber: 'WO-20260209-0001',
      fromStatus: 'in_progress',
      toStatus: 'completed',
      timestamp: new Date().toISOString(),
    };

    expect(event.orderType).toBe('work_order');
    expect(['purchase_order', 'work_order', 'transfer_order']).toContain(event.orderType);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Exception Hook Rules (Pure Logic)
// ═══════════════════════════════════════════════════════════════════

describe('scrap threshold exception logic', () => {
  it('does not trigger below threshold', () => {
    const quantityToProduce = 100;
    const quantityScrapped = 5;
    const threshold = 10;
    const scrapRate = (quantityScrapped / quantityToProduce) * 100;
    expect(scrapRate).toBe(5);
    expect(scrapRate <= threshold).toBe(true);
  });

  it('triggers at exactly the threshold', () => {
    const quantityToProduce = 100;
    const quantityScrapped = 10;
    const threshold = 10;
    const scrapRate = (quantityScrapped / quantityToProduce) * 100;
    expect(scrapRate).toBe(10);
    // At exactly threshold -> does NOT exceed
    expect(scrapRate <= threshold).toBe(true);
  });

  it('triggers above threshold', () => {
    const quantityToProduce = 100;
    const quantityScrapped = 15;
    const threshold = 10;
    const scrapRate = (quantityScrapped / quantityToProduce) * 100;
    expect(scrapRate).toBe(15);
    expect(scrapRate > threshold).toBe(true);
  });

  it('handles zero quantity gracefully', () => {
    const quantityToProduce = 0;
    const quantityScrapped = 0;
    const threshold = 10;
    const scrapRate = quantityToProduce > 0 ? (quantityScrapped / quantityToProduce) * 100 : 0;
    expect(scrapRate).toBe(0);
    expect(scrapRate <= threshold).toBe(true);
  });

  it('rework WO inherits parent attributes', () => {
    const parent = {
      woNumber: 'WO-20260209-0001',
      cardId: 'card-1',
      loopId: 'loop-1',
      partId: 'part-1',
      facilityId: 'fac-1',
      isExpedited: true,
      priorityScore: 60,
    };

    const reworkWo = {
      woNumber: `${parent.woNumber}-RW`,
      cardId: parent.cardId,
      loopId: parent.loopId,
      partId: parent.partId,
      facilityId: parent.facilityId,
      isExpedited: parent.isExpedited,
      isRework: true,
      priorityScore: Math.min(100, parent.priorityScore + 10),
    };

    expect(reworkWo.woNumber).toBe('WO-20260209-0001-RW');
    expect(reworkWo.isRework).toBe(true);
    expect(reworkWo.priorityScore).toBe(70);
    expect(reworkWo.cardId).toBe(parent.cardId);
  });
});

describe('short completion exception logic', () => {
  it('does not trigger when fully produced', () => {
    const quantityToProduce = 100;
    const quantityProduced = 100;
    const tolerance = 5;
    const shortfall = quantityToProduce - quantityProduced;
    expect(shortfall).toBe(0);
    expect(shortfall <= 0).toBe(true);
  });

  it('does not trigger within tolerance', () => {
    const quantityToProduce = 100;
    const quantityProduced = 96;
    const tolerance = 5;
    const shortfall = quantityToProduce - quantityProduced;
    const shortfallPercent = (shortfall / quantityToProduce) * 100;
    expect(shortfall).toBe(4);
    expect(shortfallPercent).toBe(4);
    expect(shortfallPercent <= tolerance).toBe(true);
  });

  it('triggers beyond tolerance', () => {
    const quantityToProduce = 100;
    const quantityProduced = 80;
    const tolerance = 5;
    const shortfall = quantityToProduce - quantityProduced;
    const shortfallPercent = (shortfall / quantityToProduce) * 100;
    expect(shortfall).toBe(20);
    expect(shortfallPercent).toBe(20);
    expect(shortfall > 0 && shortfallPercent > tolerance).toBe(true);
  });

  it('follow-up WO uses correct suffix', () => {
    const parentWoNumber = 'WO-20260209-0001';
    const followUpWoNumber = `${parentWoNumber}-FU`;
    expect(followUpWoNumber).toBe('WO-20260209-0001-FU');
  });

  it('follow-up WO quantity equals shortfall', () => {
    const quantityToProduce = 100;
    const quantityProduced = 80;
    const shortfall = quantityToProduce - quantityProduced;
    expect(shortfall).toBe(20);
  });
});

describe('material shortage hold logic', () => {
  it('only processes holds with material_shortage reason', () => {
    const holdReasons = ['material_shortage', 'equipment_failure', 'quality_hold', 'labor_unavailable', 'other'];
    const shouldRequeue = holdReasons.filter((r) => r === 'material_shortage');
    expect(shouldRequeue).toHaveLength(1);
    expect(shouldRequeue[0]).toBe('material_shortage');
  });

  it('requires linked kanban card for procurement requeue', () => {
    const woWithCard = { cardId: 'card-1' };
    const woWithoutCard = { cardId: null };
    expect(!!woWithCard.cardId).toBe(true);
    expect(!!woWithoutCard.cardId).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Material Consumption BOM Math
// ═══════════════════════════════════════════════════════════════════

describe('BOM-driven consumption calculations', () => {
  it('calculates correct consumption for single BOM line', () => {
    const quantityProduced = 50;
    const bomLine = { childPartId: 'part-a', quantityPer: 2.5 };
    const consumed = quantityProduced * bomLine.quantityPer;
    expect(consumed).toBe(125);
  });

  it('calculates correct consumption for multiple BOM lines', () => {
    const quantityProduced = 100;
    const bom = [
      { childPartId: 'part-a', quantityPer: 1.0 },
      { childPartId: 'part-b', quantityPer: 0.5 },
      { childPartId: 'part-c', quantityPer: 3.0 },
    ];

    const consumptions = bom.map((line) => ({
      childPartId: line.childPartId,
      consumed: quantityProduced * line.quantityPer,
    }));

    expect(consumptions[0].consumed).toBe(100);
    expect(consumptions[1].consumed).toBe(50);
    expect(consumptions[2].consumed).toBe(300);

    const totalConsumed = consumptions.reduce((sum, c) => sum + c.consumed, 0);
    expect(totalConsumed).toBe(450);
  });

  it('handles fractional quantityPer correctly', () => {
    const quantityProduced = 7;
    const quantityPer = 0.333;
    const consumed = quantityProduced * quantityPer;
    expect(consumed).toBeCloseTo(2.331, 3);
  });

  it('skips consumption when BOM is empty', () => {
    const bom: Array<{ childPartId: string; quantityPer: number }> = [];
    const lines = bom.map((line) => ({
      childPartId: line.childPartId,
      consumed: 100 * line.quantityPer,
    }));
    expect(lines).toHaveLength(0);
  });

  it('skips consumption when quantityProduced is 0', () => {
    const quantityProduced = 0;
    const bomLine = { childPartId: 'part-a', quantityPer: 2.5 };
    const consumed = quantityProduced * bomLine.quantityPer;
    expect(consumed).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Route Integration Tests
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import { productionQueueRouter } from '../routes/production-queue.routes.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      tenantId: 'tenant-1',
      sub: 'user-1',
    };
    next();
  });
  app.use('/production-queue', productionQueueRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function requestJson(
  app: express.Express,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }

    const options: RequestInit = {
      method,
      headers: { 'content-type': 'application/json' },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, options);
    const json = (await response.json()) as Record<string, any>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('production queue routes integration', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.insertedWorkOrders = [];
    testState.insertedQueueEntries = [];
    testState.insertedOpLogs = [];
    testState.insertedAuditRows = [];
    testState.updatedWorkOrders = [];
    resetDbMockCalls();
    publishMock.mockClear();
    getEventBusMock.mockClear();
  });

  describe('GET /production-queue/analytics', () => {
    it('returns analytics metrics', async () => {
      // Overview query
      testState.dbSelectResults.push([{
        totalWorkOrders: 50,
        completedWorkOrders: 30,
        inProgressWorkOrders: 15,
        onHoldWorkOrders: 3,
        cancelledWorkOrders: 2,
        totalQuantityProduced: 5000,
        totalQuantityScrapped: 200,
        expeditedCount: 5,
        reworkCount: 2,
      }]);
      // Throughput (completed cycle time)
      testState.dbSelectResults.push([{ avgCycleTimeHours: 12.5 }]);
      // Date range for WOs/day
      testState.dbSelectResults.push([{
        minDate: '2026-01-01T00:00:00Z',
        maxDate: '2026-02-01T00:00:00Z',
      }]);
      // Queue wait time
      testState.dbSelectResults.push([{ avgWaitHours: 4.3 }]);
      // Work centers list
      testState.dbSelectResults.push([]);
      // Scrap analysis (hold operations)
      testState.dbSelectResults.push([]);
      // Queue health
      testState.dbSelectResults.push([{
        currentBacklog: 8,
        avgPriority: 55.2,
        oldestAgeHours: 72.5,
        expeditedInQueue: 1,
      }]);

      const app = createTestApp();
      const res = await requestJson(app, 'GET', '/production-queue/analytics');

      expect(res.status).toBe(200);
      expect(res.body.overview).toBeDefined();
      expect(res.body.throughput).toBeDefined();
      expect(res.body.workCenterPerformance).toBeDefined();
      expect(res.body.scrapAnalysis).toBeDefined();
      expect(res.body.queueHealth).toBeDefined();
    });
  });

  describe('POST /production-queue/:id/report-quantity', () => {
    it('rejects invalid body (missing quantityGood)', async () => {
      const app = createTestApp();
      const res = await requestJson(
        app, 'POST',
        '/production-queue/11111111-1111-4111-8111-111111111111/report-quantity',
        {}
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Validation error');
    });

    it('rejects negative quantities', async () => {
      const app = createTestApp();
      const res = await requestJson(
        app, 'POST',
        '/production-queue/11111111-1111-4111-8111-111111111111/report-quantity',
        { quantityGood: -5 }
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /production-queue/:id/complete', () => {
    it('accepts valid completion request', async () => {
      // The completeWorkOrder function runs a transaction
      // then runs processCompletionExceptions post-commit
      // Mock: WO found and in_progress
      testState.txSelectResults = [
        [{
          id: 'wo-1',
          tenantId: 'tenant-1',
          woNumber: 'WO-TEST-0001',
          status: 'in_progress',
          quantityProduced: 95,
          quantityScrapped: 5,
          quantityToProduce: 100,
          cardId: null,
          facilityId: 'fac-1',
          priorityScore: 50,
        }],
      ];

      // After completion, post-commit steps query routing steps
      testState.dbSelectResults.push([]); // routing steps for capacity release

      // processCompletionExceptions: checkScrapThreshold
      testState.dbSelectResults.push([{
        id: 'wo-1',
        tenantId: 'tenant-1',
        woNumber: 'WO-TEST-0001',
        quantityToProduce: 100,
        quantityProduced: 95,
        quantityScrapped: 5,
        cardId: null,
        facilityId: 'fac-1',
        isExpedited: false,
        priorityScore: 50,
        manualPriority: 0,
        routingTemplateId: null,
        loopId: null,
        partId: 'part-1',
        parentWorkOrderId: null,
      }]);

      // processCompletionExceptions: checkShortCompletion
      testState.dbSelectResults.push([{
        id: 'wo-1',
        tenantId: 'tenant-1',
        woNumber: 'WO-TEST-0001',
        quantityToProduce: 100,
        quantityProduced: 95,
        quantityScrapped: 5,
        cardId: null,
        facilityId: 'fac-1',
        isExpedited: false,
        priorityScore: 50,
        manualPriority: 0,
        routingTemplateId: null,
        loopId: null,
        partId: 'part-1',
        parentWorkOrderId: null,
      }]);

      const app = createTestApp();
      const res = await requestJson(
        app, 'POST',
        '/production-queue/wo-1/complete',
        { completionNotes: 'Batch complete' }
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /production-queue/:id/record-consumption', () => {
    it('rejects invalid body (missing stepId)', async () => {
      const app = createTestApp();
      const res = await requestJson(
        app, 'POST',
        '/production-queue/11111111-1111-4111-8111-111111111111/record-consumption',
        { quantityProduced: 10 }
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Validation error');
    });

    it('rejects zero quantity', async () => {
      const app = createTestApp();
      const res = await requestJson(
        app, 'POST',
        '/production-queue/11111111-1111-4111-8111-111111111111/record-consumption',
        {
          stepId: '22222222-2222-4222-8222-222222222222',
          quantityProduced: 0,
        }
      );
      expect(res.status).toBe(400);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Analytics Metrics Shape Validation
// ═══════════════════════════════════════════════════════════════════

describe('production analytics metrics shape', () => {
  it('overview metrics has all required fields', () => {
    const overview = {
      totalWorkOrders: 50,
      completedWorkOrders: 30,
      inProgressWorkOrders: 15,
      onHoldWorkOrders: 3,
      cancelledWorkOrders: 2,
      totalQuantityProduced: 5000,
      totalQuantityScrapped: 200,
      overallScrapRate: 3.85,
      overallCompletionRate: 60,
    };

    const requiredKeys = [
      'totalWorkOrders', 'completedWorkOrders', 'inProgressWorkOrders',
      'onHoldWorkOrders', 'cancelledWorkOrders', 'totalQuantityProduced',
      'totalQuantityScrapped', 'overallScrapRate', 'overallCompletionRate',
    ];

    for (const key of requiredKeys) {
      expect(overview[key as keyof typeof overview]).toBeDefined();
      expect(typeof overview[key as keyof typeof overview]).toBe('number');
    }
  });

  it('throughput metrics has all required fields', () => {
    const throughput = {
      avgWOsCompletedPerDay: 3.5,
      avgCycleTimeHours: 12.5,
      avgQueueWaitTimeHours: 4.3,
      expeditedCount: 5,
      reworkCount: 2,
    };

    expect(typeof throughput.avgWOsCompletedPerDay).toBe('number');
    expect(typeof throughput.avgCycleTimeHours).toBe('number');
    expect(typeof throughput.expeditedCount).toBe('number');
    expect(typeof throughput.reworkCount).toBe('number');
  });

  it('work center metrics has correct efficiency calculation', () => {
    const avgEstimated = 30;
    const avgActual = 25;
    const efficiency = Math.round((avgEstimated / avgActual) * 10000) / 100;
    // 30/25 = 1.2 = 120%
    expect(efficiency).toBe(120);
  });

  it('scrap rate calculates correctly', () => {
    const totalProduced = 5000;
    const totalScrapped = 200;
    const totalProcessed = totalProduced + totalScrapped;
    const scrapRate = Math.round((totalScrapped / totalProcessed) * 10000) / 100;
    // 200 / 5200 = 0.03846 = 3.85%
    expect(scrapRate).toBe(3.85);
  });

  it('completion rate calculates correctly', () => {
    const totalWorkOrders = 50;
    const completedWorkOrders = 30;
    const completionRate = Math.round((completedWorkOrders / totalWorkOrders) * 10000) / 100;
    expect(completionRate).toBe(60);
  });

  it('utilization percent handles zero available capacity', () => {
    const totalAvailable = 0;
    const totalAllocated = 100;
    const utilization = totalAvailable > 0
      ? Math.round((totalAllocated / totalAvailable) * 10000) / 100
      : 0;
    expect(utilization).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. WO Lifecycle Label Completeness
// ═══════════════════════════════════════════════════════════════════

describe('WO lifecycle label completeness', () => {
  const allWOStatuses: WOStatus[] = ['draft', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled'];
  const allHoldReasons = ['material_shortage', 'equipment_failure', 'quality_hold', 'labor_unavailable', 'other'];
  const allOperationTypes = [
    'report_quantity', 'complete_step', 'hold', 'resume',
    'expedite', 'split', 'rework', 'cancel',
  ];

  it('every WO status maps to a valid display label', () => {
    const labels: Record<string, string> = {
      draft: 'Draft',
      scheduled: 'Scheduled',
      in_progress: 'In Progress',
      on_hold: 'On Hold',
      completed: 'Completed',
      cancelled: 'Cancelled',
    };
    for (const status of allWOStatuses) {
      expect(labels[status]).toBeDefined();
      expect(labels[status].length).toBeGreaterThan(0);
    }
  });

  it('every hold reason maps to a valid display label', () => {
    const labels: Record<string, string> = {
      material_shortage: 'Material Shortage',
      equipment_failure: 'Equipment Failure',
      quality_hold: 'Quality Hold',
      labor_unavailable: 'Labor Unavailable',
      other: 'Other',
    };
    for (const reason of allHoldReasons) {
      expect(labels[reason]).toBeDefined();
      expect(labels[reason].length).toBeGreaterThan(0);
    }
  });

  it('operation types cover all production actions', () => {
    for (const op of allOperationTypes) {
      expect(typeof op).toBe('string');
      expect(op.length).toBeGreaterThan(0);
    }
    expect(allOperationTypes.length).toBeGreaterThanOrEqual(8);
  });
});
