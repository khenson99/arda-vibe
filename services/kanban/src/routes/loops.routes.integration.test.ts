import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  existingLoop: null as null | Record<string, unknown>,
  updatedLoop: null as null | Record<string, unknown>,
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
  };
});

const { dbMock, resetDbMocks } = vi.hoisted(() => {
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn(async () => []),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
  };

  const findFirstMock = vi.fn(async () => {
    if (findFirstMock.mock.calls.length === 1) {
      return testState.existingLoop;
    }
    return testState.updatedLoop;
  });

  const dbMock = {
    query: {
      kanbanLoops: {
        findFirst: findFirstMock,
      },
    },
    transaction: vi.fn(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)
    ),
  };

  const resetDbMocks = () => {
    dbMock.query.kanbanLoops.findFirst.mockClear();
    dbMock.transaction.mockClear();
    tx.insert.mockClear();
    tx.update.mockClear();
  };

  return { dbMock, resetDbMocks };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
  gt: vi.fn(() => ({})),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'mock', sequenceNumber: 1 })),
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/events', () => ({
  getEventBus: getEventBusMock,
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { loopsRouter } from './loops.routes.js';

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
  app.use('/loops', loopsRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function patchJson(
  app: express.Express,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
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
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postJson(
  app: express.Express,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('loops parameter updates', () => {
  beforeEach(() => {
    testState.existingLoop = {
      id: 'loop-1',
      tenantId: 'tenant-1',
      minQuantity: 10,
      orderQuantity: 20,
      numberOfCards: 3,
    };
    testState.updatedLoop = {
      id: 'loop-1',
      tenantId: 'tenant-1',
      minQuantity: 12,
      orderQuantity: 20,
      numberOfCards: 3,
      cards: [],
    };
    resetDbMocks();
    publishMock.mockReset();
    getEventBusMock.mockClear();
  });

  it('publishes loop.parameters_changed after successful parameter update', async () => {
    const app = createApp();
    const response = await patchJson(app, '/loops/loop-1/parameters', {
      minQuantity: 12,
      reason: 'Raise floor for demand spike',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: 'loop-1',
        minQuantity: 12,
      })
    );
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'loop.parameters_changed',
        tenantId: 'tenant-1',
        loopId: 'loop-1',
        changeType: 'manual',
        reason: 'Raise floor for demand spike',
      })
    );
  });

  it('accepts leadTimeDays and safetyStockDays updates', async () => {
    const app = createApp();
    const response = await patchJson(app, '/loops/loop-1/parameters', {
      leadTimeDays: 7,
      safetyStockDays: 3.5,
      reason: 'Tune replenishment targets',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: 'loop-1',
      })
    );
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('returns success even if loop.parameters_changed publish fails', async () => {
    publishMock.mockRejectedValueOnce(new Error('redis unavailable'));

    const app = createApp();
    const response = await patchJson(app, '/loops/loop-1/parameters', {
      orderQuantity: 30,
      reason: 'Batch size optimization',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: 'loop-1',
      })
    );
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when creating a duplicate loop', async () => {
    dbMock.transaction.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));

    const app = createApp();
    const response = await postJson(app, '/loops', {
      partId: '11111111-1111-1111-1111-111111111111',
      facilityId: '22222222-2222-2222-2222-222222222222',
      loopType: 'production',
      cardMode: 'single',
      minQuantity: 10,
      orderQuantity: 25,
      numberOfCards: 1,
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'A loop already exists for this part, facility, and loop type.',
        code: 'LOOP_ALREADY_EXISTS',
        loopId: 'loop-1',
      })
    );
  });
});
