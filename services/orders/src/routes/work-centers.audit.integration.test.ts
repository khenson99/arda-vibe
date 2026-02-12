import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CENTER_ID = '11111111-1111-4111-8111-111111111111';
const FACILITY_ID = '22222222-2222-4222-8222-222222222222';

const testState = vi.hoisted(() => ({
  dbSelectResults: [] as unknown[],
  txUpdateReturningResults: [] as unknown[],
  insertedAuditRows: [] as Array<Record<string, unknown>>,
}));

const schemaMock = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name } as const);
  return {
    workCenters: table('work_centers'),
    auditLog: table('audit_log'),
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
    builder.execute = async () => result;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  }

  function makeTx() {
    const tx: any = {};
    tx.insert = vi.fn((table: unknown) => ({
      values: (values: unknown) => {
        const tableName = (table as { __table?: string }).__table;

        if (tableName === 'audit_log') {
          if (Array.isArray(values)) {
            testState.insertedAuditRows.push(...(values as Array<Record<string, unknown>>));
          } else {
            testState.insertedAuditRows.push(values as Record<string, unknown>);
          }
          return {
            execute: async () => undefined,
            then: (
              resolve: (value: unknown) => unknown,
              reject?: (reason: unknown) => unknown
            ) => Promise.resolve(undefined).then(resolve, reject),
          };
        }

        if (tableName === 'work_centers') {
          const row = values as Record<string, unknown>;
          return {
            returning: async () => [
              {
                id: CENTER_ID,
                tenantId: row.tenantId,
                facilityId: row.facilityId,
                name: row.name,
                code: row.code,
                description: row.description,
                capacityPerHour: row.capacityPerHour,
                costPerHour: row.costPerHour,
                isActive: row.isActive,
              },
            ],
          };
        }

        return {
          returning: async () => [],
        };
      },
    }));

    tx.update = vi.fn(() => {
      const query: any = {};
      query.set = () => query;
      query.where = () => query;
      query.returning = async () => testState.txUpdateReturningResults.shift() ?? [];
      return query;
    });

    return tx;
  }

  const dbMock = {
    select: vi.fn(() => makeSelectBuilder(testState.dbSelectResults.shift() ?? [])),
    transaction: vi.fn(async (callback: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      callback(makeTx())
    ),
    update: vi.fn(() => {
      const query: any = {};
      query.set = () => query;
      query.where = () => query;
      query.returning = async () => [];
      return query;
    }),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.transaction.mockClear();
    dbMock.update.mockClear();
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
    return { id: `audit-${testState.insertedAuditRows.length}`, hashChain: 'test-hash', sequenceNumber: testState.insertedAuditRows.length };
  })
);

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: writeAuditEntryMock,
  writeAuditEntries: vi.fn(async () => []),
}));

import { workCentersRouter } from './work-centers.routes.js';

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
  app.use('/work-centers', workCentersRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function requestJson(
  app: express.Express,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.11',
        'user-agent': 'vitest-agent',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = (await response.json()) as Record<string, any>;
    return { status: response.status, body: json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('work-center audit logging', () => {
  beforeEach(() => {
    testState.dbSelectResults = [];
    testState.txUpdateReturningResults = [];
    testState.insertedAuditRows = [];
    resetDbMockCalls();
  });

  it('logs work_center.created on POST /work-centers', async () => {
    testState.dbSelectResults = [[]];

    const app = createTestApp();
    const response = await requestJson(app, 'POST', '/work-centers', {
      facilityId: FACILITY_ID,
      name: 'Laser',
      code: 'WC-LASER',
      description: 'Laser cell',
      capacityPerHour: 12,
      costPerHour: 30,
    });

    expect(response.status).toBe(201);
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'work_center.created',
        entityType: 'work_center',
        entityId: CENTER_ID,
      })
    );
  });

  it('logs work_center.updated on PATCH /work-centers/:id', async () => {
    testState.dbSelectResults = [
      [
        {
          id: CENTER_ID,
          tenantId: 'tenant-1',
          name: 'Laser',
          code: 'WC-LASER',
          description: 'Laser cell',
          capacityPerHour: '12',
          costPerHour: '30',
          isActive: true,
        },
      ],
      [],
    ];
    testState.txUpdateReturningResults = [
      [
        {
          id: CENTER_ID,
          tenantId: 'tenant-1',
          name: 'Laser 2',
          code: 'WC-LASER-2',
          description: 'Laser cell updated',
          capacityPerHour: '14',
          costPerHour: '32',
          isActive: true,
        },
      ],
    ];

    const app = createTestApp();
    const response = await requestJson(app, 'PATCH', `/work-centers/${CENTER_ID}`, {
      name: 'Laser 2',
      code: 'WC-LASER-2',
      description: 'Laser cell updated',
      capacityPerHour: 14,
      costPerHour: 32,
      isActive: true,
    });

    expect(response.status).toBe(200);
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'work_center.updated',
        entityType: 'work_center',
        entityId: CENTER_ID,
      })
    );
  });

  it('logs work_center.deactivated on DELETE /work-centers/:id', async () => {
    testState.dbSelectResults = [
      [
        {
          id: CENTER_ID,
          tenantId: 'tenant-1',
          name: 'Laser',
          code: 'WC-LASER',
          isActive: true,
        },
      ],
    ];
    testState.txUpdateReturningResults = [
      [
        {
          id: CENTER_ID,
          tenantId: 'tenant-1',
          name: 'Laser',
          code: 'WC-LASER',
          isActive: false,
        },
      ],
    ];

    const app = createTestApp();
    const response = await requestJson(app, 'DELETE', `/work-centers/${CENTER_ID}`);

    expect(response.status).toBe(200);
    expect(testState.insertedAuditRows).toHaveLength(1);
    expect(testState.insertedAuditRows[0]).toEqual(
      expect.objectContaining({
        action: 'work_center.deactivated',
        entityType: 'work_center',
        entityId: CENTER_ID,
      })
    );
  });
});
