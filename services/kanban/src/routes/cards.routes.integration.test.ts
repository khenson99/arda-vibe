import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const schemaMock = vi.hoisted(() => ({
  kanbanCards: {},
  kanbanLoops: {},
  cardStageTransitions: {
    transitionedAt: {},
  },
  parts: {
    id: {},
    tenantId: {},
  },
  facilities: {
    id: {},
    tenantId: {},
  },
  storageLocations: {
    id: {},
    tenantId: {},
  },
  suppliers: {
    id: {},
    tenantId: {},
  },
  cardStageEnum: {
    enumValues: ['created', 'triggered', 'ordered', 'in_transit', 'received', 'restocked'] as const,
  },
  loopTypeEnum: {
    enumValues: ['procurement', 'production', 'transfer'] as const,
  },
}));

const state = vi.hoisted(() => ({
  card: {
    id: 'card-1',
    tenantId: 'tenant-1',
    loopId: 'loop-1',
    cardNumber: 2,
    currentStage: 'triggered',
    currentStageEnteredAt: new Date('2026-02-11T00:00:00.000Z'),
    linkedPurchaseOrderId: null,
    linkedWorkOrderId: null,
    linkedTransferOrderId: null,
    lastPrintedAt: null,
    printCount: 0,
    completedCycles: 0,
    isActive: true,
    createdAt: new Date('2026-02-11T00:00:00.000Z'),
    updatedAt: new Date('2026-02-11T00:00:00.000Z'),
    loop: {
      id: 'loop-1',
      tenantId: 'tenant-1',
      partId: 'part-1',
      facilityId: 'fac-1',
      primarySupplierId: 'sup-1',
      sourceFacilityId: 'fac-2',
      storageLocationId: 'loc-1',
      loopType: 'procurement',
      numberOfCards: 4,
      minQuantity: 10,
      orderQuantity: 24,
      statedLeadTimeDays: 5,
      safetyStockDays: '2',
      notes: 'Keep two bins in rotation',
    },
  } as Record<string, unknown> | null,
  part: {
    id: 'part-1',
    tenantId: 'tenant-1',
    partNumber: 'LB-100',
    name: 'Lean Bolt',
    description: 'M8 bolt',
    type: 'component',
    uom: 'each',
    unitPrice: '12.5000',
    orderMechanism: 'purchase_order',
    location: 'Aisle A',
    minQty: 10,
    minQtyUnit: 'each',
    orderQty: 24,
    orderQtyUnit: 'each',
    primarySupplierName: 'Flow Supplier',
    primarySupplierLink: 'https://supplier.example/flow-supplier',
    glCode: 'GL-100',
    itemSubtype: 'fastener',
    updatedAt: new Date('2026-02-11T00:00:00.000Z'),
    imageUrl: 'https://example.com/lean-bolt.png',
    itemNotes: 'Use coated variant for humid zones',
  } as Record<string, unknown> | null,
  facility: {
    id: 'fac-1',
    tenantId: 'tenant-1',
    name: 'Main Plant',
  } as Record<string, unknown> | null,
  storageLocation: {
    id: 'loc-1',
    tenantId: 'tenant-1',
    name: 'Aisle A',
  } as Record<string, unknown> | null,
  supplier: {
    id: 'sup-1',
    tenantId: 'tenant-1',
    name: 'Flow Supplier',
  } as Record<string, unknown> | null,
  sourceFacility: {
    id: 'fac-2',
    tenantId: 'tenant-1',
    name: 'Upstream Plant',
  } as Record<string, unknown> | null,
}));

const dbMock = vi.hoisted(() => ({
  query: {
    kanbanCards: {
      findFirst: vi.fn(async () => state.card),
    },
    parts: {
      findFirst: vi.fn(async () => state.part),
    },
    facilities: {
      findFirst: vi
        .fn(async () => state.facility)
        .mockImplementationOnce(async () => state.facility)
        .mockImplementationOnce(async () => state.sourceFacility),
    },
    storageLocations: {
      findFirst: vi.fn(async () => state.storageLocation),
    },
    suppliers: {
      findFirst: vi.fn(async () => state.supplier),
    },
  },
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            leftJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  offset: vi.fn(async () => []),
                })),
              })),
            })),
          })),
        })),
      })),
      where: vi.fn(async () => [{ count: 0 }]),
    })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
  })),
}));

const generateQRDataUrlMock = vi.hoisted(() => vi.fn(async () => 'data:image/png;base64,abc123'));
const buildScanUrlMock = vi.hoisted(() => vi.fn(() => 'https://scan.example/card-1'));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));
vi.mock('../services/card-lifecycle.service.js', () => ({
  transitionCard: vi.fn(),
  getCardHistory: vi.fn(),
}));
vi.mock('../utils/qr-generator.js', () => ({
  generateQRDataUrl: generateQRDataUrlMock,
  generateQRSvg: vi.fn(),
  buildScanUrl: buildScanUrlMock,
}));

import { cardsRouter } from './cards.routes.js';

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
  app.use('/cards', cardsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = typeof err === 'object' && err && 'statusCode' in err ? Number((err as { statusCode: number }).statusCode) : 500;
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(statusCode).json({ error: message });
  });
  return app;
}

async function getJson(app: express.Express, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('cards print detail route', () => {
  beforeEach(() => {
    generateQRDataUrlMock.mockClear();
    buildScanUrlMock.mockClear();
    dbMock.query.kanbanCards.findFirst.mockResolvedValue(state.card);
    dbMock.query.parts.findFirst.mockResolvedValue(state.part);
    dbMock.query.storageLocations.findFirst.mockResolvedValue(state.storageLocation);
    dbMock.query.suppliers.findFirst.mockResolvedValue(state.supplier);
    dbMock.query.facilities.findFirst
      .mockReset()
      .mockImplementationOnce(async () => state.facility)
      .mockImplementationOnce(async () => state.sourceFacility);
  });

  it('returns complete print-detail payload with linked loop/item/facility/supplier context', async () => {
    const app = createApp();
    const response = await getJson(app, '/cards/card-1/print-detail');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: 'card-1',
        cardNumber: 2,
        currentStage: 'triggered',
        loopType: 'procurement',
        partName: 'Lean Bolt',
        partNumber: 'LB-100',
        imageUrl: 'https://example.com/lean-bolt.png',
        itemNotes: 'Use coated variant for humid zones',
        facilityName: 'Main Plant',
        minQuantity: 10,
        orderQuantity: 24,
        qrCode: 'data:image/png;base64,abc123',
        scanUrl: 'https://scan.example/card-1',
      }),
    );
    const loop = response.body.loop as Record<string, unknown>;
    expect(loop).toEqual(
      expect.objectContaining({
        loopType: 'procurement',
        numberOfCards: 4,
        partNumber: 'LB-100',
        partName: 'Lean Bolt',
        partDescription: 'M8 bolt',
        facilityName: 'Main Plant',
        storageLocationName: 'Aisle A',
        primarySupplierName: 'Flow Supplier',
        sourceFacilityName: 'Upstream Plant',
        orderQuantity: 24,
        minQuantity: 10,
        statedLeadTimeDays: 5,
        safetyStockDays: 2,
        notes: 'Keep two bins in rotation',
        imageUrl: 'https://example.com/lean-bolt.png',
        itemNotes: 'Use coated variant for humid zones',
      }),
    );
    const part = response.body.part as Record<string, unknown>;
    expect(part).toEqual(
      expect.objectContaining({
        partNumber: 'LB-100',
        name: 'Lean Bolt',
        type: 'component',
        uom: 'each',
        unitPrice: '12.5000',
        orderMechanism: 'purchase_order',
        location: 'Aisle A',
        minQty: 10,
        minQtyUnit: 'each',
        orderQty: 24,
        orderQtyUnit: 'each',
        primarySupplierName: 'Flow Supplier',
        primarySupplierLink: 'https://supplier.example/flow-supplier',
        glCode: 'GL-100',
        itemSubtype: 'fastener',
        itemNotes: 'Use coated variant for humid zones',
        imageUrl: 'https://example.com/lean-bolt.png',
        updatedAt: '2026-02-11T00:00:00.000Z',
      }),
    );
  });

  it('returns 404 when card does not exist', async () => {
    dbMock.query.kanbanCards.findFirst.mockResolvedValueOnce(null);
    const app = createApp();
    const response = await getJson(app, '/cards/missing-card/print-detail');

    expect(response.status).toBe(404);
    expect(response.body).toEqual(expect.objectContaining({ error: 'Card not found' }));
  });
});
