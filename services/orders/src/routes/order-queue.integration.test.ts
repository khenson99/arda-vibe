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
    transaction: vi.fn(async (callback: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      callback(makeTx())
    ),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
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
});
