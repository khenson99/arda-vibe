import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  activeUsers: [] as Array<{ id: string }>,
  insertedRows: [] as Array<Record<string, unknown>>,
  subscribedHandler: null as null | ((event: unknown) => Promise<void> | void),
}));

const { getEventBusMock, subscribeGlobalMock, publishMock } = vi.hoisted(() => {
  const publishMock = vi.fn(async () => undefined);
  const subscribeGlobalMock = vi.fn(
    async (handler: (event: unknown) => Promise<void> | void) => {
      testState.subscribedHandler = handler;
    }
  );

  const eventBusMock = {
    subscribeGlobal: subscribeGlobalMock,
    publish: publishMock,
  };

  const getEventBusMock = vi.fn(() => eventBusMock);

  return {
    getEventBusMock,
    subscribeGlobalMock,
    publishMock,
  };
});

const schemaMock = vi.hoisted(() => ({
  users: {
    id: 'users.id',
    tenantId: 'users.tenant_id',
    isActive: 'users.is_active',
  },
  notifications: {
    id: 'notifications.id',
    userId: 'notifications.user_id',
    type: 'notifications.type',
    title: 'notifications.title',
  },
  notificationTypeEnum: {
    enumValues: [
      'card_triggered',
      'po_created',
      'po_sent',
      'po_received',
      'stockout_warning',
      'relowisa_recommendation',
      'exception_alert',
      'wo_status_change',
      'transfer_status_change',
      'system_alert',
    ] as const,
  },
}));

const { dbMock, resetDbMockCalls } = vi.hoisted(() => {
  function makeSelectBuilder(result: unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.execute = async () => result;
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  }

  const dbMock = {
    select: vi.fn(() => makeSelectBuilder(testState.activeUsers)),
    insert: vi.fn(() => {
      const valuesBuilder: any = {};
      valuesBuilder.values = (values: unknown) => {
        const rows = (Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>;
        testState.insertedRows = rows;

        const returnedRows = rows.map((row, index) => ({
          id: `notif-${index + 1}`,
          userId: String(row.userId),
          type: String(row.type),
          title: String(row.title),
        }));

        return {
          returning: async () => returnedRows,
        };
      };
      return valuesBuilder;
    }),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.insert.mockClear();
  };

  return { dbMock, resetDbMockCalls };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
}));

vi.mock('@arda/events', () => ({
  getEventBus: getEventBusMock,
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
}));

import { startEventListener } from './event-listener.js';

async function dispatchEvent(event: unknown) {
  if (!testState.subscribedHandler) {
    throw new Error('No subscribed handler found');
  }

  await testState.subscribedHandler(event);
}

describe('event-listener service', () => {
  beforeEach(() => {
    testState.activeUsers = [];
    testState.insertedRows = [];
    testState.subscribedHandler = null;
    resetDbMockCalls();
    getEventBusMock.mockClear();
    subscribeGlobalMock.mockClear();
    publishMock.mockClear();
  });

  it('subscribes to global event stream', async () => {
    await startEventListener('redis://test:6379');

    expect(getEventBusMock).toHaveBeenCalledWith('redis://test:6379');
    expect(subscribeGlobalMock).toHaveBeenCalledTimes(1);
  });

  it('creates po_sent notifications and emits notification.created events', async () => {
    testState.activeUsers = [{ id: 'user-1' }, { id: 'user-2' }];
    await startEventListener('redis://test:6379');

    await dispatchEvent({
      type: 'order.status_changed',
      tenantId: 'tenant-1',
      orderType: 'purchase_order',
      orderId: 'po-1',
      orderNumber: 'PO-1001',
      fromStatus: 'approved',
      toStatus: 'sent',
      timestamp: new Date().toISOString(),
    });

    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(testState.insertedRows).toHaveLength(2);
    expect(testState.insertedRows[0]).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        type: 'po_sent',
      })
    );
    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'notification.created',
        tenantId: 'tenant-1',
        notificationType: 'po_sent',
      })
    );
  });

  it('creates work and transfer specific status notification types', async () => {
    testState.activeUsers = [{ id: 'user-1' }];
    await startEventListener('redis://test:6379');

    await dispatchEvent({
      type: 'order.status_changed',
      tenantId: 'tenant-1',
      orderType: 'work_order',
      orderId: 'wo-1',
      orderNumber: 'WO-1001',
      fromStatus: 'scheduled',
      toStatus: 'in_progress',
      timestamp: new Date().toISOString(),
    });

    expect(testState.insertedRows[0]).toEqual(
      expect.objectContaining({
        type: 'wo_status_change',
      })
    );

    publishMock.mockClear();

    await dispatchEvent({
      type: 'order.status_changed',
      tenantId: 'tenant-1',
      orderType: 'transfer_order',
      orderId: 'to-1',
      orderNumber: 'TO-1001',
      fromStatus: 'scheduled',
      toStatus: 'in_transit',
      timestamp: new Date().toISOString(),
    });

    expect(testState.insertedRows[0]).toEqual(
      expect.objectContaining({
        type: 'transfer_status_change',
      })
    );
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationType: 'transfer_status_change',
      })
    );
  });

  it('creates exception alerts for cancelled or on-hold statuses', async () => {
    testState.activeUsers = [{ id: 'user-1' }];
    await startEventListener('redis://test:6379');

    await dispatchEvent({
      type: 'order.status_changed',
      tenantId: 'tenant-1',
      orderType: 'purchase_order',
      orderId: 'po-1',
      orderNumber: 'PO-1002',
      fromStatus: 'approved',
      toStatus: 'cancelled',
      timestamp: new Date().toISOString(),
    });

    expect(testState.insertedRows[0]).toEqual(
      expect.objectContaining({
        type: 'exception_alert',
        title: 'Purchase order cancelled',
      })
    );

    publishMock.mockClear();

    await dispatchEvent({
      type: 'order.status_changed',
      tenantId: 'tenant-1',
      orderType: 'work_order',
      orderId: 'wo-2',
      orderNumber: 'WO-2001',
      fromStatus: 'in_progress',
      toStatus: 'on_hold',
      timestamp: new Date().toISOString(),
    });

    expect(testState.insertedRows[0]).toEqual(
      expect.objectContaining({
        type: 'exception_alert',
        title: 'Work order requires attention',
      })
    );
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationType: 'exception_alert',
      })
    );
  });

  it('creates system alert notifications for loop parameter changes', async () => {
    testState.activeUsers = [{ id: 'user-1' }];
    await startEventListener('redis://test:6379');

    await dispatchEvent({
      type: 'loop.parameters_changed',
      tenantId: 'tenant-1',
      loopId: 'loop-123',
      changeType: 'min_quantity',
      reason: 'Adjusted from velocity trend',
      timestamp: new Date().toISOString(),
    });

    expect(testState.insertedRows[0]).toEqual(
      expect.objectContaining({
        type: 'system_alert',
        title: 'Kanban parameters updated',
        actionUrl: '/loops/loop-123',
      })
    );
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationType: 'system_alert',
      })
    );
  });

  it('creates stockout warning notifications for queue risk events', async () => {
    testState.activeUsers = [{ id: 'user-1' }];
    await startEventListener('redis://test:6379');

    await dispatchEvent({
      type: 'queue.risk_detected',
      tenantId: 'tenant-1',
      queueType: 'procurement',
      loopId: 'loop-1',
      cardId: 'card-42',
      partId: 'part-1',
      facilityId: 'facility-1',
      riskLevel: 'high',
      triggeredAgeHours: 96,
      estimatedDaysOfSupply: 1.5,
      reason: 'triggered age 96h exceeds high threshold 48h',
      timestamp: new Date().toISOString(),
    });

    expect(testState.insertedRows[0]).toEqual(
      expect.objectContaining({
        type: 'stockout_warning',
        title: 'High stockout risk detected',
        actionUrl: '/queue?loopType=procurement',
      })
    );
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationType: 'stockout_warning',
      })
    );
  });
});
