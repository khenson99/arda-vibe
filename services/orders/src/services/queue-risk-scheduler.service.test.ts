import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  tenants: [] as Array<{ id: string }>,
}));

const { runQueueRiskScanForTenantMock } = vi.hoisted(() => ({
  runQueueRiskScanForTenantMock: vi.fn(async () => ({
    generatedAt: new Date().toISOString(),
    lookbackDays: 30,
    totalTriggeredCards: 0,
    totalRisks: 0,
    byRiskLevel: { medium: 0, high: 0 },
    emittedRiskEvents: 0,
    risks: [],
  })),
}));

const schemaMock = vi.hoisted(() => ({
  tenants: {
    id: 'tenants.id',
    isActive: 'tenants.is_active',
  },
}));

const { dbMock, resetDbMocks } = vi.hoisted(() => {
  const dbMock = {
    select: vi.fn(() => {
      const builder: any = {};
      builder.from = () => builder;
      builder.where = () => builder;
      builder.execute = async () => testState.tenants;
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown
      ) => Promise.resolve(testState.tenants).then(resolve, reject);
      return builder;
    }),
  };

  const resetDbMocks = () => {
    dbMock.select.mockClear();
  };

  return { dbMock, resetDbMocks };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
}));

vi.mock('@arda/config', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../routes/order-queue.routes.js', () => ({
  runQueueRiskScanForTenant: runQueueRiskScanForTenantMock,
}));

import { startQueueRiskScheduler } from './queue-risk-scheduler.service.js';

describe('queue risk scheduler service', () => {
  beforeEach(() => {
    testState.tenants = [];
    resetDbMocks();
    runQueueRiskScanForTenantMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a no-op when disabled', async () => {
    const handle = startQueueRiskScheduler({
      enabled: false,
      intervalMinutes: 15,
      lookbackDays: 30,
      minRiskLevel: 'medium',
      limit: 100,
    });

    await handle.runOnce();
    handle.stop();

    expect(runQueueRiskScanForTenantMock).not.toHaveBeenCalled();
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('runs risk scans for each active tenant', async () => {
    testState.tenants = [{ id: 'tenant-1' }, { id: 'tenant-2' }];

    const handle = startQueueRiskScheduler({
      enabled: true,
      intervalMinutes: 60,
      lookbackDays: 21,
      minRiskLevel: 'high',
      limit: 50,
    });

    await handle.runOnce();
    handle.stop();

    expect(dbMock.select).toHaveBeenCalledTimes(1);
    expect(runQueueRiskScanForTenantMock).toHaveBeenCalledTimes(2);
    expect(runQueueRiskScanForTenantMock).toHaveBeenNthCalledWith(1, {
      tenantId: 'tenant-1',
      lookbackDays: 21,
      limit: 50,
      minRiskLevel: 'high',
      emitEvents: true,
    });
    expect(runQueueRiskScanForTenantMock).toHaveBeenNthCalledWith(2, {
      tenantId: 'tenant-2',
      lookbackDays: 21,
      limit: 50,
      minRiskLevel: 'high',
      emitEvents: true,
    });
  });

  it('runs on the configured interval', async () => {
    vi.useFakeTimers();
    testState.tenants = [{ id: 'tenant-1' }];

    const handle = startQueueRiskScheduler({
      enabled: true,
      intervalMinutes: 1,
      lookbackDays: 30,
      minRiskLevel: 'medium',
      limit: 100,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    handle.stop();

    expect(runQueueRiskScanForTenantMock).toHaveBeenCalledTimes(1);
  });
});

