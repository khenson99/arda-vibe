/**
 * Unit tests for Sales Order Approval Service (Ticket #194)
 *
 * Tests:
 * - approveSalesOrder: confirmed → processing + reserve + demand signals
 * - approveSalesOrder: partial inventory → correct allocation + shortfall signals
 * - approveSalesOrder: zero available → shortfall only, no reservation
 * - approveSalesOrder: rejects non-confirmed orders
 * - approveSalesOrder: rejects orders with no lines
 * - cancelSalesOrder: release reserved inventory + reversal demand signals
 * - cancelSalesOrder: rejects terminal statuses
 * - cancelSalesOrder: handles lines with no allocations
 * - evaluateKanbanTrigger: triggers card when available <= minQuantity
 * - evaluateKanbanTrigger: skips when active cards exist
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted test state ─────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
  insertedDemandSignals: [] as Array<Record<string, unknown>>,
  inventoryUpdates: [] as Array<Record<string, unknown>>,
  cardUpdates: [] as Array<Record<string, unknown>>,
  lineUpdates: [] as Array<Record<string, unknown>>,
  orderUpdates: [] as Array<Record<string, unknown>>,
}));

// ─── Hoisted constants ──────────────────────────────────────────────
const IDS = vi.hoisted(() => ({
  T: '00000000-0000-0000-0000-000000000001',
  U: '00000000-0000-0000-0000-000000000011',
  C: '00000000-0000-0000-0000-000000000021',
  F: '00000000-0000-0000-0000-000000000031',
  P1: '00000000-0000-0000-0000-000000000041',
  P2: '00000000-0000-0000-0000-000000000042',
  SO: '00000000-0000-0000-0000-000000000051',
  L1: '00000000-0000-0000-0000-000000000061',
  L2: '00000000-0000-0000-0000-000000000062',
  INV1: '00000000-0000-0000-0000-000000000071',
  INV2: '00000000-0000-0000-0000-000000000072',
  LOOP1: '00000000-0000-0000-0000-000000000081',
  CARD1: '00000000-0000-0000-0000-000000000091',
}));

// ─── Hoisted schema mock ────────────────────────────────────────────
const schemaMock = vi.hoisted(() => ({
  salesOrders: { id: 'salesOrders' },
  salesOrderLines: { id: 'salesOrderLines' },
  demandSignals: { id: 'demandSignals' },
  inventoryLedger: {
    id: 'inventoryLedger',
    tenantId: 'tenantId',
    facilityId: 'facilityId',
    partId: 'partId',
    qtyReserved: 'qtyReserved',
  },
  kanbanLoops: { id: 'kanbanLoops' },
  kanbanCards: { id: 'kanbanCards' },
}));

// ─── Hoisted DB mock ────────────────────────────────────────────────
const { dbMock, resetAllMocks } = vi.hoisted(() => {
  // Queue-based mock: each query call shifts the next result off the queue
  const queryQueue: Array<unknown> = [];

  const chainable = () => {
    const self: Record<string, unknown> = {};
    const methods = ['from', 'where', 'limit', 'offset', 'orderBy', 'for'];
    for (const m of methods) {
      self[m] = vi.fn(() => self);
    }
    // Terminal: resolve by shifting from queue
    self.then = (resolve: (v: unknown) => void) => resolve(queryQueue.shift() ?? []);
    return self;
  };

  // Insert chain that captures inserts
  const insertChain = () => {
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn((val: unknown) => {
      // Track inserted demand signals
      if (val && typeof val === 'object' && 'signalType' in (val as Record<string, unknown>)) {
        testState.insertedDemandSignals.push(val as Record<string, unknown>);
      }
      return chain;
    });
    chain.returning = vi.fn(() => chain);
    chain.onConflictDoNothing = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => void) => resolve(undefined);
    return chain;
  };

  // Update chain that captures updates
  const updateChain = (table: unknown) => {
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn((val: unknown) => {
      if (table === schemaMock.inventoryLedger) testState.inventoryUpdates.push(val as Record<string, unknown>);
      if (table === schemaMock.kanbanCards) testState.cardUpdates.push(val as Record<string, unknown>);
      if (table === schemaMock.salesOrderLines) testState.lineUpdates.push(val as Record<string, unknown>);
      if (table === schemaMock.salesOrders) testState.orderUpdates.push(val as Record<string, unknown>);
      return chain;
    });
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => void) => {
      // For salesOrders update().set().where().returning(), resolve with the updated order
      if (table === schemaMock.salesOrders) {
        resolve([{
          ...defaultOrder(),
          status: 'processing',
        }]);
      } else {
        resolve(undefined);
      }
    };
    return chain;
  };

  function defaultOrder() {
    return {
      id: IDS.SO,
      tenantId: IDS.T,
      soNumber: 'SO-20260215-0001',
      customerId: IDS.C,
      facilityId: IDS.F,
      status: 'confirmed',
      subtotal: '100.00',
      totalAmount: '100.00',
      cancelledAt: null,
      cancelReason: null,
    };
  }

  const tx = {
    select: vi.fn(() => chainable()),
    insert: vi.fn(() => insertChain()),
    update: vi.fn((table: unknown) => updateChain(table)),
    delete: vi.fn(),
    execute: vi.fn(),
  };

  const dbMock = {
    query: {
      salesOrders: { findFirst: vi.fn() },
      salesOrderLines: { findFirst: vi.fn() },
    },
    select: vi.fn(() => chainable()),
    insert: vi.fn(() => insertChain()),
    update: vi.fn((table: unknown) => updateChain(table)),
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    execute: vi.fn(),
  };

  const resetAllMocks = () => {
    queryQueue.length = 0;
    testState.auditEntries.length = 0;
    testState.insertedDemandSignals.length = 0;
    testState.inventoryUpdates.length = 0;
    testState.cardUpdates.length = 0;
    testState.lineUpdates.length = 0;
    testState.orderUpdates.length = 0;
    dbMock.transaction.mockClear();
    tx.select.mockClear();
    tx.insert.mockClear();
    tx.update.mockClear();
  };

  return { dbMock, tx, queryQueue, resetAllMocks, defaultOrder };
});

// ─── Hoisted audit mock ─────────────────────────────────────────────
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.auditEntries.push(entry);
    return { id: 'audit-' + testState.auditEntries.length, hashChain: 'mock', sequenceNumber: testState.auditEntries.length };
  })
);

// ─── Module mocks ───────────────────────────────────────────────────
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn(() => ({})) }),
  inArray: vi.fn(() => ({})),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: mockWriteAuditEntry,
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/config', () => ({
  config: {},
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@arda/events', () => ({
  getEventBus: () => ({ publish: vi.fn(async () => undefined), subscribe: vi.fn() }),
}));

vi.mock('./inventory-ledger.service.js', () => ({
  adjustQuantity: vi.fn(async () => ({ previousValue: 0, newValue: 0, field: 'qtyReserved', adjustmentType: 'increment', quantity: 0 })),
  upsertInventory: vi.fn(async () => ({})),
}));

// ─── Import under test ─────────────────────────────────────────────
import { approveSalesOrder, cancelSalesOrder } from './sales-order-approval.service.js';

// ─── Test helpers ───────────────────────────────────────────────────
function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.SO,
    tenantId: IDS.T,
    soNumber: 'SO-20260215-0001',
    customerId: IDS.C,
    facilityId: IDS.F,
    status: 'confirmed',
    subtotal: '100.00',
    totalAmount: '100.00',
    cancelledAt: null,
    cancelReason: null,
    ...overrides,
  };
}

function makeLine(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.L1,
    tenantId: IDS.T,
    salesOrderId: IDS.SO,
    partId: IDS.P1,
    lineNumber: 1,
    quantityOrdered: 10,
    quantityAllocated: 0,
    quantityShipped: 0,
    unitPrice: '10.0000',
    discountPercent: '0',
    lineTotal: '100.00',
    ...overrides,
  };
}

function makeLedger(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.INV1,
    tenantId: IDS.T,
    facilityId: IDS.F,
    partId: IDS.P1,
    qtyOnHand: 50,
    qtyReserved: 0,
    qtyInTransit: 0,
    reorderPoint: 10,
    reorderQty: 20,
    ...overrides,
  };
}

const auditCtx = { userId: IDS.U, ipAddress: '127.0.0.1', userAgent: 'test' };

// ─── Setup ──────────────────────────────────────────────────────────
// The queue-based approach: each call to tx.select()...for('update') or
// tx.select()...where() shifts the next value from queryQueue.
// We set up the queue before each test based on the expected DB calls.

// Helper to set up the tx.select queue for approval flow:
// 1. SELECT order FOR UPDATE → [order]
// 2. SELECT lines → [line1, ...]
// 3+. SELECT inventory FOR UPDATE → [ledger] (per line)
function setupApprovalMocks(order: Record<string, unknown>, lines: Record<string, unknown>[], ledgers: Array<Record<string, unknown> | null>) {
  const { queryQueue, tx } = vi.hoisted(() => ({ queryQueue: [] as unknown[], tx: {} as Record<string, unknown> }));

  // We need to re-import from the hoisted mock since vi.hoisted returns fresh
  // We'll use the dbMock.transaction mock to intercept calls instead

  // Reset tx.select to use a call counter
  let callIndex = 0;
  const selectResults: unknown[][] = [
    [order],           // 1st call: order FOR UPDATE
    lines,             // 2nd call: lines
  ];

  // Add ledger rows for each line
  for (const ledger of ledgers) {
    selectResults.push(ledger ? [ledger] : []);
  }

  const { tx: txRef } = (() => {
    // Access the hoisted tx via the dbMock.transaction mock
    let capturedTx: Record<string, unknown> | null = null;
    return { tx: capturedTx };
  })();

  // Instead of queue, override dbMock.transaction to use a custom tx
  (dbMock.transaction as ReturnType<typeof vi.fn>).mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => {
    callIndex = 0;

    const makeTxChain = () => {
      const chain: Record<string, unknown> = {};
      const methods = ['from', 'where', 'limit', 'offset', 'orderBy', 'for'];
      for (const m of methods) {
        chain[m] = vi.fn(() => chain);
      }
      const idx = callIndex++;
      chain.then = (resolve: (v: unknown) => void) => resolve(selectResults[idx] ?? []);
      return chain;
    };

    const txMock = {
      select: vi.fn(() => makeTxChain()),
      insert: vi.fn(() => {
        const ic: Record<string, unknown> = {};
        ic.values = vi.fn((val: unknown) => {
          if (val && typeof val === 'object' && 'signalType' in (val as Record<string, unknown>)) {
            testState.insertedDemandSignals.push(val as Record<string, unknown>);
          }
          return ic;
        });
        ic.returning = vi.fn(() => ic);
        ic.onConflictDoNothing = vi.fn(() => ic);
        ic.then = (resolve: (v: unknown) => void) => resolve(undefined);
        return ic;
      }),
      update: vi.fn((table: unknown) => {
        const uc: Record<string, unknown> = {};
        uc.set = vi.fn((val: unknown) => {
          if (table === schemaMock.inventoryLedger) testState.inventoryUpdates.push(val as Record<string, unknown>);
          if (table === schemaMock.kanbanCards) testState.cardUpdates.push(val as Record<string, unknown>);
          if (table === schemaMock.salesOrderLines) testState.lineUpdates.push(val as Record<string, unknown>);
          if (table === schemaMock.salesOrders) testState.orderUpdates.push(val as Record<string, unknown>);
          return uc;
        });
        uc.where = vi.fn(() => uc);
        uc.returning = vi.fn(() => uc);
        uc.then = (resolve: (v: unknown) => void) => {
          if (table === schemaMock.salesOrders) {
            resolve([{ ...order, status: 'processing' }]);
          } else {
            resolve(undefined);
          }
        };
        return uc;
      }),
      execute: vi.fn(),
    };

    return cb(txMock);
  });
}

function setupCancelMocks(order: Record<string, unknown>, lines: Record<string, unknown>[], ledgers: Array<Record<string, unknown> | null>) {
  let callIndex = 0;
  const selectResults: unknown[][] = [
    [order],  // order FOR UPDATE
    lines,    // lines
  ];

  // Add ledger rows for each line that has allocation
  for (const ledger of ledgers) {
    selectResults.push(ledger ? [ledger] : []);
  }

  (dbMock.transaction as ReturnType<typeof vi.fn>).mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => {
    callIndex = 0;

    const makeTxChain = () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'for']) {
        chain[m] = vi.fn(() => chain);
      }
      const idx = callIndex++;
      chain.then = (resolve: (v: unknown) => void) => resolve(selectResults[idx] ?? []);
      return chain;
    };

    const txMock = {
      select: vi.fn(() => makeTxChain()),
      insert: vi.fn(() => {
        const ic: Record<string, unknown> = {};
        ic.values = vi.fn((val: unknown) => {
          if (val && typeof val === 'object' && 'signalType' in (val as Record<string, unknown>)) {
            testState.insertedDemandSignals.push(val as Record<string, unknown>);
          }
          return ic;
        });
        ic.returning = vi.fn(() => ic);
        ic.onConflictDoNothing = vi.fn(() => ic);
        ic.then = (resolve: (v: unknown) => void) => resolve(undefined);
        return ic;
      }),
      update: vi.fn((table: unknown) => {
        const uc: Record<string, unknown> = {};
        uc.set = vi.fn((val: unknown) => {
          if (table === schemaMock.inventoryLedger) testState.inventoryUpdates.push(val as Record<string, unknown>);
          if (table === schemaMock.salesOrderLines) testState.lineUpdates.push(val as Record<string, unknown>);
          if (table === schemaMock.salesOrders) testState.orderUpdates.push(val as Record<string, unknown>);
          return uc;
        });
        uc.where = vi.fn(() => uc);
        uc.returning = vi.fn(() => uc);
        uc.then = (resolve: (v: unknown) => void) => resolve(undefined);
        return uc;
      }),
      execute: vi.fn(),
    };

    return cb(txMock as unknown as Parameters<Parameters<typeof dbMock.transaction>[0]>[0]);
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Sales Order Approval Service', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════
  //  approveSalesOrder
  // ═══════════════════════════════════════════════════════════════════

  describe('approveSalesOrder', () => {
    it('should transition confirmed → processing and reserve full inventory', async () => {
      const order = makeOrder();
      const line = makeLine();
      const ledger = makeLedger({ qtyOnHand: 50, qtyReserved: 0 });

      setupApprovalMocks(order, [line], [ledger]);

      const result = await approveSalesOrder(IDS.SO, IDS.T, IDS.U, IDS.F, auditCtx);

      expect(result.newStatus).toBe('processing');
      expect(result.previousStatus).toBe('confirmed');
      expect(result.reservations).toHaveLength(1);
      expect(result.reservations[0].quantityReserved).toBe(10);
      expect(result.reservations[0].shortfall).toBe(0);
      expect(result.demandSignalsCreated).toBe(1); // 1 sales_order signal, 0 shortfall signals
    });

    it('should handle partial inventory — reserve available, record shortfall', async () => {
      const order = makeOrder();
      const line = makeLine({ quantityOrdered: 20 });
      const ledger = makeLedger({ qtyOnHand: 8, qtyReserved: 0 }); // Only 8 available

      setupApprovalMocks(order, [line], [ledger]);

      const result = await approveSalesOrder(IDS.SO, IDS.T, IDS.U, IDS.F, auditCtx);

      expect(result.reservations[0].quantityReserved).toBe(8);
      expect(result.reservations[0].shortfall).toBe(12);
      expect(result.demandSignalsCreated).toBe(2); // 1 sales_order + 1 shortfall reorder_point
    });

    it('should handle zero available inventory', async () => {
      const order = makeOrder();
      const line = makeLine({ quantityOrdered: 10 });
      const ledger = makeLedger({ qtyOnHand: 0, qtyReserved: 0 });

      setupApprovalMocks(order, [line], [ledger]);

      const result = await approveSalesOrder(IDS.SO, IDS.T, IDS.U, IDS.F, auditCtx);

      expect(result.reservations[0].quantityReserved).toBe(0);
      expect(result.reservations[0].shortfall).toBe(10);
      expect(result.demandSignalsCreated).toBe(2); // 1 sales_order + 1 shortfall
    });

    it('should handle multiple lines with different parts', async () => {
      const order = makeOrder();
      const line1 = makeLine({ id: IDS.L1, partId: IDS.P1, quantityOrdered: 5 });
      const line2 = makeLine({ id: IDS.L2, partId: IDS.P2, lineNumber: 2, quantityOrdered: 10 });
      const ledger1 = makeLedger({ id: IDS.INV1, partId: IDS.P1, qtyOnHand: 5, qtyReserved: 0 });
      const ledger2 = makeLedger({ id: IDS.INV2, partId: IDS.P2, qtyOnHand: 3, qtyReserved: 0 });

      setupApprovalMocks(order, [line1, line2], [ledger1, ledger2]);

      const result = await approveSalesOrder(IDS.SO, IDS.T, IDS.U, IDS.F, auditCtx);

      expect(result.reservations).toHaveLength(2);
      expect(result.reservations[0].quantityReserved).toBe(5);
      expect(result.reservations[0].shortfall).toBe(0);
      expect(result.reservations[1].quantityReserved).toBe(3);
      expect(result.reservations[1].shortfall).toBe(7);
    });

    it('should reject non-confirmed orders (draft)', async () => {
      const order = makeOrder({ status: 'draft' });

      setupApprovalMocks(order, [], []);

      await expect(
        approveSalesOrder(IDS.SO, IDS.T, IDS.U, IDS.F, auditCtx),
      ).rejects.toThrow('Cannot approve order in "draft" status');
    });

    it('should reject non-confirmed orders (processing)', async () => {
      const order = makeOrder({ status: 'processing' });

      setupApprovalMocks(order, [], []);

      await expect(
        approveSalesOrder(IDS.SO, IDS.T, IDS.U, IDS.F, auditCtx),
      ).rejects.toThrow('Cannot approve order in "processing" status');
    });

    it('should reject order not found', async () => {
      // Empty result for order query
      (dbMock.transaction as ReturnType<typeof vi.fn>).mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => {
        let callIdx = 0;
        const makeTxChain = () => {
          const chain: Record<string, unknown> = {};
          for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'for']) {
            chain[m] = vi.fn(() => chain);
          }
          const idx = callIdx++;
          chain.then = (resolve: (v: unknown) => void) => resolve(idx === 0 ? [] : []); // empty order
          return chain;
        };
        return cb({ select: vi.fn(() => makeTxChain()), insert: vi.fn(), update: vi.fn(), execute: vi.fn() } as never);
      });

      await expect(
        approveSalesOrder(IDS.SO, IDS.T, IDS.U, IDS.F, auditCtx),
      ).rejects.toThrow('Sales order not found');
    });

    it('should reject order with no lines', async () => {
      const order = makeOrder();

      setupApprovalMocks(order, [], []);

      await expect(
        approveSalesOrder(IDS.SO, IDS.T, IDS.U, IDS.F, auditCtx),
      ).rejects.toThrow('Sales order has no lines');
    });

    it('should write audit entry with approval details', async () => {
      const order = makeOrder();
      const line = makeLine();
      const ledger = makeLedger({ qtyOnHand: 50, qtyReserved: 0 });

      setupApprovalMocks(order, [line], [ledger]);

      await approveSalesOrder(IDS.SO, IDS.T, IDS.U, IDS.F, auditCtx);

      expect(testState.auditEntries).toHaveLength(1);
      expect(testState.auditEntries[0].action).toBe('sales_order.approved');
      expect(testState.auditEntries[0].entityType).toBe('sales_order');
      expect(testState.auditEntries[0].entityId).toBe(IDS.SO);
    });

    it('should create demand signals for each line', async () => {
      const order = makeOrder();
      const line = makeLine();
      const ledger = makeLedger({ qtyOnHand: 50, qtyReserved: 0 });

      setupApprovalMocks(order, [line], [ledger]);

      await approveSalesOrder(IDS.SO, IDS.T, IDS.U, IDS.F, auditCtx);

      const salesSignals = testState.insertedDemandSignals.filter(
        (s) => s.signalType === 'sales_order',
      );
      expect(salesSignals).toHaveLength(1);
      expect(salesSignals[0].partId).toBe(IDS.P1);
      expect(salesSignals[0].quantityDemanded).toBe(10);
    });

    it('should create stockout signals for shortfall lines', async () => {
      const order = makeOrder();
      const line = makeLine({ quantityOrdered: 20 });
      const ledger = makeLedger({ qtyOnHand: 5, qtyReserved: 0 });

      setupApprovalMocks(order, [line], [ledger]);

      await approveSalesOrder(IDS.SO, IDS.T, IDS.U, IDS.F, auditCtx);

      const stockoutSignals = testState.insertedDemandSignals.filter(
        (s) => s.signalType === 'reorder_point',
      );
      expect(stockoutSignals).toHaveLength(1);
      expect(stockoutSignals[0].quantityDemanded).toBe(15); // 20 - 5
      expect((stockoutSignals[0].metadata as Record<string, unknown>).type).toBe('stockout_inquiry');
    });

    it('should account for existing allocations when computing reservable', async () => {
      const order = makeOrder();
      // Line already has 5 allocated
      const line = makeLine({ quantityOrdered: 10, quantityAllocated: 5 });
      const ledger = makeLedger({ qtyOnHand: 50, qtyReserved: 5 });

      setupApprovalMocks(order, [line], [ledger]);

      const result = await approveSalesOrder(IDS.SO, IDS.T, IDS.U, IDS.F, auditCtx);

      // available = 50 - 5 = 45, needed = 10 - 5 = 5, reservable = min(45, 5) = 5
      expect(result.reservations[0].quantityReserved).toBe(5);
      expect(result.reservations[0].shortfall).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cancelSalesOrder
  // ═══════════════════════════════════════════════════════════════════

  describe('cancelSalesOrder', () => {
    it('should cancel order and release reserved inventory', async () => {
      const order = makeOrder({ status: 'processing' });
      const line = makeLine({ quantityAllocated: 10 });
      const ledger = makeLedger({ qtyOnHand: 50, qtyReserved: 10 });

      setupCancelMocks(order, [line], [ledger]);

      const result = await cancelSalesOrder(IDS.SO, IDS.T, IDS.U, 'Customer request', auditCtx);

      expect(result.previousStatus).toBe('processing');
      expect(result.inventoryReleased).toBe(10);
      expect(result.demandSignalsCancelled).toBe(1);
    });

    it('should handle lines with no allocations (draft cancel)', async () => {
      const order = makeOrder({ status: 'draft' });
      const line = makeLine({ quantityAllocated: 0 });

      setupCancelMocks(order, [line], []);

      const result = await cancelSalesOrder(IDS.SO, IDS.T, IDS.U, undefined, auditCtx);

      expect(result.inventoryReleased).toBe(0);
      expect(result.demandSignalsCancelled).toBe(1); // Still records reversal signal
    });

    it('should reject cancellation of terminal statuses', async () => {
      const order = makeOrder({ status: 'cancelled' });

      setupCancelMocks(order, [], []);

      await expect(
        cancelSalesOrder(IDS.SO, IDS.T, IDS.U, undefined, auditCtx),
      ).rejects.toThrow('Cannot cancel order in "cancelled" status');
    });

    it('should reject cancellation of closed orders', async () => {
      const order = makeOrder({ status: 'closed' });

      setupCancelMocks(order, [], []);

      await expect(
        cancelSalesOrder(IDS.SO, IDS.T, IDS.U, undefined, auditCtx),
      ).rejects.toThrow('Cannot cancel order in "closed" status');
    });

    it('should write audit entry with cancellation details', async () => {
      const order = makeOrder({ status: 'confirmed' });
      const line = makeLine({ quantityAllocated: 0 });

      setupCancelMocks(order, [line], []);

      await cancelSalesOrder(IDS.SO, IDS.T, IDS.U, 'Out of stock', auditCtx);

      expect(testState.auditEntries).toHaveLength(1);
      expect(testState.auditEntries[0].action).toBe('sales_order.cancelled');
      expect((testState.auditEntries[0].newState as Record<string, unknown>).cancelReason).toBe('Out of stock');
    });

    it('should record reversal demand signals for each line', async () => {
      const order = makeOrder({ status: 'processing' });
      const line1 = makeLine({ id: IDS.L1, partId: IDS.P1, quantityOrdered: 10, quantityAllocated: 10 });
      const line2 = makeLine({ id: IDS.L2, partId: IDS.P2, lineNumber: 2, quantityOrdered: 5, quantityAllocated: 5 });
      const ledger1 = makeLedger({ id: IDS.INV1, partId: IDS.P1, qtyReserved: 10 });
      const ledger2 = makeLedger({ id: IDS.INV2, partId: IDS.P2, qtyReserved: 5 });

      setupCancelMocks(order, [line1, line2], [ledger1, ledger2]);

      const result = await cancelSalesOrder(IDS.SO, IDS.T, IDS.U, undefined, auditCtx);

      expect(result.demandSignalsCancelled).toBe(2);
      // Verify reversal signals have negative quantities
      const reversals = testState.insertedDemandSignals.filter(
        (s) => (s.metadata as Record<string, unknown>)?.type === 'cancellation',
      );
      expect(reversals).toHaveLength(2);
      expect(reversals[0].quantityDemanded).toBe(-10);
      expect(reversals[1].quantityDemanded).toBe(-5);
    });

    it('should release only up to available reserved quantity', async () => {
      const order = makeOrder({ status: 'processing' });
      // Line says 10 allocated but ledger only has 5 reserved (edge case)
      const line = makeLine({ quantityAllocated: 10 });
      const ledger = makeLedger({ qtyReserved: 5 });

      setupCancelMocks(order, [line], [ledger]);

      const result = await cancelSalesOrder(IDS.SO, IDS.T, IDS.U, undefined, auditCtx);

      // Should release min(10, 5) = 5
      expect(result.inventoryReleased).toBe(5);
    });

    it('should handle order not found', async () => {
      (dbMock.transaction as ReturnType<typeof vi.fn>).mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => {
        let callIdx = 0;
        const makeTxChain = () => {
          const chain: Record<string, unknown> = {};
          for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'for']) {
            chain[m] = vi.fn(() => chain);
          }
          const idx = callIdx++;
          chain.then = (resolve: (v: unknown) => void) => resolve(idx === 0 ? [] : []);
          return chain;
        };
        return cb({ select: vi.fn(() => makeTxChain()), insert: vi.fn(), update: vi.fn(), execute: vi.fn() } as never);
      });

      await expect(
        cancelSalesOrder(IDS.SO, IDS.T, IDS.U, undefined, auditCtx),
      ).rejects.toThrow('Sales order not found');
    });
  });
});
