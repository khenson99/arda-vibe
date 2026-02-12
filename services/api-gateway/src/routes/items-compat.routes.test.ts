import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

const state = vi.hoisted(() => ({
  catalogParts: [
    {
      id: 'part-1',
      partNumber: 'ITEM-100',
      name: 'Existing Item',
      type: 'component',
      uom: 'each',
      isActive: true,
      orderMechanism: 'purchase_order',
      location: null,
      minQty: 1,
      minQtyUnit: 'each',
      orderQty: 1,
      orderQtyUnit: 'each',
      primarySupplierName: 'Legacy Supplier',
      primarySupplierLink: null,
      itemNotes: null,
      glCode: null,
      itemSubtype: null,
      description: null,
      specifications: {},
      imageUrl: null,
      updatedAt: '2026-02-11T00:00:00.000Z',
      createdAt: '2026-02-11T00:00:00.000Z',
    },
  ] as Array<Record<string, unknown>>,
}));

const configMock = vi.hoisted(() => ({
  serviceUrls: {
    catalog: 'http://catalog.test',
    kanban: 'http://kanban.test',
  },
}));

const dbMock = vi.hoisted(() => ({
  query: {
    kanbanLoops: {
      findFirst: vi.fn(async () => null),
    },
    facilities: {
      findFirst: vi.fn(async () => null),
    },
    suppliers: {
      findFirst: vi.fn(async () => null),
    },
  },
  insert: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@arda/config', () => configMock);
vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: {
    facilities: {},
    suppliers: {},
    kanbanLoops: {},
    kanbanCards: {},
    kanbanParameterHistory: {},
  },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  gt: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

import { itemsCompatRouter } from './items-compat.routes.js';

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
  app.use(itemsCompatRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  });
  return app;
}

async function requestJson(input: {
  app: express.Express;
  method: 'PUT' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = input.app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await nativeFetch(`http://127.0.0.1:${address.port}${input.path}`, {
      method: input.method,
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function mockCatalogFetch() {
  fetchMock.mockImplementation(async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.origin === configMock.serviceUrls.catalog) {
      if (method === 'GET' && url.pathname === '/parts') {
        const search = (url.searchParams.get('search') ?? '').trim().toLowerCase();
        const page = Number(url.searchParams.get('page') ?? '1');
        const pageSize = Number(url.searchParams.get('pageSize') ?? '25');

        const allRows = state.catalogParts.filter((part) => {
          const partNumber = String(part.partNumber ?? '').toLowerCase();
          if (!search) return true;
          return partNumber.includes(search);
        });

        const start = (Math.max(1, page) - 1) * Math.max(1, pageSize);
        const paged = allRows.slice(start, start + pageSize);
        return new Response(
          JSON.stringify({
            data: paged,
            pagination: {
              totalPages: 1,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (method === 'PATCH' && url.pathname.startsWith('/parts/')) {
        const partId = url.pathname.split('/').pop() ?? '';
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const index = state.catalogParts.findIndex((part) => part.id === partId);
        if (index === -1) {
          return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        }
        const next = {
          ...state.catalogParts[index],
          ...body,
          updatedAt: '2026-02-11T01:00:00.000Z',
        };
        state.catalogParts[index] = next;
        return new Response(JSON.stringify(next), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: `Unexpected fetch: ${method} ${rawUrl}` }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('items compat persistence', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    dbMock.query.kanbanLoops.findFirst.mockReset();
    state.catalogParts = [
      {
        id: 'part-1',
        partNumber: 'ITEM-100',
        name: 'Existing Item',
        type: 'component',
        uom: 'each',
        isActive: true,
        orderMechanism: 'purchase_order',
        location: null,
        minQty: 1,
        minQtyUnit: 'each',
        orderQty: 1,
        orderQtyUnit: 'each',
        primarySupplierName: 'Legacy Supplier',
        primarySupplierLink: null,
        itemNotes: null,
        glCode: null,
        itemSubtype: null,
        description: null,
        specifications: {},
        imageUrl: null,
        updatedAt: '2026-02-11T00:00:00.000Z',
        createdAt: '2026-02-11T00:00:00.000Z',
      },
    ];
    mockCatalogFetch();
  });

  it('round-trips persisted order/qty/supplier/location/notes/glCode/subtype via put then query', async () => {
    const app = createApp();

    const putResponse = await requestJson({
      app,
      method: 'PUT',
      path: '/item/ITEM-100',
      body: {
        payload: {
          externalGuid: 'ITEM-100',
          name: 'Lean Fastener',
          orderMechanism: 'rfq',
          location: 'Aisle 4',
          minQty: 12,
          minQtyUnit: 'box',
          orderQty: 30,
          orderQtyUnit: 'box',
          primarySupplier: 'Flow Supplier',
          primarySupplierLink: 'https://supplier.example/item-100',
          notes: 'Expedite during shutdown week',
          glCode: 'GL-4100',
          itemSubtype: 'consumable',
          imageUrl: null,
        },
      },
    });

    expect(putResponse.status).toBe(200);
    expect(putResponse.body).toEqual(
      expect.objectContaining({
        accepted: true,
        entityId: 'ITEM-100',
        partId: 'part-1',
      }),
    );
    expect(dbMock.query.kanbanLoops.findFirst).not.toHaveBeenCalled();

    const queryResponse = await requestJson({
      app,
      method: 'POST',
      path: '/item/query',
      body: {
        paginate: { index: 0, size: 50 },
      },
    });

    expect(queryResponse.status).toBe(200);
    const results = (queryResponse.body.results ?? []) as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);

    const row = results.find((entry) => {
      const payload = entry.payload as Record<string, unknown>;
      return payload.externalGuid === 'ITEM-100';
    }) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    const payload = row?.payload as Record<string, unknown>;

    expect(payload).toEqual(
      expect.objectContaining({
        externalGuid: 'ITEM-100',
        name: 'Lean Fastener',
        orderMechanism: 'rfq',
        location: 'Aisle 4',
        minQty: 12,
        minQtyUnit: 'box',
        orderQty: 30,
        orderQtyUnit: 'box',
        primarySupplier: 'Flow Supplier',
        primarySupplierLink: 'https://supplier.example/item-100',
        notes: 'Expedite during shutdown week',
        glCode: 'GL-4100',
        itemSubtype: 'consumable',
      }),
    );
  });
});
