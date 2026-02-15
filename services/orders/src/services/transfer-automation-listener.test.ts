import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── Hoisted Mocks ─────────────────────────────────────────────────────
const mockAutoCreateTransferOrder = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    transferOrderId: 'to-1',
    toNumber: 'TO-20260214-0001',
    cardId: 'card-1',
    loopId: 'loop-1',
  }),
);

vi.mock('./kanban-transfer-automation.service.js', () => ({
  autoCreateTransferOrder: mockAutoCreateTransferOrder,
}));

vi.mock('@arda/config', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { startTransferAutomationListener } from './transfer-automation-listener.js';
import type { ArdaEvent, EventBus, LifecycleQueueEntryEvent } from '@arda/events';

// ─── Test Helpers ──────────────────────────────────────────────────────

// EventBus has private fields that can't be mocked directly.
type MockEventBus = Pick<
  EventBus,
  'subscribeGlobal' | 'subscribeTenant' | 'unsubscribeTenant' | 'publish' | 'ping' | 'shutdown'
> & {
  simulateEvent: (event: ArdaEvent) => Promise<void>;
};

/** Cast mock to EventBus for test call sites */
function asEventBus(mock: MockEventBus): EventBus {
  return mock as unknown as EventBus;
}

function createMockEventBus(): MockEventBus {
  let capturedHandler: ((event: ArdaEvent) => void) | null = null;

  return {
    subscribeGlobal: vi.fn(async (handler: (event: ArdaEvent) => void) => {
      capturedHandler = handler;
    }),
    subscribeTenant: vi.fn(),
    unsubscribeTenant: vi.fn(),
    publish: vi.fn(),
    ping: vi.fn(),
    shutdown: vi.fn(),
    simulateEvent: async (event: ArdaEvent) => {
      if (capturedHandler) {
        await capturedHandler(event);
      }
    },
  };
}

function makeQueueEntryEvent(overrides: Partial<LifecycleQueueEntryEvent> = {}): LifecycleQueueEntryEvent {
  return {
    type: 'lifecycle.queue_entry',
    tenantId: '11111111-1111-1111-1111-111111111111',
    cardId: '22222222-2222-2222-2222-222222222222',
    loopId: '33333333-3333-3333-3333-333333333333',
    loopType: 'transfer',
    partId: '44444444-4444-4444-4444-444444444444',
    facilityId: '55555555-5555-5555-5555-555555555555',
    quantity: 50,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('startTransferAutomationListener', () => {
  let mockEventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventBus = createMockEventBus();
  });

  it('subscribes to global events on the EventBus', async () => {
    await startTransferAutomationListener(asEventBus(mockEventBus));

    expect(mockEventBus.subscribeGlobal).toHaveBeenCalledOnce();
    expect(mockEventBus.subscribeGlobal).toHaveBeenCalledWith(expect.any(Function));
  });

  it('returns a listener with a stop method', async () => {
    const listener = await startTransferAutomationListener(asEventBus(mockEventBus));

    expect(listener).toHaveProperty('stop');
    expect(typeof listener.stop).toBe('function');
  });

  describe('event handling', () => {
    it('calls autoCreateTransferOrder for transfer queue_entry events', async () => {
      await startTransferAutomationListener(asEventBus(mockEventBus));

      const event = makeQueueEntryEvent();
      await mockEventBus.simulateEvent(event);

      expect(mockAutoCreateTransferOrder).toHaveBeenCalledOnce();
      expect(mockAutoCreateTransferOrder).toHaveBeenCalledWith({
        tenantId: event.tenantId,
        cardId: event.cardId,
      });
    });

    it('ignores non-transfer loopType events', async () => {
      await startTransferAutomationListener(asEventBus(mockEventBus));

      await mockEventBus.simulateEvent(makeQueueEntryEvent({ loopType: 'procurement' }));
      await mockEventBus.simulateEvent(makeQueueEntryEvent({ loopType: 'production' }));

      expect(mockAutoCreateTransferOrder).not.toHaveBeenCalled();
    });

    it('ignores non-queue_entry event types', async () => {
      await startTransferAutomationListener(asEventBus(mockEventBus));

      await mockEventBus.simulateEvent({
        type: 'order.created',
        tenantId: '11111111-1111-1111-1111-111111111111',
        orderType: 'transfer_order',
        orderId: 'to-1',
        orderNumber: 'TO-001',
        linkedCardIds: [],
        timestamp: new Date().toISOString(),
      });

      expect(mockAutoCreateTransferOrder).not.toHaveBeenCalled();
    });

    it('does not crash the listener when autoCreateTransferOrder throws', async () => {
      mockAutoCreateTransferOrder.mockRejectedValueOnce(new Error('DB down'));

      await startTransferAutomationListener(asEventBus(mockEventBus));

      // Should not throw
      await mockEventBus.simulateEvent(makeQueueEntryEvent());

      expect(mockAutoCreateTransferOrder).toHaveBeenCalledOnce();

      // Listener should still work for subsequent events
      mockAutoCreateTransferOrder.mockResolvedValueOnce({
        transferOrderId: 'to-2',
        toNumber: 'TO-002',
        cardId: 'card-2',
        loopId: 'loop-2',
      });

      await mockEventBus.simulateEvent(
        makeQueueEntryEvent({ cardId: 'card-2' }),
      );

      expect(mockAutoCreateTransferOrder).toHaveBeenCalledTimes(2);
    });

    it('handles duplicate events idempotently (delegates to autoCreateTransferOrder)', async () => {
      await startTransferAutomationListener(asEventBus(mockEventBus));

      const event = makeQueueEntryEvent();

      // Send same event twice
      await mockEventBus.simulateEvent(event);
      await mockEventBus.simulateEvent(event);

      // autoCreateTransferOrder handles idempotency internally
      expect(mockAutoCreateTransferOrder).toHaveBeenCalledTimes(2);
    });
  });

  describe('graceful shutdown', () => {
    it('stop() resolves without error', async () => {
      const listener = await startTransferAutomationListener(asEventBus(mockEventBus));

      await expect(listener.stop()).resolves.toBeUndefined();
    });
  });
});
