/**
 * Transfer Order Lifecycle Integration Tests
 *
 * Tests the full transfer lifecycle including:
 * - Ship transition inventory effects (qtyOnHand down, qtyInTransit up at source)
 * - Receive transition inventory effects (qtyInTransit down at source, qtyOnHand up at dest)
 * - Atomic rollback on partial failures
 * - Lead-time history insertion and aggregate analytics
 * - inventory:updated event emission for ship/receive
 *
 * NOTE: Many tests are marked .todo as they await backend implementation in #155, #156, #157.
 * Current tests cover the existing lifecycle endpoints.
 */

import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Test State ──────────────────────────────────────────────────────

const testState = vi.hoisted(() => ({
  dbSelectResults: [] as unknown[],
  txSelectResults: [] as unknown[],
  txUpdateResults: [] as unknown[],
  txInsertResults: [] as unknown[],
  insertedAuditRows: [] as Array<Record<string, unknown>>,
  publishedEvents: [] as Array<Record<string, unknown>>,
  inventoryAdjustments: [] as Array<{
    tenantId: string;
    facilityId: string;
    partId: string;
    field: string;
    adjustmentType: string;
    quantity: number;
    previousValue: number;
    newValue: number;
  }>,
}));

// ─── Hoisted Mocks ───────────────────────────────────────────────────

const { publishMock, getEventBusMock } = vi.hoisted(() => {
  const publishMock = vi.fn(async (event: Record<string, unknown>) => {
    testState.publishedEvents.push(event);
    return undefined;
  });
  const getEventBusMock = vi.fn(() => ({ publish: publishMock }));
  return { publishMock, getEventBusMock };
});

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name } as const);

  return {
    transferOrders: table('transfer_orders'),
    transferOrderLines: table('transfer_order_lines'),
    inventoryLedger: table('inventory_ledger'),
    leadTimeHistory: table('lead_time_history'),
    auditLog: table('audit_log'),
    kanbanCards: table('kanban_cards'),
    transferStatusEnum: {
      enumValues: [
        'draft',
        'requested',
        'approved',
        'picking',
        'shipped',
        'in_transit',
        'received',
        'closed',
        'cancelled',
      ] as const,
    },
  };
});

const { dbMock, resetDbMockCalls } = vi.hoisted(() => {
  function makeSelectBuilder(result: unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.limit = () => builder;
    builder.offset = () => builder;
    builder.orderBy = () => builder;
    builder.for = () => builder; // for('update')
    builder.execute = async () => result;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  }

  function makeUpdateBuilder(result: unknown) {
    const query: any = {};
    query.set = () => query;
    query.where = () => query;
    query.returning = async () => result;
    query.execute = async () => result;
    query.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return query;
  }

  function makeInsertBuilder(tableName: string, result: unknown) {
    const query: any = {};
    query.values = vi.fn((values: unknown) => {
      if (tableName === 'audit_log') {
        if (Array.isArray(values)) {
          testState.insertedAuditRows.push(...(values as Array<Record<string, unknown>>));
        } else {
          testState.insertedAuditRows.push(values as Record<string, unknown>);
        }
      }
      if (tableName === 'lead_time_history') {
        testState.txInsertResults.push({ table: tableName, values });
      }
      return query;
    });
    query.returning = async () => result;
    query.execute = async () => result;
    query.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return query;
  }

  function makeTx() {
    const tx: any = {};
    tx.select = vi.fn(() =>
      makeSelectBuilder(testState.txSelectResults.shift() ?? [])
    );
    tx.update = vi.fn((table: unknown) => {
      const tableName = (table as { __table?: string }).__table;
      const result = testState.txUpdateResults.shift() ?? [];
      return makeUpdateBuilder(result);
    });
    tx.insert = vi.fn((table: unknown) => {
      const tableName = (table as { __table?: string }).__table ?? 'unknown';
      const result = testState.txInsertResults.shift() ?? [];
      return makeInsertBuilder(tableName, result);
    });
    return tx;
  }

  const dbMock = {
    select: vi.fn(() =>
      makeSelectBuilder(testState.dbSelectResults.shift() ?? [])
    ),
    update: vi.fn(() => makeUpdateBuilder(testState.txUpdateResults.shift() ?? [])),
    insert: vi.fn((table: unknown) => {
      const tableName = (table as { __table?: string }).__table ?? 'unknown';
      return makeInsertBuilder(tableName, testState.txInsertResults.shift() ?? []);
    }),
    transaction: vi.fn(
      async (callback: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        callback(makeTx())
    ),
  };

  const resetDbMockCalls = () => {
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
}));

const writeAuditEntryMock = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.insertedAuditRows.push(entry);
    return {
      id: `audit-${testState.insertedAuditRows.length}`,
      hashChain: 'test-hash',
      sequenceNumber: testState.insertedAuditRows.length,
    };
  })
);

// Mock inventory ledger service with tracking
const adjustQuantityMock = vi.hoisted(() =>
  vi.fn(async (input: any) => {
    const previousValue =
      input.field === 'qtyOnHand' ? 100 :
      input.field === 'qtyInTransit' ? 0 : 0;

    let newValue = previousValue;
    if (input.adjustmentType === 'increment') {
      newValue = previousValue + input.quantity;
    } else if (input.adjustmentType === 'decrement') {
      newValue = Math.max(0, previousValue - input.quantity);
    }

    testState.inventoryAdjustments.push({
      tenantId: input.tenantId,
      facilityId: input.facilityId,
      partId: input.partId,
      field: input.field,
      adjustmentType: input.adjustmentType,
      quantity: input.quantity,
      previousValue,
      newValue,
    });

    return { previousValue, newValue, field: input.field, adjustmentType: input.adjustmentType, quantity: input.quantity };
  })
);

const batchAdjustMock = vi.hoisted(() =>
  vi.fn(async (adjustments: any[]) => {
    return adjustments.map((adj) => adjustQuantityMock(adj));
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
  publishKpiRefreshed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@arda/observability', () => ({
  getCorrelationId: vi.fn(() => 'test-corr-id'),
  correlationMiddleware: vi.fn(() => (_req: any, _res: any, next: any) => next()),
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

vi.mock('../services/order-number.service.js', () => ({
  getNextTONumber: vi.fn(async () => 'TO-TEST-0001'),
}));

vi.mock('../services/inventory-ledger.service.js', () => ({
  adjustQuantity: adjustQuantityMock,
  batchAdjust: batchAdjustMock,
  getInventory: vi.fn(async () => null),
  upsertInventory: vi.fn(async () => ({})),
}));

import { transferOrdersRouter } from './transfer-orders.routes.js';

// ─── Test Helpers ────────────────────────────────────────────────────

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      tenantId: 'tenant-1',
      sub: 'user-1',
      role: 'inventory_manager',
    };
    next();
  });
  app.use('/to', transferOrdersRouter);
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      res
        .status(err?.statusCode ?? 500)
        .json({ error: err?.message ?? 'Internal server error' });
    }
  );
  return app;
}

async function patchJson(
  app: express.Express,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = (await response.json()) as Record<string, any>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ─── Test Suite ──────────────────────────────────────────────────────

describe('Transfer Order Lifecycle - Ship Transition', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.txUpdateResults = [];
    testState.txInsertResults = [];
    testState.insertedAuditRows = [];
    testState.publishedEvents = [];
    testState.inventoryAdjustments = [];
    resetDbMockCalls();
    publishMock.mockClear();
    getEventBusMock.mockClear();
    writeAuditEntryMock.mockClear();
    adjustQuantityMock.mockClear();
    batchAdjustMock.mockClear();
  });

  it('verifies ship endpoint exists and handles basic request', async () => {
    const TO_ID = '33333333-3333-4333-8333-333333333333';
    const LINE_ID = '44444444-4444-4444-8444-444444444444';

    // Mock DB responses for existing ship endpoint
    testState.dbSelectResults = [
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'picking',
        },
      ],
    ];

    testState.txSelectResults = [
      // Line read for validation
      [
        {
          id: LINE_ID,
          transferOrderId: TO_ID,
          tenantId: 'tenant-1',
          quantityRequested: 10,
          quantityShipped: 0,
        },
      ],
      // All lines read to check if fully shipped
      [
        {
          id: LINE_ID,
          transferOrderId: TO_ID,
          tenantId: 'tenant-1',
          quantityRequested: 10,
          quantityShipped: 10,
        },
      ],
      // Final order read
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'shipped',
          shippedDate: new Date(),
        },
      ],
    ];

    const app = createTestApp();
    const response = await patchJson(app, `/to/${TO_ID}/ship`, {
      lines: [{ lineId: LINE_ID, quantityShipped: 10 }],
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: TO_ID,
        status: 'shipped',
      })
    );

    // Verify audit entries
    expect(testState.insertedAuditRows).toHaveLength(2);
    expect(
      testState.insertedAuditRows.find(
        (row) => row.action === 'transfer_order.status_changed'
      )
    ).toBeTruthy();
  });

  it.todo(
    'decrements source qtyOnHand when shipping lines',
    async () => {
      // TODO: Implement when #155 adds inventory adjustments to ship endpoint
      // Test will verify:
      // 1. adjustQuantity called with (facilityId: source, field: 'qtyOnHand', type: 'decrement')
      // 2. quantity matches quantityShipped
    }
  );

  it.todo(
    'increments source qtyInTransit when shipping lines',
    async () => {
      // TODO: Implement when #155 adds inventory adjustments to ship endpoint
      // Test will verify:
      // 1. adjustQuantity called with (facilityId: source, field: 'qtyInTransit', type: 'increment')
      // 2. quantity matches quantityShipped
    }
  );

  it.todo(
    'publishes inventory:updated event for qtyOnHand decrement on ship',
    async () => {
      // TODO: Implement when #155 adds event publishing
      // Test will verify:
      // 1. Event published with type: 'inventory:updated'
      // 2. Event contains correct facilityId, partId, field, adjustmentType, quantity
    }
  );

  it.todo(
    'publishes inventory:updated event for qtyInTransit increment on ship',
    async () => {
      // TODO: Implement when #155 adds event publishing
    }
  );

  it.todo(
    'handles partial ship without inventory adjustment',
    async () => {
      // TODO: Verify that partial ships (qty < requested) still adjust inventory correctly
    }
  );

  it.todo(
    'rolls back all inventory adjustments if ship fails',
    async () => {
      // TODO: Implement when #155 adds atomic transaction handling
      // Test will verify:
      // 1. If any inventory adjustment fails, entire transaction rolls back
      // 2. No partial inventory updates persist
      // 3. AppError thrown with appropriate message
    }
  );
});

describe('Transfer Order Lifecycle - Receive Transition', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.txUpdateResults = [];
    testState.txInsertResults = [];
    testState.insertedAuditRows = [];
    testState.publishedEvents = [];
    testState.inventoryAdjustments = [];
    resetDbMockCalls();
    publishMock.mockClear();
    getEventBusMock.mockClear();
    writeAuditEntryMock.mockClear();
    adjustQuantityMock.mockClear();
    batchAdjustMock.mockClear();
  });

  it('verifies receive endpoint exists and handles basic request', async () => {
    const TO_ID = '33333333-3333-4333-8333-333333333333';
    const LINE_ID = '44444444-4444-4444-8444-444444444444';

    testState.dbSelectResults = [
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'in_transit',
          sourceFacilityId: 'facility-source',
          destinationFacilityId: 'facility-dest',
        },
      ],
    ];

    testState.txSelectResults = [
      // Line read for validation
      [
        {
          id: LINE_ID,
          transferOrderId: TO_ID,
          tenantId: 'tenant-1',
          partId: 'part-123',
          quantityShipped: 10,
          quantityReceived: 0,
        },
      ],
      // All lines read to check if fully received
      [
        {
          id: LINE_ID,
          transferOrderId: TO_ID,
          tenantId: 'tenant-1',
          partId: 'part-123',
          quantityShipped: 10,
          quantityReceived: 10,
        },
      ],
      // Final order read
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'received',
          receivedDate: new Date(),
        },
      ],
    ];

    const app = createTestApp();
    const response = await patchJson(app, `/to/${TO_ID}/receive`, {
      lines: [{ lineId: LINE_ID, quantityReceived: 10 }],
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: TO_ID,
        status: 'received',
      })
    );

    // Verify audit entries
    expect(testState.insertedAuditRows.length).toBeGreaterThanOrEqual(1);
    expect(
      testState.insertedAuditRows.find(
        (row) => row.action === 'transfer_order.lines_received'
      )
    ).toBeTruthy();
  });

  it.todo(
    'decrements source qtyInTransit when receiving lines',
    async () => {
      // TODO: Implement when #156 adds inventory adjustments to receive endpoint
      // Test will verify:
      // 1. adjustQuantity called with (facilityId: source, field: 'qtyInTransit', type: 'decrement')
      // 2. quantity matches quantityReceived
    }
  );

  it.todo(
    'increments destination qtyOnHand when receiving lines',
    async () => {
      // TODO: Implement when #156 adds inventory adjustments to receive endpoint
      // Test will verify:
      // 1. adjustQuantity called with (facilityId: destination, field: 'qtyOnHand', type: 'increment')
      // 2. quantity matches quantityReceived
    }
  );

  it.todo(
    'uses batchAdjust for atomic receive adjustments',
    async () => {
      // TODO: Implement when #156 adds batchAdjust usage
      // Test will verify:
      // 1. batchAdjust called with both source qtyInTransit decrement and dest qtyOnHand increment
      // 2. Both adjustments in single transaction
    }
  );

  it.todo(
    'publishes inventory:updated events for receive adjustments',
    async () => {
      // TODO: Implement when #156 adds event publishing
      // Test will verify:
      // 1. Two events published: one for source qtyInTransit, one for dest qtyOnHand
      // 2. Events contain correct facility/part/field data
    }
  );

  it.todo(
    'handles partial receipt without inventory adjustment',
    async () => {
      // TODO: Verify partial receipts (qty < shipped) adjust inventory correctly
    }
  );

  it.todo(
    'rolls back all adjustments if receive transaction fails',
    async () => {
      // TODO: Implement when #156 adds atomic transaction handling
      // Test will verify:
      // 1. If destination increment fails, source decrement also rolls back
      // 2. No partial inventory updates
      // 3. AppError thrown
    }
  );
});

describe('Transfer Order Lifecycle - Atomic Rollback', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.txUpdateResults = [];
    testState.txInsertResults = [];
    testState.insertedAuditRows = [];
    testState.publishedEvents = [];
    testState.inventoryAdjustments = [];
    resetDbMockCalls();
    publishMock.mockClear();
    getEventBusMock.mockClear();
    adjustQuantityMock.mockClear();
    batchAdjustMock.mockClear();
  });

  it.todo(
    'rolls back ship if any line inventory adjustment fails',
    async () => {
      // TODO: Implement when #155 adds multi-line atomic handling
      // Test will:
      // 1. Mock adjustQuantity to throw on second line
      // 2. Verify first line inventory not persisted
      // 3. Verify order status unchanged
      // 4. Verify no audit entries written
    }
  );

  it.todo(
    'rolls back receive if source decrement fails',
    async () => {
      // TODO: Implement when #156 adds atomic receive handling
      // Test will:
      // 1. Mock batchAdjust to throw error
      // 2. Verify destination qtyOnHand unchanged
      // 3. Verify source qtyInTransit unchanged
      // 4. Verify order status unchanged
    }
  );

  it.todo(
    'rolls back receive if destination increment fails',
    async () => {
      // TODO: Implement when #156 adds atomic receive handling
    }
  );

  it.todo(
    'does not emit events if inventory adjustment fails',
    async () => {
      // TODO: Verify no inventory:updated events published on failure
    }
  );
});

describe('Transfer Order Lifecycle - Lead Time History', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.txUpdateResults = [];
    testState.txInsertResults = [];
    testState.insertedAuditRows = [];
    testState.publishedEvents = [];
    testState.inventoryAdjustments = [];
    resetDbMockCalls();
    publishMock.mockClear();
    getEventBusMock.mockClear();
  });

  it.todo(
    'inserts lead_time_history entry on receive with correct duration',
    async () => {
      // TODO: Implement when #157 adds lead time tracking
      // Test will verify:
      // 1. lead_time_history row inserted with:
      //    - sourceFacilityId
      //    - destinationFacilityId
      //    - partId
      //    - leadTimeDays (calculated from shippedDate to receivedDate)
      //    - completedAt (receivedDate)
    }
  );

  it.todo(
    'calculates lead time correctly for same-day receive',
    async () => {
      // TODO: Test edge case of same-day ship and receive
    }
  );

  it.todo(
    'calculates lead time correctly for multi-day transit',
    async () => {
      // TODO: Test normal multi-day transit case
    }
  );

  it.todo(
    'does not insert lead_time_history on partial receive',
    async () => {
      // TODO: Verify lead time only recorded on full receipt
    }
  );

  it.todo(
    'aggregate analytics endpoint returns correct avg lead time',
    async () => {
      // TODO: Test GET /analytics/lead-time?sourceFacilityId=X&destinationFacilityId=Y&partId=Z
      // Verify response contains: avg, median, p90, min, max
    }
  );

  it.todo(
    'aggregate analytics handles no history gracefully',
    async () => {
      // TODO: Verify empty/null response when no lead time data exists
    }
  );
});

describe('Transfer Order Lifecycle - Queue and Automation', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.txUpdateResults = [];
    testState.txInsertResults = [];
    testState.insertedAuditRows = [];
    testState.publishedEvents = [];
    testState.inventoryAdjustments = [];
    resetDbMockCalls();
    publishMock.mockClear();
    getEventBusMock.mockClear();
  });

  it.todo(
    'queue endpoint aggregates transfer requests by priority',
    async () => {
      // TODO: Implement when queue endpoint added
      // Test GET /queue with filters and priority scoring
    }
  );

  it.todo(
    'queue endpoint includes source recommendation data',
    async () => {
      // TODO: Verify queue items include source facility recommendations
    }
  );

  it.todo(
    'transfer kanban trigger creates draft TO and advances card',
    async () => {
      // TODO: Implement when kanban automation added
      // Test will verify:
      // 1. Kanban card transition creates draft transfer order
      // 2. Transfer order linked to kanban card
      // 3. Card stage advanced
    }
  );

  it.todo(
    'transfer kanban trigger uses source recommendation',
    async () => {
      // TODO: Verify kanban trigger selects optimal source facility
    }
  );
});

describe('Transfer Order Lifecycle - Event Publishing', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txSelectResults = [];
    testState.txUpdateResults = [];
    testState.txInsertResults = [];
    testState.insertedAuditRows = [];
    testState.publishedEvents = [];
    testState.inventoryAdjustments = [];
    resetDbMockCalls();
    publishMock.mockClear();
    getEventBusMock.mockClear();
  });

  it('publishes order.status_changed event on ship transition', async () => {
    const TO_ID = '33333333-3333-4333-8333-333333333333';
    const LINE_ID = '44444444-4444-4444-8444-444444444444';

    testState.dbSelectResults = [
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'picking',
        },
      ],
    ];

    testState.txSelectResults = [
      [
        {
          id: LINE_ID,
          transferOrderId: TO_ID,
          tenantId: 'tenant-1',
          quantityRequested: 10,
          quantityShipped: 0,
        },
      ],
      [
        {
          id: LINE_ID,
          transferOrderId: TO_ID,
          tenantId: 'tenant-1',
          quantityRequested: 10,
          quantityShipped: 10,
        },
      ],
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'shipped',
        },
      ],
    ];

    const app = createTestApp();
    await patchJson(app, `/to/${TO_ID}/ship`, {
      lines: [{ lineId: LINE_ID, quantityShipped: 10 }],
    });

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order.status_changed',
        tenantId: 'tenant-1',
        orderType: 'transfer_order',
        orderId: TO_ID,
        fromStatus: 'picking',
        toStatus: 'shipped',
      })
    );
  });

  it('publishes order.status_changed event on receive transition', async () => {
    const TO_ID = '33333333-3333-4333-8333-333333333333';
    const LINE_ID = '44444444-4444-4444-8444-444444444444';

    testState.dbSelectResults = [
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'in_transit',
        },
      ],
    ];

    testState.txSelectResults = [
      [
        {
          id: LINE_ID,
          transferOrderId: TO_ID,
          tenantId: 'tenant-1',
          quantityShipped: 10,
          quantityReceived: 0,
        },
      ],
      [
        {
          id: LINE_ID,
          transferOrderId: TO_ID,
          tenantId: 'tenant-1',
          quantityShipped: 10,
          quantityReceived: 10,
        },
      ],
      [
        {
          id: TO_ID,
          tenantId: 'tenant-1',
          toNumber: 'TO-1001',
          status: 'received',
        },
      ],
    ];

    const app = createTestApp();
    await patchJson(app, `/to/${TO_ID}/receive`, {
      lines: [{ lineId: LINE_ID, quantityReceived: 10 }],
    });

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order.status_changed',
        tenantId: 'tenant-1',
        orderType: 'transfer_order',
        orderId: TO_ID,
        fromStatus: 'in_transit',
        toStatus: 'received',
      })
    );
  });

  it.todo(
    'publishes inventory:updated event with correct schema on ship',
    async () => {
      // TODO: Implement when #155 adds inventory event publishing
      // Verify event schema matches InventoryUpdatedEvent from @arda/events
    }
  );

  it.todo(
    'publishes inventory:updated event with correct schema on receive',
    async () => {
      // TODO: Implement when #156 adds inventory event publishing
    }
  );
});
