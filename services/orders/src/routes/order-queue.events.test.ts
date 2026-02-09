import { beforeEach, describe, expect, it, vi } from 'vitest';

const { publishMock, getEventBusMock } = vi.hoisted(() => {
  const publishMock = vi.fn();
  const getEventBusMock = vi.fn(() => ({
    publish: publishMock,
  }));
  return { publishMock, getEventBusMock };
});

vi.mock('@arda/events', () => ({
  getEventBus: getEventBusMock,
}));

vi.mock('@arda/config', () => ({
  config: { REDIS_URL: 'redis://localhost:6379' },
}));

// The route module has many dependencies; for this test we only need
// emitQueueOrderEvents, so lightweight mocks are sufficient.
vi.mock('@arda/db', () => ({ db: {}, schema: {} }));
vi.mock('../services/order-number.service.js', () => ({
  getNextPONumber: vi.fn(),
  getNextWONumber: vi.fn(),
  getNextTONumber: vi.fn(),
}));
vi.mock('../services/card-lifecycle.service.js', () => ({
  transitionTriggeredCardToOrdered: vi.fn(),
}));

import { emitQueueOrderEvents, publishQueueRiskDetectedEvents } from './order-queue.routes.js';

describe('emitQueueOrderEvents', () => {
  beforeEach(() => {
    publishMock.mockReset();
    getEventBusMock.mockClear();
  });

  it.each([
    { orderType: 'purchase_order', orderId: 'po-1', orderNumber: 'PO-20260209-0001' },
    { orderType: 'work_order', orderId: 'wo-1', orderNumber: 'WO-20260209-0001' },
    { orderType: 'transfer_order', orderId: 'to-1', orderNumber: 'TO-20260209-0001' },
  ] as const)('emits order and card transition events for $orderType', async (testCase) => {
    await emitQueueOrderEvents({
      tenantId: 'tenant-1',
      orderType: testCase.orderType,
      orderId: testCase.orderId,
      orderNumber: testCase.orderNumber,
      linkedCardIds: ['card-1', 'card-2'],
      transitionedCards: [
        { cardId: 'card-1', loopId: 'loop-1' },
        { cardId: 'card-2', loopId: 'loop-2' },
      ],
    });

    expect(publishMock).toHaveBeenCalledTimes(3);

    const payloads = publishMock.mock.calls.map((call) => call[0]);

    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'order.created',
          tenantId: 'tenant-1',
          orderType: testCase.orderType,
          orderId: testCase.orderId,
          orderNumber: testCase.orderNumber,
          linkedCardIds: ['card-1', 'card-2'],
        }),
        expect.objectContaining({
          type: 'card.transition',
          tenantId: 'tenant-1',
          cardId: 'card-1',
          loopId: 'loop-1',
          fromStage: 'triggered',
          toStage: 'ordered',
          method: 'system',
        }),
        expect.objectContaining({
          type: 'card.transition',
          tenantId: 'tenant-1',
          cardId: 'card-2',
          loopId: 'loop-2',
          fromStage: 'triggered',
          toStage: 'ordered',
          method: 'system',
        }),
      ])
    );
  });

  it('emits only order.created when there are no transitioned cards', async () => {
    await emitQueueOrderEvents({
      tenantId: 'tenant-2',
      orderType: 'purchase_order',
      orderId: 'po-2',
      orderNumber: 'PO-20260209-0002',
      linkedCardIds: [],
      transitionedCards: [],
    });

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order.created',
        orderId: 'po-2',
      })
    );
  });
});

describe('publishQueueRiskDetectedEvents', () => {
  beforeEach(() => {
    publishMock.mockReset();
    getEventBusMock.mockClear();
  });

  it('publishes queue.risk_detected for each risk item', async () => {
    await publishQueueRiskDetectedEvents({
      tenantId: 'tenant-1',
      risks: [
        {
          cardId: 'card-1',
          loopId: 'loop-1',
          loopType: 'procurement',
          queueType: 'procurement',
          partId: 'part-1',
          facilityId: 'fac-1',
          riskLevel: 'high',
          triggeredAgeHours: 72,
          estimatedDaysOfSupply: 1.2,
          reason: 'triggered age 72h exceeds high threshold 48h',
          thresholds: {
            ageHours: { medium: 36, high: 48 },
            daysOfSupply: { medium: 3, high: 1 },
          },
        },
        {
          cardId: 'card-2',
          loopId: 'loop-2',
          loopType: 'production',
          queueType: 'production',
          partId: 'part-2',
          facilityId: 'fac-2',
          riskLevel: 'medium',
          triggeredAgeHours: 20,
          estimatedDaysOfSupply: null,
          reason: 'triggered age 20h exceeds medium threshold 18h',
          thresholds: {
            ageHours: { medium: 18, high: 24 },
            daysOfSupply: null,
          },
        },
      ],
    });

    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'queue.risk_detected',
        tenantId: 'tenant-1',
        queueType: 'procurement',
        cardId: 'card-1',
        riskLevel: 'high',
      })
    );
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'queue.risk_detected',
        tenantId: 'tenant-1',
        queueType: 'production',
        cardId: 'card-2',
        riskLevel: 'medium',
      })
    );
  });

  it('does not publish events when risk list is empty', async () => {
    await publishQueueRiskDetectedEvents({
      tenantId: 'tenant-1',
      risks: [],
    });

    expect(publishMock).not.toHaveBeenCalled();
  });
});
