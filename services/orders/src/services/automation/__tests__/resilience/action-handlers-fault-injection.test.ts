/**
 * Resilience / Fault-Injection Tests — Action Handlers
 *
 * Ticket #88 — Phase 3: Action handler fault injection
 *
 * Validates system behaviour under:
 * - DB transaction failures during PO creation
 * - DB insert failures during transfer order creation
 * - Event bus publish failures across all handlers
 * - Work order delegation service failures
 * - Exception automation service failures
 * - Card transition DB update failures
 * - Escalation audit + event failures
 * - Multiple action types with cascading faults
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ─────────────────────────────────────────────────

const {
  mockTransaction,
  mockInsert,
  mockUpdate,
  mockPublish,
  mockCreateWorkOrderFromTrigger,
  mockProcessExceptionAutomation,
  mockWriteAuditEntry,
  mockAutoCreateTransferOrder,
} = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockPublish: vi.fn(),
  mockCreateWorkOrderFromTrigger: vi.fn(),
  mockProcessExceptionAutomation: vi.fn(),
  mockWriteAuditEntry: vi.fn(),
  mockAutoCreateTransferOrder: vi.fn(),
}));

// ─── Module mocks ──────────────────────────────────────────────────

vi.mock('@arda/db', () => {
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    execute: mockInsert,
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    execute: mockUpdate,
  };
  return {
    db: {
      transaction: mockTransaction,
      insert: vi.fn(() => insertChain),
      update: vi.fn(() => updateChain),
    },
    schema: {
      purchaseOrders: { id: 'id', poNumber: 'poNumber' },
      purchaseOrderLines: {},
      transferOrders: { id: 'id', toNumber: 'toNumber' },
      kanbanCards: {
        id: 'id',
        tenantId: 'tenantId',
        currentStage: { enumValues: ['created', 'triggered', 'ordered', 'in_transit', 'received', 'restocked'] },
      },
      auditLog: {},
    },
    writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
    writeAuditEntries: vi.fn(async () => []),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
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

vi.mock('../../../work-order-orchestration.service.js', () => ({
  createWorkOrderFromTrigger: mockCreateWorkOrderFromTrigger,
}));

vi.mock('../../../exception-automation.service.js', () => ({
  processExceptionAutomation: mockProcessExceptionAutomation,
}));

vi.mock('../../../kanban-transfer-automation.service.js', () => ({
  autoCreateTransferOrder: mockAutoCreateTransferOrder,
}));

// ─── SUT ────────────────────────────────────────────────────────────

import { dispatchAction } from '../../action-handlers.js';

// ─── Test Helpers ───────────────────────────────────────────────────

function poContext() {
  return {
    tenantId: 'tenant-1',
    cardId: 'card-1',
    loopId: 'loop-1',
    partId: 'part-1',
    supplierId: 'supplier-1',
    facilityId: 'facility-1',
    orderQuantity: 10,
    totalAmount: 500,
    isExpedited: false,
  };
}

function woContext() {
  return {
    tenantId: 'tenant-1',
    cardId: 'card-1',
    loopId: 'loop-1',
    facilityId: 'facility-1',
    partId: 'part-1',
    orderQuantity: 5,
  };
}

function toContext() {
  return {
    tenantId: 'tenant-1',
    cardId: 'card-1',
    loopId: 'loop-1',
    sourceFacilityId: 'facility-src',
    destFacilityId: 'facility-dst',
    orderQuantity: 20,
  };
}

function emailContext() {
  return {
    tenantId: 'tenant-1',
    poId: 'po-1',
    supplierId: 'supplier-1',
    supplierEmail: 'vendor@example.com',
    totalAmount: 1200,
  };
}

function cardTransitionContext() {
  return {
    tenantId: 'tenant-1',
    cardId: 'card-1',
    loopId: 'loop-1',
    fromStage: 'triggered',
    toStage: 'ordered',
    cycleNumber: 1,
  };
}

function exceptionContext() {
  return {
    tenantId: 'tenant-1',
    exceptionId: 'exc-1',
    exceptionType: 'missing_part',
    severity: 'high',
    resolutionType: 'auto_resolve',
  };
}

function escalateParams() {
  return {
    tenantId: 'tenant-1',
    reason: 'Action failed: create_purchase_order',
    entityType: 'automation_job',
    entityId: 'key-123',
  };
}

// ─── Shared Setup ───────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path stubs
  mockPublish.mockResolvedValue(undefined);
  mockInsert.mockResolvedValue([{ id: 'po-1', poNumber: 'PO-AUTO-TEST' }]);
  mockUpdate.mockResolvedValue([{ id: 'card-1' }]);
  mockWriteAuditEntry.mockResolvedValue({ id: 'audit-1', hashChain: 'test-hash', sequenceNumber: 1 });
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const txInsertChain = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([{ id: 'po-1', poNumber: 'PO-AUTO-TEST' }]),
    };
    const txAuditChain = {
      values: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue(undefined),
    };
    const tx = {
      insert: vi.fn()
        .mockReturnValueOnce(txInsertChain)   // PO insert
        .mockReturnValueOnce(txInsertChain)   // PO line insert
        .mockReturnValueOnce(txAuditChain),   // audit log insert
    };
    return fn(tx);
  });
  mockCreateWorkOrderFromTrigger.mockResolvedValue({
    workOrderId: 'wo-1',
    woNumber: 'WO-001',
    alreadyExisted: false,
  });
  mockProcessExceptionAutomation.mockResolvedValue({
    success: true,
    action: 'auto_resolve',
    detail: 'Resolved automatically',
  });
  mockAutoCreateTransferOrder.mockResolvedValue({
    transferOrderId: 'to-1',
    toNumber: 'TO-AUTO-TEST',
    cardId: 'card-1',
    loopId: 'loop-1',
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════════

describe('Action Handlers — Fault Injection', () => {

  // ─── 1. DB Transaction Failures in PO Creation ─────────────────────

  describe('PO creation — DB transaction failures', () => {
    it('returns failure when db.transaction throws ECONNREFUSED', async () => {
      mockTransaction.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      const result = await dispatchAction('create_purchase_order', poContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('returns failure when PO insert inside transaction throws unique violation', async () => {
      mockTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn(() => ({
              returning: vi.fn(() => ({
                execute: vi.fn().mockRejectedValueOnce(
                  new Error('duplicate key value violates unique constraint "purchase_orders_po_number_unique"'),
                ),
              })),
            })),
          })),
        };
        return fn(tx);
      });

      const result = await dispatchAction('create_purchase_order', poContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('duplicate key');
    });

    it('returns failure when PO line insert inside transaction fails', async () => {
      mockTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
        let callCount = 0;
        const tx = {
          insert: vi.fn(() => {
            callCount++;
            if (callCount === 1) {
              // PO insert succeeds
              return {
                values: vi.fn(() => ({
                  returning: vi.fn(() => ({
                    execute: vi.fn().mockResolvedValue([{ id: 'po-1', poNumber: 'PO-AUTO-TEST' }]),
                  })),
                })),
              };
            }
            // PO line insert fails
            return {
              values: vi.fn(() => ({
                execute: vi.fn().mockRejectedValueOnce(new Error('foreign key constraint')),
              })),
            };
          }),
        };
        return fn(tx);
      });

      const result = await dispatchAction('create_purchase_order', poContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('foreign key constraint');
    });

    it('returns failure when transaction times out', async () => {
      mockTransaction.mockRejectedValueOnce(new Error('query timeout exceeded'));

      const result = await dispatchAction('create_purchase_order', poContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('returns failure when event bus publish fails after PO creation succeeds', async () => {
      mockPublish.mockRejectedValueOnce(new Error('Redis ECONNREFUSED'));

      const result = await dispatchAction('create_purchase_order', poContext());

      // The PO was created in the transaction, but event publish failed.
      // The handler catches all errors and returns failure.
      expect(result.success).toBe(false);
      expect(result.error).toContain('Redis ECONNREFUSED');
    });
  });

  // ─── 2. Transfer Order Creation Failures ───────────────────────────

  describe('Transfer order creation — service delegation failures', () => {
    it('returns failure when autoCreateTransferOrder throws ECONNREFUSED', async () => {
      mockAutoCreateTransferOrder.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      const result = await dispatchAction('create_transfer_order', toContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('returns failure when autoCreateTransferOrder returns undefined', async () => {
      mockAutoCreateTransferOrder.mockResolvedValueOnce(undefined);

      const result = await dispatchAction('create_transfer_order', toContext());

      // Accessing .transferOrderId on undefined throws TypeError
      expect(result.success).toBe(false);
    });

    it('returns failure when autoCreateTransferOrder throws card not found', async () => {
      mockAutoCreateTransferOrder.mockRejectedValueOnce(new Error('Kanban card card-1 not found'));

      const result = await dispatchAction('create_transfer_order', toContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  // ─── 3. Event Bus Publish Failures ─────────────────────────────────

  describe('Event bus failures across handlers', () => {
    it('dispatch_email fails when event bus is unreachable', async () => {
      mockPublish.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await dispatchAction('dispatch_email', emailContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('add_to_shopping_list fails when event bus times out', async () => {
      mockPublish.mockRejectedValueOnce(new Error('publish timeout'));

      const result = await dispatchAction('add_to_shopping_list', {
        tenantId: 'tenant-1',
        partId: 'part-1',
        quantity: 10,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('publish timeout');
    });

    it('transition_card DB update succeeds but event publish fails', async () => {
      mockUpdate.mockResolvedValueOnce([{ id: 'card-1' }]);
      mockPublish.mockRejectedValueOnce(new Error('Redis cluster failover'));

      const result = await dispatchAction('transition_card', cardTransitionContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('Redis cluster failover');
    });

    it('escalate handler fails when both audit insert and event bus fail', async () => {
      mockWriteAuditEntry.mockRejectedValueOnce(new Error('DB connection pool exhausted'));

      const result = await dispatchAction('escalate', escalateParams());

      expect(result.success).toBe(false);
      expect(result.error).toContain('connection pool');
    });
  });

  // ─── 4. Work Order Delegation Failures ─────────────────────────────

  describe('Work order creation — delegation failures', () => {
    it('returns failure when createWorkOrderFromTrigger throws', async () => {
      mockCreateWorkOrderFromTrigger.mockRejectedValueOnce(
        new Error('WO orchestration service unavailable'),
      );

      const result = await dispatchAction('create_work_order', woContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('WO orchestration service unavailable');
    });

    it('returns failure when createWorkOrderFromTrigger returns undefined', async () => {
      mockCreateWorkOrderFromTrigger.mockResolvedValueOnce(undefined);

      const result = await dispatchAction('create_work_order', woContext());

      // Accessing .workOrderId on undefined throws TypeError
      expect(result.success).toBe(false);
    });

    it('returns failure when delegation times out', async () => {
      mockCreateWorkOrderFromTrigger.mockRejectedValueOnce(
        new Error('operation timed out after 30000ms'),
      );

      const result = await dispatchAction('create_work_order', woContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });
  });

  // ─── 5. Exception Automation Failures ──────────────────────────────

  describe('Exception resolution — automation failures', () => {
    it('returns failure when processExceptionAutomation throws', async () => {
      mockProcessExceptionAutomation.mockRejectedValueOnce(
        new Error('exception service crashed'),
      );

      const result = await dispatchAction('resolve_exception', exceptionContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('exception service crashed');
    });

    it('returns failure status from automation service', async () => {
      mockProcessExceptionAutomation.mockResolvedValueOnce({
        success: false,
        action: 'escalate',
        detail: 'No automated resolution available',
      });

      const result = await dispatchAction('resolve_exception', exceptionContext());

      expect(result.success).toBe(false);
    });

    it('returns failure when exception service returns undefined', async () => {
      mockProcessExceptionAutomation.mockResolvedValueOnce(undefined);

      const result = await dispatchAction('resolve_exception', exceptionContext());

      // Accessing .success on undefined throws TypeError
      expect(result.success).toBe(false);
    });
  });

  // ─── 6. Card Transition DB Failures ────────────────────────────────

  describe('Card transition — DB update failures', () => {
    it('returns failure when db.update throws', async () => {
      mockUpdate.mockRejectedValueOnce(new Error('deadlock detected'));

      const result = await dispatchAction('transition_card', cardTransitionContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('deadlock');
    });

    it('returns failure when db.update connection is refused', async () => {
      mockUpdate.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      const result = await dispatchAction('transition_card', cardTransitionContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });
  });

  // ─── 7. Escalation Handler Failures ────────────────────────────────

  describe('Escalation — compound failures', () => {
    it('returns failure when audit log insert fails before event publish', async () => {
      mockWriteAuditEntry.mockRejectedValueOnce(new Error('relation "audit_log" does not exist'));

      const result = await dispatchAction('escalate', escalateParams());

      expect(result.success).toBe(false);
      expect(result.error).toContain('audit_log');
    });

    it('returns failure when event bus publish fails after successful audit', async () => {
      mockPublish.mockRejectedValueOnce(new Error('publish rejected'));

      const result = await dispatchAction('escalate', escalateParams());

      expect(result.success).toBe(false);
      expect(result.error).toContain('publish rejected');
    });
  });

  // ─── 8. Multiple Action Types — Cascading Faults ───────────────────

  describe('Cascading faults across action types', () => {
    it('all event-only actions fail when event bus is down', async () => {
      // email, shopping list, and shopping list all only use event bus
      const eventBusError = new Error('event bus cluster down');

      mockPublish.mockRejectedValue(eventBusError);

      const emailResult = await dispatchAction('dispatch_email', emailContext());
      const shoppingResult = await dispatchAction('add_to_shopping_list', {
        tenantId: 'tenant-1',
        partId: 'part-1',
        quantity: 5,
      });

      expect(emailResult.success).toBe(false);
      expect(shoppingResult.success).toBe(false);

      // Reset for later tests
      mockPublish.mockResolvedValue(undefined);
    });

    it('DB-dependent actions fail when database is down', async () => {
      const dbError = new Error('connect ECONNREFUSED 127.0.0.1:5432');

      mockTransaction.mockRejectedValue(dbError);
      mockInsert.mockRejectedValue(dbError);
      mockUpdate.mockRejectedValue(dbError);
      mockWriteAuditEntry.mockRejectedValue(dbError);
      mockAutoCreateTransferOrder.mockRejectedValue(dbError);

      const poResult = await dispatchAction('create_purchase_order', poContext());
      const toResult = await dispatchAction('create_transfer_order', toContext());
      const cardResult = await dispatchAction('transition_card', cardTransitionContext());
      const escalateResult = await dispatchAction('escalate', escalateParams());

      expect(poResult.success).toBe(false);
      expect(toResult.success).toBe(false);
      expect(cardResult.success).toBe(false);
      expect(escalateResult.success).toBe(false);

      // Reset for later tests
      mockTransaction.mockReset();
      mockInsert.mockReset();
      mockUpdate.mockReset();
      mockWriteAuditEntry.mockReset();
      mockAutoCreateTransferOrder.mockReset();
    });

    it('external service actions fail when services are unavailable', async () => {
      const serviceError = new Error('service unavailable');

      mockCreateWorkOrderFromTrigger.mockRejectedValueOnce(serviceError);
      mockProcessExceptionAutomation.mockRejectedValueOnce(serviceError);

      const woResult = await dispatchAction('create_work_order', woContext());
      const excResult = await dispatchAction('resolve_exception', exceptionContext());

      expect(woResult.success).toBe(false);
      expect(excResult.success).toBe(false);
    });

    it('successful actions return expected data shapes', async () => {
      // Reset to happy path
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txChain = {
          values: vi.fn().mockReturnThis(),
          returning: vi.fn().mockReturnThis(),
          execute: vi.fn().mockResolvedValue([{ id: 'po-1', poNumber: 'PO-AUTO-TEST' }]),
        };
        const tx = {
          insert: vi.fn(() => txChain),
        };
        return fn(tx);
      });

      const poResult = await dispatchAction('create_purchase_order', poContext());

      expect(poResult.success).toBe(true);
      expect(poResult.data).toHaveProperty('purchaseOrderId');
      expect(poResult.data).toHaveProperty('poNumber');
    });
  });
});
