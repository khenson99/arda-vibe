import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  existingLoop: null as null | Record<string, unknown>,
  updatedLoop: null as null | Record<string, unknown>,
  auditEntries: [] as Array<Record<string, unknown>>,
  selectResults: [] as Array<Record<string, unknown>>,
  recommendation: null as null | Record<string, unknown>,
  parameterHistoryRows: [] as Array<Record<string, unknown>>,
}));

const { publishMock, getEventBusMock } = vi.hoisted(() => {
  const publishMock = vi.fn(async () => undefined);
  const getEventBusMock = vi.fn(() => ({ publish: publishMock }));
  return { publishMock, getEventBusMock };
});

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name } as const);
  return {
    kanbanLoops: table('kanban_loops'),
    kanbanCards: table('kanban_cards'),
    kanbanParameterHistory: table('kanban_parameter_history'),
    reloWisaRecommendations: table('relowisa_recommendations'),
    loopTypeEnum: {
      enumValues: ['procurement', 'production', 'transfer'] as const,
    },
    parts: table('parts'),
    facilities: table('facilities'),
    suppliers: table('suppliers'),
  };
});

const { dbMock, resetDbMocks, selectMock, updateMock } = vi.hoisted(() => {
  const selectMock = vi.fn();
  const updateMock = vi.fn();

  const chainableSelect = () => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      execute: vi.fn(async () => testState.selectResults),
      then: (resolve: (val: unknown) => unknown) => resolve(testState.selectResults),
    };
    return chain;
  };

  selectMock.mockImplementation(chainableSelect);

  const chainableUpdate = () => {
    const chain = {
      set: vi.fn(() => chain),
      where: vi.fn(async () => []),
    };
    return chain;
  };
  updateMock.mockImplementation(chainableUpdate);

  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn(async () => []),
    })),
    update: vi.fn(chainableUpdate),
  };

  let findFirstCallCount = 0;
  const findFirstMock = vi.fn(async () => {
    findFirstCallCount++;
    if (findFirstCallCount === 1) {
      return testState.existingLoop;
    }
    return testState.updatedLoop ?? testState.existingLoop;
  });

  const dbMock = {
    query: {
      kanbanLoops: {
        findFirst: findFirstMock,
      },
    },
    select: selectMock,
    update: updateMock,
    transaction: vi.fn(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };

  const resetDbMocks = () => {
    findFirstCallCount = 0;
    dbMock.query.kanbanLoops.findFirst.mockClear();
    dbMock.transaction.mockClear();
    tx.insert.mockClear();
    tx.update.mockClear();
    selectMock.mockClear();
    selectMock.mockImplementation(chainableSelect);
    updateMock.mockClear();
    updateMock.mockImplementation(chainableUpdate);
  };

  return { dbMock, resetDbMocks, selectMock, updateMock };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
  gt: vi.fn(() => ({})),
}));

const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.auditEntries.push(entry);
    return {
      id: 'audit-' + testState.auditEntries.length,
      hashChain: 'mock',
      sequenceNumber: testState.auditEntries.length,
    };
  }),
);

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: mockWriteAuditEntry,
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/events', () => ({
  getEventBus: getEventBusMock,
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

import { reloWisaRouter } from './relowisa.routes.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      tenantId: 'tenant-1',
      sub: 'user-1',
    };
    next();
  });
  app.use('/loops', reloWisaRouter);
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err?.statusCode ?? 500).json({
        error: err?.message ?? 'Internal server error',
      });
    },
  );
  return app;
}

async function request(
  app: express.Express,
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }
    const opts: RequestInit = {
      method,
      headers: { 'content-type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const response = await fetch(
      `http://127.0.0.1:${address.port}${path}`,
      opts,
    );
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ─── Test Data ────────────────────────────────────────────────────────

const baseLoop = {
  id: 'loop-1',
  tenantId: 'tenant-1',
  partId: 'part-1',
  facilityId: 'facility-1',
  loopType: 'procurement',
  cardMode: 'multi',
  minQuantity: 10,
  orderQuantity: 25,
  numberOfCards: 3,
  wipLimit: 5,
  safetyStockDays: '2.0',
  statedLeadTimeDays: 7,
  primarySupplierId: 'supplier-1',
  sourceFacilityId: null,
  storageLocationId: null,
  isActive: true,
  notes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── GET /:loopId/relowisa ────────────────────────────────────────────

describe('GET /loops/:loopId/relowisa', () => {
  beforeEach(() => {
    testState.existingLoop = { ...baseLoop };
    testState.updatedLoop = null;
    testState.selectResults = [];
    testState.auditEntries = [];
    resetDbMocks();
    publishMock.mockReset();
    mockWriteAuditEntry.mockClear();
  });

  it('returns ReLoWiSa metrics for a loop', async () => {
    // Mock cards (2 in-flight: triggered + ordered, 1 created)
    const cardSelectResults = [
      { currentStage: 'triggered' },
      { currentStage: 'ordered' },
      { currentStage: 'created' },
    ];

    // First select call: active cards
    // Second select call: recommendations
    // Third select call: parameter history
    let selectCallCount = 0;
    selectMock.mockImplementation(() => {
      selectCallCount++;
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        execute: vi.fn(async () => {
          if (selectCallCount === 1) return cardSelectResults;
          if (selectCallCount === 2) return []; // no pending recommendations
          return []; // no recent changes
        }),
        then: (resolve: (val: unknown) => unknown) => {
          if (selectCallCount === 1) return resolve(cardSelectResults);
          return resolve([]);
        },
      };
      return chain;
    });

    const app = createApp();
    const res = await request(app, 'GET', '/loops/loop-1/relowisa');

    expect(res.status).toBe(200);
    expect(res.body.loopId).toBe('loop-1');

    const metrics = res.body.metrics as Record<string, unknown>;
    expect(metrics).toBeDefined();
    expect(metrics.reorderPoint).toBe(10);
    expect(metrics.lotSize).toBe(25);
    expect(metrics.wipLimit).toBe(5);
    expect(metrics.safetyStockDays).toBe(2);
    expect(metrics.leadTimeDays).toBe(7);
    expect(metrics.numberOfCards).toBe(3);
    expect(metrics.inFlightCards).toBe(2);
    expect(metrics.inFlightQuantity).toBe(50); // 2 cards * 25 qty
    expect(metrics.wipUtilization).toBe(40); // 2/5 * 100
    expect(metrics.nearReorderPoint).toBe(false); // 50 > 10 * 1.2
    expect(metrics.atWipLimit).toBe(false); // 2 < 5
    expect(metrics.belowSafetyStock).toBe(false); // 50 > 10
  });

  it('returns 404 for non-existent loop', async () => {
    testState.existingLoop = null;
    const app = createApp();
    const res = await request(app, 'GET', '/loops/nonexistent/relowisa');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Kanban loop not found');
  });

  it('detects at-wip-limit threshold', async () => {
    testState.existingLoop = { ...baseLoop, wipLimit: 2 };
    const cardSelectResults = [
      { currentStage: 'triggered' },
      { currentStage: 'ordered' },
      { currentStage: 'created' },
    ];

    let selectCallCount = 0;
    selectMock.mockImplementation(() => {
      selectCallCount++;
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        execute: vi.fn(async () => {
          if (selectCallCount === 1) return cardSelectResults;
          return [];
        }),
        then: (resolve: (val: unknown) => unknown) => {
          if (selectCallCount === 1) return resolve(cardSelectResults);
          return resolve([]);
        },
      };
      return chain;
    });

    const app = createApp();
    const res = await request(app, 'GET', '/loops/loop-1/relowisa');

    expect(res.status).toBe(200);
    const metrics = res.body.metrics as Record<string, unknown>;
    expect(metrics.atWipLimit).toBe(true);
    expect(metrics.wipUtilization).toBe(100);
  });

  it('detects near-reorder-point threshold', async () => {
    testState.existingLoop = { ...baseLoop, minQuantity: 50 };
    const cardSelectResults = [
      { currentStage: 'triggered' },
      { currentStage: 'created' },
      { currentStage: 'created' },
    ];

    let selectCallCount = 0;
    selectMock.mockImplementation(() => {
      selectCallCount++;
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        execute: vi.fn(async () => {
          if (selectCallCount === 1) return cardSelectResults;
          return [];
        }),
        then: (resolve: (val: unknown) => unknown) => {
          if (selectCallCount === 1) return resolve(cardSelectResults);
          return resolve([]);
        },
      };
      return chain;
    });

    const app = createApp();
    const res = await request(app, 'GET', '/loops/loop-1/relowisa');

    expect(res.status).toBe(200);
    const metrics = res.body.metrics as Record<string, unknown>;
    // inFlightQuantity = 1 * 25 = 25, reorderPoint = 50, 25 <= 50*1.2 = 60
    expect(metrics.nearReorderPoint).toBe(true);
    expect(metrics.belowSafetyStock).toBe(true); // 25 < 50
  });
});

// ─── PUT /:loopId/relowisa ────────────────────────────────────────────

describe('PUT /loops/:loopId/relowisa', () => {
  beforeEach(() => {
    testState.existingLoop = { ...baseLoop };
    testState.updatedLoop = { ...baseLoop, minQuantity: 15, wipLimit: 4 };
    testState.selectResults = [];
    testState.auditEntries = [];
    resetDbMocks();
    publishMock.mockReset();
    mockWriteAuditEntry.mockClear();

    // Mock select for post-update card fetch
    selectMock.mockImplementation(() => {
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        execute: vi.fn(async () => [{ currentStage: 'created' }]),
        then: (resolve: (val: unknown) => unknown) =>
          resolve([{ currentStage: 'created' }]),
      };
      return chain;
    });
  });

  it('updates ReLoWiSa parameters and returns recalculated metrics', async () => {
    const app = createApp();
    const res = await request(app, 'PUT', '/loops/loop-1/relowisa', {
      reorderPoint: 15,
      wipLimit: 4,
      reason: 'Seasonal adjustment',
    });

    expect(res.status).toBe(200);
    expect(res.body.loopId).toBe('loop-1');
    expect(res.body.metrics).toBeDefined();
    expect(res.body.updatedAt).toBeDefined();
  });

  it('writes audit entry for relowisa update', async () => {
    const app = createApp();
    await request(app, 'PUT', '/loops/loop-1/relowisa', {
      reorderPoint: 15,
      lotSize: 30,
      reason: 'Demand adjustment',
    });

    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const entry = testState.auditEntries[0];
    expect(entry.action).toBe('loop.relowisa_updated');
    expect(entry.entityType).toBe('kanban_loop');
    expect(entry.entityId).toBe('loop-1');
    expect(entry.previousState).toEqual(
      expect.objectContaining({
        reorderPoint: 10,
        lotSize: 25,
      }),
    );
    expect(entry.newState).toEqual(
      expect.objectContaining({
        reorderPoint: 15,
        lotSize: 30,
      }),
    );
    expect(entry.metadata).toEqual({ reason: 'Demand adjustment' });
  });

  it('publishes loop.parameters_changed event', async () => {
    const app = createApp();
    await request(app, 'PUT', '/loops/loop-1/relowisa', {
      safetyStockDays: 3,
      reason: 'Increase safety buffer',
    });

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'loop.parameters_changed',
        tenantId: 'tenant-1',
        loopId: 'loop-1',
        changeType: 'manual',
      }),
    );
  });

  it('returns 400 for missing reason', async () => {
    const app = createApp();
    const res = await request(app, 'PUT', '/loops/loop-1/relowisa', {
      reorderPoint: 15,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation error');
  });

  it('returns 404 for non-existent loop', async () => {
    testState.existingLoop = null;
    const app = createApp();
    const res = await request(app, 'PUT', '/loops/loop-1/relowisa', {
      reorderPoint: 15,
      reason: 'Test',
    });

    expect(res.status).toBe(404);
  });

  it('accepts nullable wipLimit to remove limit', async () => {
    const app = createApp();
    const res = await request(app, 'PUT', '/loops/loop-1/relowisa', {
      wipLimit: null,
      reason: 'Remove WIP cap',
    });

    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const entry = testState.auditEntries[0];
    expect(entry.newState).toEqual(
      expect.objectContaining({ wipLimit: null }),
    );
  });
});

// ─── POST /:loopId/relowisa/apply ───────────────────────────────────

describe('POST /loops/:loopId/relowisa/apply', () => {
  const pendingRecommendation = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    tenantId: 'tenant-1',
    loopId: 'loop-1',
    status: 'pending',
    recommendedMinQuantity: 12,
    recommendedOrderQuantity: 30,
    recommendedNumberOfCards: 4,
    recommendedWipLimit: 6,
    confidenceScore: '85.00',
    dataPointsUsed: 10,
    reasoning: 'Based on 10 cycles',
    projectedImpact: {},
    reviewedByUserId: null,
    reviewedAt: null,
    createdAt: new Date(),
  };

  beforeEach(() => {
    testState.existingLoop = { ...baseLoop };
    testState.updatedLoop = {
      ...baseLoop,
      minQuantity: 12,
      orderQuantity: 30,
      numberOfCards: 4,
      wipLimit: 6,
    };
    testState.recommendation = pendingRecommendation;
    testState.selectResults = [];
    testState.auditEntries = [];
    resetDbMocks();
    publishMock.mockReset();
    mockWriteAuditEntry.mockClear();

    // Mock select calls: recommendation lookup then cards
    let selectCallCount = 0;
    selectMock.mockImplementation(() => {
      selectCallCount++;
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        execute: vi.fn(async () => {
          if (selectCallCount === 1) return [pendingRecommendation];
          return [{ currentStage: 'created' }];
        }),
        then: (resolve: (val: unknown) => unknown) => {
          if (selectCallCount === 1) return resolve([pendingRecommendation]);
          return resolve([{ currentStage: 'created' }]);
        },
      };
      return chain;
    });
  });

  it('approves a recommendation and applies values', async () => {
    const app = createApp();
    const res = await request(app, 'POST', '/loops/loop-1/relowisa/apply', {
      recommendationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      action: 'approve',
      reason: 'Looks good',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.recommendationId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(res.body.loopId).toBe('loop-1');
    expect(res.body.metrics).toBeDefined();
  });

  it('writes audit entry for approved recommendation', async () => {
    const app = createApp();
    await request(app, 'POST', '/loops/loop-1/relowisa/apply', {
      recommendationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      action: 'approve',
    });

    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const entry = testState.auditEntries[0];
    expect(entry.action).toBe('loop.relowisa_applied');
    expect(entry.entityType).toBe('kanban_loop');
    expect(entry.previousState).toEqual(
      expect.objectContaining({
        reorderPoint: 10,
        lotSize: 25,
        numberOfCards: 3,
        wipLimit: 5,
      }),
    );
    expect(entry.newState).toEqual(
      expect.objectContaining({
        reorderPoint: 12,
        lotSize: 30,
        numberOfCards: 4,
        wipLimit: 6,
      }),
    );
    expect(entry.metadata).toEqual(
      expect.objectContaining({
        recommendationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        confidenceScore: '85.00',
        dataPointsUsed: 10,
      }),
    );
  });

  it('rejects a recommendation without applying changes', async () => {
    const app = createApp();
    const res = await request(app, 'POST', '/loops/loop-1/relowisa/apply', {
      recommendationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      action: 'reject',
      reason: 'Values too aggressive',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.recommendationId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    // Should NOT apply any parameter changes
    expect(dbMock.transaction).not.toHaveBeenCalled();
    // Should write audit entry for rejection
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const entry = testState.auditEntries[0];
    expect(entry.action).toBe('loop.relowisa_rejected');
  });

  it('returns 400 for already-reviewed recommendation', async () => {
    // Mock recommendation as already approved
    let selectCallCount = 0;
    selectMock.mockImplementation(() => {
      selectCallCount++;
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        execute: vi.fn(async () => {
          if (selectCallCount === 1)
            return [{ ...pendingRecommendation, status: 'approved' }];
          return [];
        }),
        then: (resolve: (val: unknown) => unknown) => {
          if (selectCallCount === 1)
            return resolve([{ ...pendingRecommendation, status: 'approved' }]);
          return resolve([]);
        },
      };
      return chain;
    });

    const app = createApp();
    const res = await request(app, 'POST', '/loops/loop-1/relowisa/apply', {
      recommendationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      action: 'approve',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already been approved');
  });

  it('returns 404 for non-existent recommendation', async () => {
    selectMock.mockImplementation(() => {
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        execute: vi.fn(async () => []),
        then: (resolve: (val: unknown) => unknown) => resolve([]),
      };
      return chain;
    });

    const app = createApp();
    const res = await request(app, 'POST', '/loops/loop-1/relowisa/apply', {
      recommendationId: '00000000-0000-0000-0000-000000000000',
      action: 'approve',
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Recommendation not found');
  });

  it('publishes event after applying recommendation', async () => {
    const app = createApp();
    await request(app, 'POST', '/loops/loop-1/relowisa/apply', {
      recommendationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      action: 'approve',
    });

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'loop.parameters_changed',
        changeType: 'relowisa_approved',
      }),
    );
  });
});
