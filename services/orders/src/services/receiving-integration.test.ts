import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Integration tests for the receiving workflow integrations:
 * - Inventory auto-update on receipt confirmation
 * - Kanban card stage transitions on receiving
 * - Expected orders lookup
 * - Receiving history with audit trail
 */

// ─── Hoisted Mocks ──────────────────────────────────────────────────

const testState = vi.hoisted(() => ({
  dbSelectResults: [] as unknown[],
  txSelectResults: [] as unknown[],
  insertedReceipts: [] as Array<Record<string, unknown>>,
  insertedLines: [] as Array<Record<string, unknown>>,
  insertedExceptions: [] as Array<Record<string, unknown>>,
  insertedAuditRows: [] as Array<Record<string, unknown>>,
  insertedTransitions: [] as Array<Record<string, unknown>>,
  updatedCards: [] as Array<Record<string, unknown>>,
  updatedOrders: [] as Array<Record<string, unknown>>,
  adjustQuantityCalls: [] as Array<Record<string, unknown>>,
  upsertInventoryCalls: [] as Array<Record<string, unknown>>,
}));

const { publishMock, getEventBusMock } = vi.hoisted(() => {
  const publishMock = vi.fn(async () => undefined);
  const getEventBusMock = vi.fn(() => ({ publish: publishMock }));
  return { publishMock, getEventBusMock };
});

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => {
    const t = { __table: name } as any;
    t.tenantId = { column: 'tenant_id' };
    t.status = { column: 'status' };
    t.receiptNumber = { column: 'receipt_number' };
    t.quantityAccepted = { column: 'quantity_accepted' };
    t.quantityDamaged = { column: 'quantity_damaged' };
    t.quantityRejected = { column: 'quantity_rejected' };
    t.quantityReceived = { column: 'quantity_received' };
    t.quantityOrdered = { column: 'quantity_ordered' };
    t.receiptId = { column: 'receipt_id' };
    t.orderId = { column: 'order_id' };
    t.orderType = { column: 'order_type' };
    t.exceptionType = { column: 'exception_type' };
    t.severity = { column: 'severity' };
    t.resolutionType = { column: 'resolution_type' };
    t.resolvedAt = { column: 'resolved_at' };
    t.createdAt = { column: 'created_at' };
    t.id = { column: 'id' };
    t.purchaseOrderId = { column: 'purchase_order_id' };
    t.transferOrderId = { column: 'transfer_order_id' };
    t.partId = { column: 'part_id' };
    t.kanbanCardId = { column: 'kanban_card_id' };
    t.facilityId = { column: 'facility_id' };
    t.destinationFacilityId = { column: 'destination_facility_id' };
    t.loopId = { column: 'loop_id' };
    t.currentStage = { column: 'current_stage' };
    t.expectedDeliveryDate = { column: 'expected_delivery_date' };
    t.shippedDate = { column: 'shipped_date' };
    t.scheduledEndDate = { column: 'scheduled_end_date' };
    t.quantityRequested = { column: 'quantity_requested' };
    t.quantityToProduce = { column: 'quantity_to_produce' };
    t.quantityProduced = { column: 'quantity_produced' };
    return t;
  };

  return {
    receipts: table('receipts'),
    receiptLines: table('receipt_lines'),
    receivingExceptions: table('receiving_exceptions'),
    purchaseOrders: table('purchase_orders'),
    purchaseOrderLines: table('purchase_order_lines'),
    transferOrders: table('transfer_orders'),
    transferOrderLines: table('transfer_order_lines'),
    workOrders: table('work_orders'),
    kanbanCards: table('kanban_cards'),
    cardStageTransitions: table('card_stage_transitions'),
    inventoryLedger: table('inventory_ledger'),
  };
});

const { dbMock, resetDbMockCalls } = vi.hoisted(() => {
  let insertCounter = 0;
  let txSelectCallCount = 0;

  function makeSelectBuilder(result: unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.limit = () => builder;
    builder.orderBy = () => builder;
    builder.offset = () => builder;
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
    txSelectCallCount = 0;
    const tx: any = {};
    tx.select = vi.fn(() => {
      const result = testState.txSelectResults[txSelectCallCount] ?? [];
      txSelectCallCount++;
      return makeSelectBuilder(result);
    });
    tx.update = vi.fn((table: unknown) => {
      const builder = makeUpdateBuilder();
      const tableName = (table as { __table?: string }).__table;
      builder.set = vi.fn((values: Record<string, unknown>) => {
        if (tableName === 'kanban_cards') {
          testState.updatedCards.push(values);
        }
        if (tableName === 'purchase_orders' || tableName === 'transfer_orders' || tableName === 'work_orders') {
          testState.updatedOrders.push({ table: tableName, ...values });
        }
        return builder;
      });
      builder.returning = vi.fn(async () => {
        return [];
      });
      return builder;
    });
    tx.insert = vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        const tableName = (table as { __table?: string }).__table;
        const arr = Array.isArray(values) ? values : [values];
        if (tableName === 'receipts') testState.insertedReceipts.push(...(arr as any));
        if (tableName === 'receipt_lines') testState.insertedLines.push(...(arr as any));
        if (tableName === 'receiving_exceptions') testState.insertedExceptions.push(...(arr as any));
        if (tableName === 'card_stage_transitions') testState.insertedTransitions.push(...(arr as any));
        return {
          returning: async () =>
            arr.map((v: any) => ({
              ...v,
              id: `${tableName}-${++insertCounter}`,
            })),
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
        const arr = Array.isArray(values) ? values : [values];
        return {
          returning: async () =>
            arr.map((v: any) => ({
              ...v,
              id: `inserted-${++insertCounter}`,
            })),
          onConflictDoUpdate: vi.fn(() => ({
            returning: async () =>
              arr.map((v: any) => ({
                ...v,
                id: `upserted-${++insertCounter}`,
              })),
          })),
        };
      }),
    })),
    transaction: vi.fn(async (callback: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      callback(makeTx())
    ),
  };

  const resetDbMockCalls = () => {
    insertCounter = 0;
    txSelectCallCount = 0;
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
  inArray: vi.fn(() => ({})),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.insertedAuditRows.push(entry);
    return { id: 'audit-1', hashChain: 'test-hash', sequenceNumber: 1 };
  }),
  writeAuditEntries: vi.fn(async (_dbOrTx: unknown, _tenantId: string, entries: Array<Record<string, unknown>>) => {
    testState.insertedAuditRows.push(...entries);
    return entries.map((_, i) => ({ id: `audit-${i + 1}`, hashChain: `test-hash-${i}`, sequenceNumber: i + 1 }));
  }),
}));

vi.mock('@arda/events', () => ({
  getEventBus: getEventBusMock,
  publishKpiRefreshed: vi.fn(async () => undefined),
}));

vi.mock('@arda/observability', () => ({
  getCorrelationId: vi.fn(() => 'test-correlation-id'),
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

const { mockAdjustQuantity, mockUpsertInventory } = vi.hoisted(() => {
  const mockAdjustQuantity = vi.fn(async (input: Record<string, unknown>) => {
    return { previousValue: 0, newValue: input.quantity, field: input.field, adjustmentType: input.adjustmentType, quantity: input.quantity };
  });
  const mockUpsertInventory = vi.fn(async (input: Record<string, unknown>) => {
    return { id: 'inv-1', ...input, qtyOnHand: 0, qtyReserved: 0, qtyInTransit: 0 };
  });
  return { mockAdjustQuantity, mockUpsertInventory };
});

vi.mock('./inventory-ledger.service.js', () => ({
  adjustQuantity: mockAdjustQuantity,
  upsertInventory: mockUpsertInventory,
}));

// ─── Import After Mocks ─────────────────────────────────────────────

import {
  processReceipt,
  getExpectedOrders,
  getReceivingHistory,
} from './receiving.service.js';

// ─── Test Constants ─────────────────────────────────────────────────

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const ORDER_ID = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const PART_ID = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
const LINE_ID = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';
const CARD_ID = 'ffffffff-ffff-4fff-ffff-ffffffffffff';
const FACILITY_ID = '11111111-1111-4111-8111-111111111111';
const LOOP_ID = '22222222-2222-4222-8222-222222222222';

function resetTestState() {
  testState.dbSelectResults = [];
  testState.txSelectResults = [];
  testState.insertedReceipts = [];
  testState.insertedLines = [];
  testState.insertedExceptions = [];
  testState.insertedAuditRows = [];
  testState.insertedTransitions = [];
  testState.updatedCards = [];
  testState.updatedOrders = [];
  testState.adjustQuantityCalls = [];
  testState.upsertInventoryCalls = [];
  resetDbMockCalls();
  publishMock.mockClear();
  getEventBusMock.mockClear();
  mockAdjustQuantity.mockReset();
  mockAdjustQuantity.mockImplementation(async (input: Record<string, unknown>) => {
    testState.adjustQuantityCalls.push(input);
    return { previousValue: 0, newValue: input.quantity, field: input.field, adjustmentType: input.adjustmentType, quantity: input.quantity };
  });
  mockUpsertInventory.mockReset();
  mockUpsertInventory.mockImplementation(async (input: Record<string, unknown>) => {
    testState.upsertInventoryCalls.push(input);
    return { id: 'inv-1', ...input, qtyOnHand: 0, qtyReserved: 0, qtyInTransit: 0 };
  });
}

// ═══════════════════════════════════════════════════════════════════
// 1. Inventory Update on Receiving
// ═══════════════════════════════════════════════════════════════════

describe('inventory update on receiving', () => {
  beforeEach(resetTestState);

  it('increments qtyOnHand for accepted PO items', async () => {
    // TX selects:
    // 1. getNextReceiptNumber — advisory lock (execute)
    // 2. getNextReceiptNumber — select receipts
    // 3. updateOrderAfterReceiving — update PO lines
    // 4. updateOrderAfterReceiving — select PO lines for status check
    // 5. transitionKanbanCards — select PO lines for card IDs
    testState.txSelectResults = [
      [], // no existing receipt numbers
      [], // PO lines update returns empty from update
      [{ ordered: 10, received: 10 }], // all received
      [{ kanbanCardId: null }], // no linked cards
    ];

    // DB selects outside TX for inventory update:
    // 1. PO facility lookup
    testState.dbSelectResults = [
      [{ facilityId: FACILITY_ID }], // PO facility
    ];

    await processReceipt({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      orderType: 'purchase_order',
      receivedByUserId: USER_ID,
      lines: [
        {
          orderLineId: LINE_ID,
          partId: PART_ID,
          quantityExpected: 10,
          quantityAccepted: 10,
          quantityDamaged: 0,
          quantityRejected: 0,
        },
      ],
    });

    // Verify upsert was called to ensure inventory row exists
    expect(mockUpsertInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        facilityId: FACILITY_ID,
        partId: PART_ID,
      })
    );

    // Verify adjustQuantity was called with increment on qtyOnHand
    expect(mockAdjustQuantity).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        facilityId: FACILITY_ID,
        partId: PART_ID,
        field: 'qtyOnHand',
        adjustmentType: 'increment',
        quantity: 10,
      })
    );
  });

  it('decrements qtyInTransit for transfer order receipts', async () => {
    testState.txSelectResults = [
      [], // no existing receipt numbers
      [], // TO lines update
      [{ requested: 5, received: 5 }], // all received
      [{ kanbanCardId: null }], // no linked card on TO
    ];

    testState.dbSelectResults = [
      [{ facilityId: FACILITY_ID }], // TO destination facility
    ];

    await processReceipt({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      orderType: 'transfer_order',
      receivedByUserId: USER_ID,
      lines: [
        {
          orderLineId: LINE_ID,
          partId: PART_ID,
          quantityExpected: 5,
          quantityAccepted: 5,
          quantityDamaged: 0,
          quantityRejected: 0,
        },
      ],
    });

    // Should have 2 adjustQuantity calls: increment qtyOnHand, decrement qtyInTransit
    expect(mockAdjustQuantity).toHaveBeenCalledTimes(2);

    const onHandCall = testState.adjustQuantityCalls.find(
      (c) => c.field === 'qtyOnHand'
    );
    expect(onHandCall).toEqual(
      expect.objectContaining({
        field: 'qtyOnHand',
        adjustmentType: 'increment',
        quantity: 5,
      })
    );

    const inTransitCall = testState.adjustQuantityCalls.find(
      (c) => c.field === 'qtyInTransit'
    );
    expect(inTransitCall).toEqual(
      expect.objectContaining({
        field: 'qtyInTransit',
        adjustmentType: 'decrement',
        quantity: 5,
      })
    );
  });

  it('skips inventory update for zero-accepted lines', async () => {
    testState.txSelectResults = [
      [], // no existing receipt numbers
      [{ ordered: 10, received: 0 }], // not all received
      [{ kanbanCardId: null }], // no linked cards
    ];

    testState.dbSelectResults = [
      [{ facilityId: FACILITY_ID }], // PO facility
    ];

    await processReceipt({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      orderType: 'purchase_order',
      receivedByUserId: USER_ID,
      lines: [
        {
          orderLineId: LINE_ID,
          partId: PART_ID,
          quantityExpected: 10,
          quantityAccepted: 0,
          quantityDamaged: 10,
          quantityRejected: 0,
        },
      ],
    });

    // No adjustQuantity calls because quantityAccepted is 0
    expect(mockAdjustQuantity).not.toHaveBeenCalled();
    expect(mockUpsertInventory).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Kanban Card Transitions on Receiving
// ═══════════════════════════════════════════════════════════════════

describe('kanban card transitions on receiving', () => {
  beforeEach(resetTestState);

  it('transitions linked PO kanban card from ordered to received', async () => {
    testState.txSelectResults = [
      [], // no existing receipt numbers
      [{ ordered: 10, received: 10 }], // all PO lines received
      [{ kanbanCardId: CARD_ID }], // PO line has linked card
      // Card lookup:
      [{
        id: CARD_ID,
        tenantId: TENANT_ID,
        loopId: LOOP_ID,
        currentStage: 'ordered',
        completedCycles: 2,
      }],
    ];

    testState.dbSelectResults = [
      [{ facilityId: FACILITY_ID }], // PO facility
    ];

    const result = await processReceipt({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      orderType: 'purchase_order',
      receivedByUserId: USER_ID,
      lines: [
        {
          orderLineId: LINE_ID,
          partId: PART_ID,
          quantityExpected: 10,
          quantityAccepted: 10,
          quantityDamaged: 0,
          quantityRejected: 0,
        },
      ],
    });

    // Verify kanban card was updated
    expect(testState.updatedCards).toHaveLength(1);
    expect(testState.updatedCards[0]).toEqual(
      expect.objectContaining({
        currentStage: 'received',
      })
    );

    // Verify stage transition was inserted
    expect(testState.insertedTransitions).toHaveLength(1);
    expect(testState.insertedTransitions[0]).toEqual(
      expect.objectContaining({
        cardId: CARD_ID,
        loopId: LOOP_ID,
        fromStage: 'ordered',
        toStage: 'received',
        method: 'system',
        cycleNumber: 3, // completedCycles + 1
      })
    );

    // Verify audit entry for card transition
    const cardAudit = testState.insertedAuditRows.find(
      (a) => a.action === 'card.stage_changed'
    );
    expect(cardAudit).toBeDefined();
    expect(cardAudit?.entityType).toBe('kanban_card');
    expect(cardAudit?.entityId).toBe(CARD_ID);

    // Verify card.transition event was published
    const cardEvent = publishMock.mock.calls.find(
      (c: unknown[]) => (c[0] as any)?.type === 'card.transition'
    );
    expect(cardEvent).toBeDefined();

    // Verify result includes transitioned card IDs
    expect(result.transitionedCardIds).toContain(CARD_ID);
  });

  it('does not transition card in restocked stage', async () => {
    testState.txSelectResults = [
      [], // no existing receipt numbers
      [{ ordered: 10, received: 10 }], // all received
      [{ kanbanCardId: CARD_ID }], // PO line has linked card
      // Card lookup — card is already restocked
      [{
        id: CARD_ID,
        tenantId: TENANT_ID,
        loopId: LOOP_ID,
        currentStage: 'restocked',
        completedCycles: 3,
      }],
    ];

    testState.dbSelectResults = [
      [{ facilityId: FACILITY_ID }],
    ];

    const result = await processReceipt({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      orderType: 'purchase_order',
      receivedByUserId: USER_ID,
      lines: [
        {
          orderLineId: LINE_ID,
          partId: PART_ID,
          quantityExpected: 10,
          quantityAccepted: 10,
          quantityDamaged: 0,
          quantityRejected: 0,
        },
      ],
    });

    // Card should NOT be transitioned
    expect(testState.updatedCards).toHaveLength(0);
    expect(testState.insertedTransitions).toHaveLength(0);
    expect(result.transitionedCardIds).toHaveLength(0);
  });

  it('handles PO with no linked kanban cards gracefully', async () => {
    testState.txSelectResults = [
      [], // no existing receipt numbers
      [{ ordered: 10, received: 10 }], // all received
      [{ kanbanCardId: null }, { kanbanCardId: null }], // no linked cards
    ];

    testState.dbSelectResults = [
      [{ facilityId: FACILITY_ID }],
    ];

    const result = await processReceipt({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      orderType: 'purchase_order',
      receivedByUserId: USER_ID,
      lines: [
        {
          orderLineId: LINE_ID,
          partId: PART_ID,
          quantityExpected: 10,
          quantityAccepted: 10,
          quantityDamaged: 0,
          quantityRejected: 0,
        },
      ],
    });

    expect(testState.updatedCards).toHaveLength(0);
    expect(testState.insertedTransitions).toHaveLength(0);
    expect(result.transitionedCardIds).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Expected Orders Lookup
// ═══════════════════════════════════════════════════════════════════

describe('getExpectedOrders', () => {
  beforeEach(resetTestState);

  it('returns POs in receivable states with remaining quantities', async () => {
    testState.dbSelectResults = [
      // POs in receivable states
      [{
        id: ORDER_ID,
        poNumber: 'PO-001',
        status: 'sent',
        supplierId: 'supplier-1',
        facilityId: FACILITY_ID,
      }],
      // PO lines
      [{
        id: LINE_ID,
        partId: PART_ID,
        quantityOrdered: 100,
        quantityReceived: 30,
      }],
      // TOs
      [],
      // WOs
      [],
    ];

    const result = await getExpectedOrders({ tenantId: TENANT_ID });

    expect(result.purchaseOrders).toHaveLength(1);
    expect(result.purchaseOrders[0]).toEqual(
      expect.objectContaining({
        id: ORDER_ID,
        totalRemaining: 70,
      })
    );
    expect((result.purchaseOrders[0] as any).lines[0].quantityRemaining).toBe(70);
  });

  it('filters by orderType when specified', async () => {
    testState.dbSelectResults = [
      // Only WOs returned
      [{
        id: ORDER_ID,
        woNumber: 'WO-001',
        status: 'in_progress',
        quantityToProduce: 50,
        quantityProduced: 10,
      }],
    ];

    const result = await getExpectedOrders({
      tenantId: TENANT_ID,
      orderType: 'work_order',
    });

    expect(result.purchaseOrders).toHaveLength(0);
    expect(result.transferOrders).toHaveLength(0);
    expect(result.workOrders).toHaveLength(1);
    expect(result.workOrders[0]).toEqual(
      expect.objectContaining({
        quantityRemaining: 40,
      })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Receiving History with Audit Trail
// ═══════════════════════════════════════════════════════════════════

describe('getReceivingHistory', () => {
  beforeEach(resetTestState);

  it('returns paginated receiving history', async () => {
    testState.dbSelectResults = [
      // rows
      [
        { id: 'rcpt-1', receiptNumber: 'RCV-20260215-0001', status: 'complete', orderType: 'purchase_order' },
        { id: 'rcpt-2', receiptNumber: 'RCV-20260215-0002', status: 'exception', orderType: 'purchase_order' },
      ],
      // count
      [{ count: 15 }],
    ];

    const result = await getReceivingHistory({
      tenantId: TENANT_ID,
      page: 1,
      pageSize: 10,
    });

    expect(result.data).toHaveLength(2);
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 10,
      total: 15,
      totalPages: 2,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Full Receipt Workflow (E2E Mock)
// ═══════════════════════════════════════════════════════════════════

describe('full receipt workflow', () => {
  beforeEach(resetTestState);

  it('creates receipt, detects exceptions, updates order + inventory + kanban, publishes events', async () => {
    testState.txSelectResults = [
      [], // no existing receipt numbers
      [{ ordered: 20, received: 15 }], // partially received
      [{ kanbanCardId: CARD_ID }], // linked card
      // Card lookup
      [{
        id: CARD_ID,
        tenantId: TENANT_ID,
        loopId: LOOP_ID,
        currentStage: 'in_transit',
        completedCycles: 0,
      }],
    ];

    testState.dbSelectResults = [
      [{ facilityId: FACILITY_ID }], // PO facility
    ];

    const result = await processReceipt({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      orderType: 'purchase_order',
      receivedByUserId: USER_ID,
      lines: [
        {
          orderLineId: LINE_ID,
          partId: PART_ID,
          quantityExpected: 20,
          quantityAccepted: 15,
          quantityDamaged: 3,
          quantityRejected: 2,
        },
      ],
    });

    // Receipt was created
    expect(testState.insertedReceipts).toHaveLength(1);
    expect(testState.insertedLines).toHaveLength(1);

    // Exceptions detected (short shipment: 20 - (15+3+2) = 0, damaged: 3, rejected: 2)
    expect(testState.insertedExceptions.length).toBeGreaterThan(0);

    // Kanban card transitioned from in_transit to received
    expect(testState.updatedCards).toHaveLength(1);
    expect(testState.insertedTransitions).toHaveLength(1);
    expect(testState.insertedTransitions[0]).toEqual(
      expect.objectContaining({
        fromStage: 'in_transit',
        toStage: 'received',
      })
    );

    // Inventory updated for accepted items
    expect(mockUpsertInventory).toHaveBeenCalledTimes(1);
    expect(mockAdjustQuantity).toHaveBeenCalledWith(
      expect.objectContaining({
        field: 'qtyOnHand',
        adjustmentType: 'increment',
        quantity: 15,
      })
    );

    // Audit entries created (receipt + card transition)
    const receiptAudit = testState.insertedAuditRows.find(
      (a) => a.action === 'receipt.created'
    );
    expect(receiptAudit).toBeDefined();
    expect(receiptAudit?.entityType).toBe('receipt');

    const cardAudit = testState.insertedAuditRows.find(
      (a) => a.action === 'card.stage_changed'
    );
    expect(cardAudit).toBeDefined();

    // Events published
    const receivingCompleted = publishMock.mock.calls.find(
      (c: unknown[]) => (c[0] as any)?.type === 'receiving.completed'
    );
    expect(receivingCompleted).toBeDefined();

    // Result includes transitioned card IDs
    expect(result.transitionedCardIds).toContain(CARD_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Route Integration Tests
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import { receivingRouter } from '../routes/receiving.routes.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      tenantId: TENANT_ID,
      sub: USER_ID,
    };
    next();
  });
  app.use('/receiving', receivingRouter);
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

describe('receiving routes — new endpoints', () => {
  beforeEach(resetTestState);

  describe('GET /receiving/expected', () => {
    it('returns expected orders', async () => {
      testState.dbSelectResults = [
        // POs
        [{ id: ORDER_ID, poNumber: 'PO-001', status: 'sent' }],
        [{ id: LINE_ID, quantityOrdered: 100, quantityReceived: 40 }],
        // TOs
        [],
        // WOs
        [],
      ];

      const app = createTestApp();
      const res = await requestJson(app, 'GET', '/receiving/expected');
      expect(res.status).toBe(200);
      expect(res.body.purchaseOrders).toBeDefined();
      expect(res.body.transferOrders).toBeDefined();
      expect(res.body.workOrders).toBeDefined();
    });

    it('filters by orderType query param', async () => {
      testState.dbSelectResults = [
        // Only WOs returned when filtered
        [{ id: ORDER_ID, woNumber: 'WO-001', quantityToProduce: 50, quantityProduced: 10 }],
      ];

      const app = createTestApp();
      const res = await requestJson(app, 'GET', '/receiving/expected?orderType=work_order');
      expect(res.status).toBe(200);
      expect(res.body.purchaseOrders).toHaveLength(0);
      expect(res.body.workOrders).toHaveLength(1);
    });
  });

  describe('GET /receiving/history', () => {
    it('returns paginated history', async () => {
      testState.dbSelectResults = [
        [{ id: 'rcpt-1', receiptNumber: 'RCV-20260215-0001' }],
        [{ count: 1 }],
      ];

      const app = createTestApp();
      const res = await requestJson(app, 'GET', '/receiving/history');
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.pagination).toBeDefined();
    });

    it('supports page and pageSize params', async () => {
      testState.dbSelectResults = [
        [],
        [{ count: 0 }],
      ];

      const app = createTestApp();
      const res = await requestJson(app, 'GET', '/receiving/history?page=2&pageSize=5');
      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ page: 2, pageSize: 5 })
      );
    });
  });
});
