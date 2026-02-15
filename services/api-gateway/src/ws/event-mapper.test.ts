import { describe, expect, it } from 'vitest';
import type { ArdaEvent } from '@arda/events';
import { mapBackendEventToWSEvent, mapBackendEventToWSEventType } from './event-mapper.js';

describe('event-mapper', () => {
  it('maps card.transition to card:triggered when toStage=triggered', () => {
    const event = {
      type: 'card.transition',
      tenantId: 'tenant-1',
      cardId: 'card-1',
      loopId: 'loop-1',
      fromStage: 'created',
      toStage: 'triggered',
      method: 'scan',
      timestamp: '2026-02-15T00:00:00.000Z',
    } as const satisfies ArdaEvent;

    expect(mapBackendEventToWSEventType(event)).toBe('card:triggered');
  });

  it('maps card.transition to card:stage_changed for non-triggered transitions', () => {
    const event = {
      type: 'card.transition',
      tenantId: 'tenant-1',
      cardId: 'card-1',
      loopId: 'loop-1',
      fromStage: 'triggered',
      toStage: 'ordered',
      method: 'system',
      timestamp: '2026-02-15T00:00:00.000Z',
    } as const satisfies ArdaEvent;

    expect(mapBackendEventToWSEventType(event)).toBe('card:stage_changed');
  });

  it('maps order.status_changed variants by orderType', () => {
    const po = {
      type: 'order.status_changed',
      tenantId: 'tenant-1',
      orderType: 'purchase_order',
      orderId: 'po-1',
      orderNumber: 'PO-1',
      fromStatus: 'draft',
      toStatus: 'sent',
      timestamp: '2026-02-15T00:00:00.000Z',
    } as const satisfies ArdaEvent;
    const wo = {
      ...po,
      orderType: 'work_order',
    } as const satisfies ArdaEvent;
    const to = {
      ...po,
      orderType: 'transfer_order',
    } as const satisfies ArdaEvent;

    expect(mapBackendEventToWSEventType(po)).toBe('po:status_changed');
    expect(mapBackendEventToWSEventType(wo)).toBe('wo:status_changed');
    expect(mapBackendEventToWSEventType(to)).toBe('transfer:status_changed');
  });

  it('maps production, receiving, and automation events', () => {
    const production = {
      type: 'production.step_completed',
      tenantId: 'tenant-1',
      workOrderId: 'wo-1',
      workOrderNumber: 'WO-1',
      stepNumber: 1,
      operationName: 'Cut',
      workCenterId: 'wc-1',
      actualMinutes: 5,
      status: 'complete',
      timestamp: '2026-02-15T00:00:00.000Z',
    } as const satisfies ArdaEvent;
    const receiving = {
      type: 'receiving.completed',
      tenantId: 'tenant-1',
      receiptId: 'r-1',
      receiptNumber: 'R-1',
      orderType: 'purchase_order',
      orderId: 'po-1',
      status: 'received',
      totalAccepted: 1,
      totalDamaged: 0,
      totalRejected: 0,
      exceptionsCreated: 0,
      timestamp: '2026-02-15T00:00:00.000Z',
    } as const satisfies ArdaEvent;
    const automation = {
      type: 'automation.to_created',
      tenantId: 'tenant-1',
      transferOrderId: 'to-1',
      toNumber: 'TO-1',
      source: 'automation',
      timestamp: '2026-02-15T00:00:00.000Z',
    } as const satisfies ArdaEvent;

    expect(mapBackendEventToWSEventType(production)).toBe('wo:step_completed');
    expect(mapBackendEventToWSEventType(receiving)).toBe('receiving:completed');
    expect(mapBackendEventToWSEventType(automation)).toBe('automation:to_created');
  });

  it('returns null for non-forwarded classes (security events)', () => {
    const event = {
      type: 'security.auth.login',
      tenantId: 'tenant-1',
      userId: 'user-1',
      email: 'user@example.com',
      method: 'password',
      timestamp: '2026-02-15T00:00:00.000Z',
    } as const satisfies ArdaEvent;

    expect(mapBackendEventToWSEventType(event)).toBeNull();
    expect(mapBackendEventToWSEvent(event)).toBeNull();
  });

  it('returns mapped WSEvent payload structure', () => {
    const event = {
      type: 'inventory:updated',
      tenantId: 'tenant-1',
      facilityId: 'fac-1',
      partId: 'part-1',
      field: 'qtyOnHand',
      adjustmentType: 'increment',
      quantity: 5,
      previousValue: 10,
      newValue: 15,
      timestamp: '2026-02-15T00:00:00.000Z',
    } as const satisfies ArdaEvent;

    const mapped = mapBackendEventToWSEvent(event);
    expect(mapped).not.toBeNull();
    expect(mapped!.type).toBe('inventory:updated');
    expect(mapped!.tenantId).toBe('tenant-1');
    expect(mapped!.payload).toEqual(event);
    expect(mapped!.timestamp).toBe('2026-02-15T00:00:00.000Z');
  });

  it('drops mapped events if tenantId is missing/empty', () => {
    const event = {
      type: 'card.transition',
      tenantId: '',
      cardId: 'card-1',
      loopId: 'loop-1',
      fromStage: 'created',
      toStage: 'triggered',
      method: 'scan',
      timestamp: '2026-02-15T00:00:00.000Z',
    } as const satisfies ArdaEvent;

    expect(mapBackendEventToWSEvent(event)).toBeNull();
  });
});
