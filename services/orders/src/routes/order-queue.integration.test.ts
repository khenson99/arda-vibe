import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  selectResults: [] as unknown[],
  insertedAuditRows: [] as Array<Record<string, unknown>>,
  loopByCardId: {} as Record<string, string>,
}));

const {
  getEventBusMock,
  publishMock,
  getNextPONumberMock,
  getNextWONumberMock,
  getNextTONumberMock,
  transitionTriggeredCardToOrderedMock,
} = vi.hoisted(() => {
  const publishMock = vi.fn(async () => undefined);
  const getEventBusMock = vi.fn(() => ({ publish: publishMock }));

  const getNextPONumberMock = vi.fn(async () => 'PO-20260209-0001');
  const getNextWONumberMock = vi.fn(async () => 'WO-20260209-0001');
  const getNextTONumberMock = vi.fn(async () => 'TO-20260209-0001');

  const transitionTriggeredCardToOrderedMock = vi.fn(
    async (_tx: unknown, input: { cardId: string }) => ({
      cardId: input.cardId,
      loopId: testState.loopByCardId[input.cardId] ?? `loop-${input.cardId}`,
    })
  );

  return {
    getEventBusMock,
    publishMock,
    getNextPONumberMock,
    getNextWONumberMock,
    getNextTONumberMock,
    transitionTriggeredCardToOrderedMock,
  };
});

const schemaMock = vi.hoisted(() => {
  const makeTable = (table: string) => ({ __table: table } as const);

  return {
    kanbanCards: makeTable('kanban_cards'),
    kanbanLoops: makeTable('kanban_loops'),
    suppliers: makeTable('suppliers'),
    parts: makeTable('parts'),
    supplierParts: makeTable('supplier_parts'),
    facilities: makeTable('facilities'),
    auditLog: makeTable('audit_log'),
    purchaseOrders: makeTable('purchase_orders'),
    purchaseOrderLines: makeTable('purchase_order_lines'),
    workOrders: makeTable('work_orders'),
    workOrderRoutings: makeTable('work_order_routings'),
    transferOrders: makeTable('transfer_orders'),
    transferOrderLines: makeTable('transfer_order_lines'),
    loopTypeEnum: {
      enumValues: ['procurement', 'production', 'transfer'] as const,
    },
  };
});

const { dbMock, resetDbMockCalls } = vi.hoisted(() => {
  function makeSelectBuilder(result: unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.innerJoin = () => builder;
    builder.leftJoin = () => builder;
    builder.where = () => builder;
    builder.orderBy = () => builder;
    builder.groupBy = () => builder;
    builder.limit = () => builder;
    builder.offset = () => builder;
    builder.execute = async () => result;
    return builder;
  }

  function makeTx() {
    const tx: any = {};
    tx.update = vi.fn(() => {
      const builder: any = {};
      builder.set = () => builder;
      builder.where = () => builder;
      builder.execute = async () => [];
      return builder;
    });
    tx.insert = vi.fn((table: unknown) => {
      const valuesBuilder: any = {};
      valuesBuilder.values = (values: unknown) => {
        const tableName = (table as { __table?: string }).__table;

        if (tableName === 'audit_log') {
          if (Array.isArray(values)) {
            testState.insertedAuditRows.push(...(values as Array<Record<string, unknown>>));
          } else {
            testState.insertedAuditRows.push(values as Record<string, unknown>);
          }
        }

        let defaultResult: unknown[] = [];
        if (tableName === 'purchase_orders') defaultResult = [{ id: 'po-123' }];
        if (tableName === 'work_orders') defaultResult = [{ id: 'wo-123' }];
        if (tableName === 'transfer_orders') defaultResult = [{ id: 'to-123' }];

        const query: any = {
          execute: async () => defaultResult,
          returning: () => ({
            execute: async () => defaultResult,
          }),
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(defaultResult).then(resolve, reject),
        };

        return query;
      };
      return valuesBuilder;
    });

    return tx;
  }

  const dbMock = {
    select: vi.fn(() => {
      const result = testState.selectResults.shift() ?? [];
      return makeSelectBuilder(result);
    }),
    execute: vi.fn(async () => testState.selectResults.shift() ?? []),
    transaction: vi.fn(async (callback: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      callback(makeTx())
    ),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.execute.mockClear();
    dbMock.transaction.mockClear();
  };

  return { dbMock, resetDbMockCalls };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
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
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../services/order-number.service.js', () => ({
  getNextPONumber: getNextPONumberMock,
  getNextWONumber: getNextWONumberMock,
  getNextTONumber: getNextTONumberMock,
}));

vi.mock('../services/card-lifecycle.service.js', () => ({
  transitionTriggeredCardToOrdered: transitionTriggeredCardToOrderedMock,
}));

// @ts-expect-error Vitest resolves TS source for route modules in tests.
import { orderQueueRouter } from './order-queue.routes.ts';

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
  app.use('/queue', orderQueueRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function postJson(
  app: express.Express,
  path: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'vitest-agent',
        'x-forwarded-for': '203.0.113.10',
        ...headers,
      },
      body: JSON.stringify(body),
    });

    const json = (await response.json()) as Record<string, any>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function getJson(
  app: express.Express,
  path: string
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: {
        'user-agent': 'vitest-agent',
        'x-forwarded-for': '203.0.113.10',
      },
    });

    const json = (await response.json()) as Record<string, any>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('order queue endpoint integration', () => {
  beforeEach(() => {
    testState.selectResults = [];
    testState.insertedAuditRows = [];
    testState.loopByCardId = {};
    resetDbMockCalls();
    publishMock.mockClear();
    getEventBusMock.mockClear();
    getNextPONumberMock.mockReset();
    getNextWONumberMock.mockReset();
    getNextTONumberMock.mockReset();
    getNextPONumberMock.mockResolvedValue('PO-20260209-0001');
    getNextWONumberMock.mockResolvedValue('WO-20260209-0001');
    getNextTONumberMock.mockResolvedValue('TO-20260209-0001');
    transitionTriggeredCardToOrderedMock.mockClear();
  });

  it('create-po writes order and card audits and emits events', async () => {
    testState.selectResults = [
      [
        { id: 'card-1', tenantId: 'tenant-1', currentStage: 'triggered', loopId: 'loop-1', completedCycles: 0 },
        { id: 'card-2', tenantId: 'tenant-1', currentStage: 'triggered', loopId: 'loop-2', completedCycles: 2 },
      ],
      [
        { id: 'loop-1', loopType: 'procurement', partId: 'part-1', facilityId: 'fac-1', primarySupplierId: 'sup-1', orderQuantity: 10 },
        { id: 'loop-2', loopType: 'procurement', partId: 'part-2', facilityId: 'fac-1', primarySupplierId: 'sup-1', orderQuantity: 20 },
      ],
    ];
    testState.loopByCardId = { 'card-1': 'loop-1', 'card-2': 'loop-2' };

    const app = createTestApp();
    const response = await postJson(app, '/queue/create-po', {
      cardIds: ['card-1', 'card-2'],
      supplierId: 'sup-1',
      facilityId: 'fac-1',
      notes: 'batch from queue',
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        poId: 'po-123',
        poNumber: 'PO-20260209-0001',
        cardsLinked: 2,
      })
    );
    expect(transitionTriggeredCardToOrderedMock).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenCalledTimes(3);

    const orderAudit = testState.insertedAuditRows.find(
      (row) => row.action === 'order_queue.purchase_order_created'
    );
    expect(orderAudit).toBeDefined();
    expect(orderAudit).toEqual(
      expect.objectContaining({
        entityType: 'purchase_order',
        entityId: 'po-123',
        userId: 'user-1',
        ipAddress: '203.0.113.10',
      })
    );

    const cardAudits = testState.insertedAuditRows.filter(
      (row) => row.action === 'kanban_card.transitioned_to_ordered'
    );
    expect(cardAudits).toHaveLength(2);
    expect(cardAudits[0]).toEqual(
      expect.objectContaining({
        entityType: 'kanban_card',
        userId: 'user-1',
      })
    );
  });

  it('create-wo writes audit records and emits events', async () => {
    testState.selectResults = [
      [
        {
          id: 'card-wo-1',
          tenantId: 'tenant-1',
          currentStage: 'triggered',
          loopId: 'loop-wo-1',
          completedCycles: 1,
          loopType: 'production',
          partId: 'part-wo-1',
          facilityId: 'fac-1',
          orderQuantity: 15,
        },
      ],
    ];
    testState.loopByCardId = { 'card-wo-1': 'loop-wo-1' };

    const app = createTestApp();
    const response = await postJson(app, '/queue/create-wo', {
      cardId: 'card-wo-1',
      notes: 'make it',
      routingSteps: [
        {
          workCenterId: 'wc-1',
          stepNumber: 1,
          operationName: 'Cut',
          estimatedMinutes: 30,
        },
      ],
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        woId: 'wo-123',
        woNumber: 'WO-20260209-0001',
      })
    );
    expect(transitionTriggeredCardToOrderedMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledTimes(2);

    expect(
      testState.insertedAuditRows.find((row) => row.action === 'order_queue.work_order_created')
    ).toBeDefined();
    expect(
      testState.insertedAuditRows.find(
        (row) => row.action === 'kanban_card.transitioned_to_ordered'
      )
    ).toBeDefined();
  });

  it('create-to writes audit records and emits events', async () => {
    testState.selectResults = [
      [
        {
          id: 'card-to-1',
          tenantId: 'tenant-1',
          currentStage: 'triggered',
          loopId: 'loop-to-1',
          completedCycles: 0,
          loopType: 'transfer',
          partId: 'part-a',
          facilityId: 'fac-dest',
          sourceFacilityId: 'fac-src',
          orderQuantity: 11,
        },
        {
          id: 'card-to-2',
          tenantId: 'tenant-1',
          currentStage: 'triggered',
          loopId: 'loop-to-2',
          completedCycles: 0,
          loopType: 'transfer',
          partId: 'part-b',
          facilityId: 'fac-dest',
          sourceFacilityId: 'fac-src',
          orderQuantity: 7,
        },
      ],
    ];
    testState.loopByCardId = { 'card-to-1': 'loop-to-1', 'card-to-2': 'loop-to-2' };

    const app = createTestApp();
    const response = await postJson(app, '/queue/create-to', {
      cardIds: ['card-to-1', 'card-to-2'],
      notes: 'transfer batch',
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        toId: 'to-123',
        toNumber: 'TO-20260209-0001',
        cardsLinked: 2,
      })
    );
    expect(transitionTriggeredCardToOrderedMock).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenCalledTimes(3);

    const orderAudit = testState.insertedAuditRows.find(
      (row) => row.action === 'order_queue.transfer_order_created'
    );
    expect(orderAudit).toBeDefined();

    const cardAudits = testState.insertedAuditRows.filter(
      (row) => row.action === 'kanban_card.transitioned_to_ordered'
    );
    expect(cardAudits).toHaveLength(2);
  });

  it('procurement/create-drafts creates facility-grouped draft POs without transitioning cards', async () => {
    const supplierId = '00000000-0000-4000-8000-000000000111';
    const cardOneId = '00000000-0000-4000-8000-000000000201';
    const cardTwoId = '00000000-0000-4000-8000-000000000202';

    testState.selectResults = [
      [
        {
          id: cardOneId,
          currentStage: 'triggered',
          loopId: 'loop-p-1',
          cardNumber: 1,
          loopType: 'procurement',
          partId: 'part-1',
          facilityId: 'fac-1',
          primarySupplierId: supplierId,
          supplierName: 'Acme',
          supplierContactEmail: 'buyer@acme.com',
          supplierContactPhone: '555-0100',
        },
        {
          id: cardTwoId,
          currentStage: 'triggered',
          loopId: 'loop-p-2',
          cardNumber: 2,
          loopType: 'procurement',
          partId: 'part-2',
          facilityId: 'fac-2',
          primarySupplierId: supplierId,
          supplierName: 'Acme',
          supplierContactEmail: 'buyer@acme.com',
          supplierContactPhone: '555-0100',
        },
      ],
      [],
    ];

    const app = createTestApp();
    const response = await postJson(app, '/queue/procurement/create-drafts', {
      supplierId,
      recipientEmail: 'buyer@acme.com',
      lines: [
        {
          cardId: cardOneId,
          quantityOrdered: 5,
          description: 'Widget A',
          orderMethod: 'email',
        },
        {
          cardId: cardTwoId,
          quantityOrdered: 3,
          description: 'Widget B',
          orderMethod: 'online',
          sourceUrl: 'https://vendor.example/item-b',
        },
      ],
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        totalDrafts: 2,
        totalCards: 2,
      })
    );
    expect(transitionTriggeredCardToOrderedMock).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(
      testState.insertedAuditRows.filter(
        (row) => row.action === 'order_queue.procurement_draft_created'
      )
    ).toHaveLength(2);
  });

  it('procurement/create-drafts rejects duplicate open draft cards', async () => {
    const supplierId = '00000000-0000-4000-8000-000000000112';
    const cardId = '00000000-0000-4000-8000-000000000211';

    testState.selectResults = [
      [
        {
          id: cardId,
          currentStage: 'triggered',
          loopId: 'loop-p-1',
          cardNumber: 1,
          loopType: 'procurement',
          partId: 'part-1',
          facilityId: 'fac-1',
          primarySupplierId: supplierId,
          supplierName: 'Acme',
          supplierContactEmail: 'buyer@acme.com',
          supplierContactPhone: '555-0100',
        },
      ],
      [{ cardId, purchaseOrderId: 'po-draft-1', poNumber: 'PO-0001' }],
    ];

    const app = createTestApp();
    const response = await postJson(app, '/queue/procurement/create-drafts', {
      supplierId,
      lines: [
        {
          cardId,
          quantityOrdered: 5,
          description: 'Widget A',
          orderMethod: 'email',
        },
      ],
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('open draft');
    expect(transitionTriggeredCardToOrderedMock).not.toHaveBeenCalled();
  });

  it('procurement/create-drafts enforces method-specific validation', async () => {
    const supplierId = '00000000-0000-4000-8000-000000000113';
    const cardId = '00000000-0000-4000-8000-000000000221';

    testState.selectResults = [
      [
        {
          id: cardId,
          currentStage: 'triggered',
          loopId: 'loop-p-1',
          cardNumber: 1,
          loopType: 'procurement',
          partId: 'part-1',
          facilityId: 'fac-1',
          primarySupplierId: supplierId,
          supplierName: 'Acme',
          supplierContactEmail: null,
          supplierContactPhone: null,
        },
      ],
      [],
    ];

    const app = createTestApp();
    const response = await postJson(app, '/queue/procurement/create-drafts', {
      supplierId,
      lines: [
        {
          cardId,
          quantityOrdered: 5,
          description: 'Widget A',
          orderMethod: 'online',
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Method-specific validation');
    expect(response.body.details.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'lines[0].sourceUrl' })])
    );
  });

  it('procurement/verify marks drafts sent and transitions cards to ordered', async () => {
    const poOneId = '00000000-0000-4000-8000-000000000301';
    const poTwoId = '00000000-0000-4000-8000-000000000302';
    const cardOneId = '00000000-0000-4000-8000-000000000401';
    const cardTwoId = '00000000-0000-4000-8000-000000000402';

    testState.selectResults = [
      [
        {
          id: poOneId,
          poNumber: 'PO-1',
          status: 'draft',
          supplierId: 'sup-1',
          sentToEmail: null,
          supplierContactEmail: 'buyer@acme.com',
        },
        {
          id: poTwoId,
          poNumber: 'PO-2',
          status: 'draft',
          supplierId: 'sup-1',
          sentToEmail: null,
          supplierContactEmail: 'buyer@acme.com',
        },
      ],
      [
        { poId: poOneId, cardId: cardOneId },
        { poId: poTwoId, cardId: cardTwoId },
      ],
      [
        { id: cardOneId, currentStage: 'triggered' },
        { id: cardTwoId, currentStage: 'triggered' },
      ],
    ];
    testState.loopByCardId = { [cardOneId]: 'loop-v-1', [cardTwoId]: 'loop-v-2' };

    const app = createTestApp();
    const response = await postJson(app, '/queue/procurement/verify', {
      poIds: [poOneId, poTwoId],
      cardIds: [cardOneId, cardTwoId],
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({
        poIds: [poOneId, poTwoId],
        transitionedCards: 2,
      })
    );
    expect(transitionTriggeredCardToOrderedMock).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenCalledTimes(4);
    expect(
      testState.insertedAuditRows.filter((row) => row.action === 'purchase_order.status_changed')
    ).toHaveLength(2);
    expect(
      testState.insertedAuditRows.filter((row) => row.action === 'order_queue.procurement_verified')
    ).toHaveLength(2);
  });

  it('GET /queue lists triggered cards with vendor details (supplier name, code, contact, website)', async () => {
    // First select: base cards query
    testState.selectResults = [
      [
        {
          id: 'card-v-1',
          cardNumber: 1,
          currentStage: 'triggered',
          currentStageEnteredAt: '2026-02-14T00:00:00Z',
          linkedPurchaseOrderId: null,
          linkedWorkOrderId: null,
          linkedTransferOrderId: null,
          loopId: 'loop-v-1',
          loopType: 'procurement',
          partId: 'part-v-1',
          partName: 'Widget Alpha',
          partNumber: 'WA-001',
          facilityId: 'fac-v-1',
          facilityName: 'Main Warehouse',
          primarySupplierId: 'sup-v-1',
          supplierName: 'Acme Supplies',
          supplierCode: 'ACME',
          supplierContactName: 'John Doe',
          supplierRecipient: 'John',
          supplierRecipientEmail: 'john@acme.com',
          supplierContactEmail: 'orders@acme.com',
          supplierContactPhone: '555-0100',
          supplierWebsite: 'https://acme.example.com',
          supplierPaymentTerms: 'Net 30',
          supplierShippingTerms: 'FOB Destination',
          supplierLeadTimeDays: 14,
          supplierUnitCost: '12.50',
          partUnitPrice: '25.00',
          sourceFacilityId: null,
          orderQuantity: 100,
          minQuantity: 25,
          numberOfCards: 2,
        },
      ],
    ];
    // Second result: draft PO lookup (db.execute)
    dbMock.execute.mockResolvedValueOnce([]);

    const app = createTestApp();
    const response = await getJson(app, '/queue');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const procurementCards = response.body.data.procurement;
    expect(procurementCards).toHaveLength(1);

    const card = procurementCards[0];
    expect(card.supplierName).toBe('Acme Supplies');
    expect(card.supplierCode).toBe('ACME');
    expect(card.supplierContactName).toBe('John Doe');
    expect(card.supplierWebsite).toBe('https://acme.example.com');
    expect(card.supplierLeadTimeDays).toBe(14);
    expect(card.partName).toBe('Widget Alpha');
    expect(card.partNumber).toBe('WA-001');
    expect(card.facilityName).toBe('Main Warehouse');
  });

  it('GET /queue/:cardId returns structured detail view with nested supplier, part, and facility', async () => {
    testState.selectResults = [
      [
        {
          id: 'card-detail-1',
          cardNumber: 1,
          currentStage: 'triggered',
          currentStageEnteredAt: '2026-02-14T08:00:00Z',
          completedCycles: 3,
          linkedPurchaseOrderId: null,
          linkedWorkOrderId: null,
          linkedTransferOrderId: null,
          loopId: 'loop-detail-1',
          loopType: 'procurement',
          partId: 'part-detail-1',
          partName: 'Bolt M8x30',
          partNumber: 'BLT-M8-30',
          partType: 'component',
          partUom: 'each',
          partUnitCost: '0.35',
          partUnitPrice: '0.75',
          facilityId: 'fac-detail-1',
          facilityName: 'Plant A',
          facilityCode: 'PLT-A',
          primarySupplierId: 'sup-detail-1',
          supplierName: 'FastBolts Inc',
          supplierCode: 'FBLT',
          supplierContactName: 'Jane Smith',
          supplierContactEmail: 'sales@fastbolts.com',
          supplierContactPhone: '555-0200',
          supplierRecipient: 'Receiving Dept',
          supplierRecipientEmail: 'receiving@fastbolts.com',
          supplierWebsite: 'https://fastbolts.example.com',
          supplierPaymentTerms: '2/10 Net 30',
          supplierShippingTerms: 'FOB Origin',
          supplierLeadTimeDays: 7,
          supplierUnitCost: '0.30',
          supplierPartLeadTimeDays: 5,
          sourceFacilityId: null,
          orderQuantity: 500,
          minQuantity: 100,
          numberOfCards: 3,
          statedLeadTimeDays: 7,
        },
      ],
    ];

    const app = createTestApp();
    const response = await getJson(app, '/queue/card-detail-1');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const data = response.body.data;
    expect(data.id).toBe('card-detail-1');
    expect(data.loopType).toBe('procurement');
    expect(data.orderQuantity).toBe(500);

    // Nested part object
    expect(data.part).toEqual({
      id: 'part-detail-1',
      name: 'Bolt M8x30',
      partNumber: 'BLT-M8-30',
      type: 'component',
      uom: 'each',
      unitCost: '0.35',
      unitPrice: '0.75',
    });

    // Nested facility object
    expect(data.facility).toEqual({
      id: 'fac-detail-1',
      name: 'Plant A',
      code: 'PLT-A',
    });

    // Nested supplier object with all vendor details
    expect(data.supplier).toEqual({
      id: 'sup-detail-1',
      name: 'FastBolts Inc',
      code: 'FBLT',
      contactName: 'Jane Smith',
      contactEmail: 'sales@fastbolts.com',
      contactPhone: '555-0200',
      recipient: 'Receiving Dept',
      recipientEmail: 'receiving@fastbolts.com',
      website: 'https://fastbolts.example.com',
      paymentTerms: '2/10 Net 30',
      shippingTerms: 'FOB Origin',
      statedLeadTimeDays: 7,
      unitCost: '0.30',
      partLeadTimeDays: 5,
    });
  });

  it('GET /queue/:cardId returns 404 for non-existent card', async () => {
    testState.selectResults = [[]];

    const app = createTestApp();
    const response = await getJson(app, '/queue/non-existent-id');

    expect(response.status).toBe(404);
    expect(response.body.error).toContain('Card not found');
  });

  it('GET /queue/:cardId returns null supplier when card has no primary supplier', async () => {
    testState.selectResults = [
      [
        {
          id: 'card-no-sup-1',
          cardNumber: 1,
          currentStage: 'triggered',
          currentStageEnteredAt: '2026-02-14T10:00:00Z',
          completedCycles: 0,
          linkedPurchaseOrderId: null,
          linkedWorkOrderId: null,
          linkedTransferOrderId: null,
          loopId: 'loop-no-sup-1',
          loopType: 'production',
          partId: 'part-no-sup-1',
          partName: 'Assembly X',
          partNumber: 'ASM-X',
          partType: 'subassembly',
          partUom: 'each',
          partUnitCost: '50.00',
          partUnitPrice: '100.00',
          facilityId: 'fac-no-sup-1',
          facilityName: 'Plant B',
          facilityCode: 'PLT-B',
          primarySupplierId: null,
          supplierName: null,
          supplierCode: null,
          supplierContactName: null,
          supplierContactEmail: null,
          supplierContactPhone: null,
          supplierRecipient: null,
          supplierRecipientEmail: null,
          supplierWebsite: null,
          supplierPaymentTerms: null,
          supplierShippingTerms: null,
          supplierLeadTimeDays: null,
          supplierUnitCost: null,
          supplierPartLeadTimeDays: null,
          sourceFacilityId: null,
          orderQuantity: 10,
          minQuantity: 5,
          numberOfCards: 1,
          statedLeadTimeDays: 3,
        },
      ],
    ];

    const app = createTestApp();
    const response = await getJson(app, '/queue/card-no-sup-1');

    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.supplier).toBeNull();
    expect(data.part).toEqual(
      expect.objectContaining({
        id: 'part-no-sup-1',
        name: 'Assembly X',
      })
    );
    expect(data.facility).toEqual(
      expect.objectContaining({
        id: 'fac-no-sup-1',
        name: 'Plant B',
      })
    );
  });
});
