import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

const configMock = vi.hoisted(() => ({
  serviceUrls: {
    kanban: 'http://kanban.test',
  },
}));

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name } as const);
  return {
    parts: table('parts'),
    facilities: table('facilities'),
    suppliers: table('suppliers'),
    kanbanLoops: table('kanbanLoops'),
    kanbanCards: table('kanbanCards'),
    kanbanParameterHistory: table('kanbanParameterHistory'),
  };
});

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  loop: {
    id: 'loop-1',
    tenantId: 'tenant-1',
    partId: 'part-1',
    facilityId: 'fac-1',
    loopType: 'procurement',
    cardMode: 'single',
    status: 'active',
    numberOfCards: 3,
    minQuantity: 12,
    orderQuantity: 30,
    statedLeadTimeDays: 5,
    safetyStockDays: '2',
    reorderPoint: null,
    primarySupplierId: 'sup-1',
    sourceFacilityId: null,
    storageLocationId: null,
    notes: null,
    createdAt: new Date('2026-02-11T00:00:00.000Z'),
    updatedAt: new Date('2026-02-11T00:00:00.000Z'),
    cards: [
      {
        id: 'card-1',
        tenantId: 'tenant-1',
        loopId: 'loop-1',
        cardNumber: 1,
        currentStage: 'triggered',
        currentStageEnteredAt: new Date('2026-02-11T00:10:00.000Z'),
        linkedPurchaseOrderId: null,
        linkedWorkOrderId: null,
        linkedTransferOrderId: null,
        lastPrintedAt: null,
        printCount: 0,
        completedCycles: 0,
        isActive: true,
        createdAt: new Date('2026-02-11T00:00:00.000Z'),
        updatedAt: new Date('2026-02-11T00:10:00.000Z'),
      },
    ],
    parameterHistory: [
      {
        id: 'hist-1',
        loopId: 'loop-1',
        parameter: 'orderQuantity',
        oldValue: '20',
        newValue: '30',
        createdAt: new Date('2026-02-11T00:05:00.000Z'),
      },
    ],
  } as Record<string, unknown>,
  partRows: [{ id: 'part-1', name: 'Lean Bolt', partNumber: 'LB-100' }] as Row[],
  facilityRows: [{ id: 'fac-1', name: 'Main Plant' }] as Row[],
  supplierRows: [{ id: 'sup-1', name: 'Flow Supplier' }] as Row[],
}));

const dbMock = vi.hoisted(() => ({
  query: {
    kanbanLoops: {
      findFirst: vi.fn(async () => state.loop),
    },
  },
  select: vi.fn((selection: Record<string, unknown>) => ({
    from: vi.fn((table: { __table?: string }) => ({
      where: vi.fn(() => ({
        execute: vi.fn(async () => {
          const tableName = table.__table ?? '';
          if (tableName === 'parts') return state.partRows;
          if (tableName === 'facilities') return state.facilityRows;
          if (tableName === 'suppliers') return state.supplierRows;
          if (tableName === 'kanbanLoops') return [state.loop];
          if ('count' in selection) return [{ count: 1 }];
          return [];
        }),
      })),
    })),
  })),
}));

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

vi.mock('@arda/config', () => configMock);
vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  gt: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

import { kanbanCompatRouter } from './kanban-compat.routes.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { user?: { tenantId: string; sub: string } }).user = {
      tenantId: 'tenant-1',
      sub: 'user-1',
    };
    next();
  });
  app.use('/loops', kanbanCompatRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  });
  return app;
}

async function getJson(app: express.Express, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await nativeFetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: {
        authorization: 'Bearer test-token',
      },
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('kanban compat loop detail fallback', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    dbMock.query.kanbanLoops.findFirst.mockReset();
    dbMock.query.kanbanLoops.findFirst.mockResolvedValue(state.loop);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'upstream unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('returns enriched read-only loop detail from local fallback when upstream is unavailable', async () => {
    const app = createApp();
    const response = await getJson(app, '/loops/loop-1');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`${configMock.serviceUrls.kanban}/loops/loop-1`),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
    expect(response.body).toEqual(
      expect.objectContaining({
        id: 'loop-1',
        partName: 'Lean Bolt',
        partNumber: 'LB-100',
        facilityName: 'Main Plant',
        primarySupplierName: 'Flow Supplier',
      }),
    );

    const cards = (response.body.cards ?? []) as Array<Record<string, unknown>>;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual(
      expect.objectContaining({
        id: 'card-1',
        loopType: 'procurement',
        partId: 'part-1',
        partName: 'Lean Bolt',
        partNumber: 'LB-100',
        facilityName: 'Main Plant',
        supplierName: 'Flow Supplier',
        minQuantity: 12,
        orderQuantity: 30,
        numberOfCards: 3,
      }),
    );

    const history = (response.body.parameterHistory ?? []) as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(expect.objectContaining({ id: 'hist-1' }));
  });

  it('falls back on upstream 500 responses', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'upstream internal error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const app = createApp();
    const response = await getJson(app, '/loops/loop-1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: 'loop-1',
        partName: 'Lean Bolt',
      }),
    );
  });
});
