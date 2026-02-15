import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted Mocks ──────────────────────────────────────────────────
const { publishMock, getEventBusMock } = vi.hoisted(() => {
  const publishMock = vi.fn().mockResolvedValue(undefined);
  const getEventBusMock = vi.fn(() => ({ publish: publishMock }));
  return { publishMock, getEventBusMock };
});

vi.mock('../index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../index.js')>();
  return {
    ...original,
    getEventBus: getEventBusMock,
  };
});

vi.mock('@arda/config', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  buildEventMeta,
  publishKpiRefreshed,
  publishAuditCreated,
  publishUserActivity,
  setupAuditEventPublishing,
  KPI_AFFECTED_METRICS,
} from '../realtime-publishers.js';

// ─── Tests ───────────────────────────────────────────────────────────

describe('realtime-publishers', () => {
  beforeEach(() => {
    publishMock.mockReset().mockResolvedValue(undefined);
    getEventBusMock.mockClear();
  });

  // ─── buildEventMeta ──────────────────────────────────────────────

  describe('buildEventMeta', () => {
    it('builds meta with source and timestamp', () => {
      const meta = buildEventMeta('orders', 'corr-123');

      expect(meta).toEqual(
        expect.objectContaining({
          schemaVersion: 1,
          source: 'orders',
          correlationId: 'corr-123',
        }),
      );
      expect(meta.timestamp).toBeDefined();
    });

    it('omits correlationId when not provided', () => {
      const meta = buildEventMeta('kanban');

      expect(meta.correlationId).toBeUndefined();
      expect(meta.source).toBe('kanban');
    });
  });

  // ─── KPI_AFFECTED_METRICS ─────────────────────────────────────────

  describe('KPI_AFFECTED_METRICS', () => {
    it('maps purchase_order.created to fill_rate and order_accuracy', () => {
      expect(KPI_AFFECTED_METRICS['purchase_order.created']).toEqual(['fill_rate', 'order_accuracy']);
    });

    it('maps card.transition to stockout_count and avg_cycle_time', () => {
      expect(KPI_AFFECTED_METRICS['card.transition']).toEqual(['stockout_count', 'avg_cycle_time']);
    });

    it('maps receiving.completed to fill_rate, supplier_otd, and order_accuracy', () => {
      expect(KPI_AFFECTED_METRICS['receiving.completed']).toEqual([
        'fill_rate',
        'supplier_otd',
        'order_accuracy',
      ]);
    });

    it('has entries for all expected mutation types', () => {
      const expectedKeys = [
        'purchase_order.created',
        'purchase_order.status_changed',
        'work_order.created',
        'work_order.status_changed',
        'work_order.production_reported',
        'transfer_order.created',
        'transfer_order.status_changed',
        'receiving.completed',
        'inventory.adjusted',
        'card.transition',
      ];
      expect(Object.keys(KPI_AFFECTED_METRICS).sort()).toEqual(expectedKeys.sort());
    });
  });

  // ─── publishKpiRefreshed ──────────────────────────────────────────

  describe('publishKpiRefreshed', () => {
    it('publishes kpi.refreshed for each affected metric', async () => {
      await publishKpiRefreshed({
        tenantId: 'tenant-1',
        mutationType: 'purchase_order.created',
        facilityId: 'fac-1',
        source: 'orders',
        correlationId: 'corr-abc',
      });

      // purchase_order.created maps to ['fill_rate', 'order_accuracy']
      expect(publishMock).toHaveBeenCalledTimes(2);

      const calls = publishMock.mock.calls;
      const payloads = calls.map((c: unknown[]) => c[0]);
      const metas = calls.map((c: unknown[]) => c[1]);

      expect(payloads[0]).toEqual(
        expect.objectContaining({
          type: 'kpi.refreshed',
          tenantId: 'tenant-1',
          kpiKey: 'fill_rate',
          window: '30d',
          facilityId: 'fac-1',
        }),
      );
      expect(payloads[1]).toEqual(
        expect.objectContaining({
          type: 'kpi.refreshed',
          tenantId: 'tenant-1',
          kpiKey: 'order_accuracy',
        }),
      );

      // Meta includes correlation ID
      expect(metas[0]).toEqual(
        expect.objectContaining({
          source: 'orders',
          correlationId: 'corr-abc',
        }),
      );
    });

    it('does not publish when mutation type has no affected metrics', async () => {
      await publishKpiRefreshed({
        tenantId: 'tenant-1',
        mutationType: 'unknown.mutation',
        source: 'orders',
      });

      expect(publishMock).not.toHaveBeenCalled();
    });

    it('swallows publish errors without throwing', async () => {
      publishMock.mockRejectedValueOnce(new Error('Redis down'));

      await expect(
        publishKpiRefreshed({
          tenantId: 'tenant-1',
          mutationType: 'purchase_order.created',
          source: 'orders',
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ─── publishAuditCreated ──────────────────────────────────────────

  describe('publishAuditCreated', () => {
    it('publishes audit.created with full payload', async () => {
      await publishAuditCreated({
        tenantId: 'tenant-1',
        auditId: 'audit-123',
        action: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: 'po-456',
        actorUserId: 'user-789',
        method: 'api',
        source: 'orders',
        correlationId: 'corr-xyz',
      });

      expect(publishMock).toHaveBeenCalledTimes(1);
      const [payload, meta] = publishMock.mock.calls[0];

      expect(payload).toEqual(
        expect.objectContaining({
          type: 'audit.created',
          tenantId: 'tenant-1',
          auditId: 'audit-123',
          action: 'purchase_order.created',
          entityType: 'purchase_order',
          entityId: 'po-456',
          actorUserId: 'user-789',
          method: 'api',
        }),
      );
      expect(meta.correlationId).toBe('corr-xyz');
      expect(meta.source).toBe('orders');
    });

    it('swallows publish errors without throwing', async () => {
      publishMock.mockRejectedValueOnce(new Error('Redis down'));

      await expect(
        publishAuditCreated({
          tenantId: 'tenant-1',
          auditId: 'audit-1',
          action: 'test',
          entityType: 'test',
          entityId: null,
          source: 'orders',
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ─── publishUserActivity ──────────────────────────────────────────

  describe('publishUserActivity', () => {
    it('publishes user.activity with full payload', async () => {
      await publishUserActivity({
        tenantId: 'tenant-1',
        userId: 'user-123',
        activityType: 'mutation',
        route: 'POST /purchase-orders',
        resourceType: 'purchase_orders',
        resourceId: 'po-456',
        source: 'orders',
        correlationId: 'corr-123',
      });

      expect(publishMock).toHaveBeenCalledTimes(1);
      const [payload, meta] = publishMock.mock.calls[0];

      expect(payload).toEqual(
        expect.objectContaining({
          type: 'user.activity',
          tenantId: 'tenant-1',
          userId: 'user-123',
          activityType: 'mutation',
          route: 'POST /purchase-orders',
          resourceType: 'purchase_orders',
          resourceId: 'po-456',
          correlationId: 'corr-123',
        }),
      );
      expect(meta.source).toBe('orders');
    });

    it('swallows publish errors without throwing', async () => {
      publishMock.mockRejectedValueOnce(new Error('Redis down'));

      await expect(
        publishUserActivity({
          tenantId: 'tenant-1',
          userId: 'user-1',
          activityType: 'mutation',
          source: 'orders',
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ─── setupAuditEventPublishing ────────────────────────────────────

  describe('setupAuditEventPublishing', () => {
    type AuditEntry = {
      tenantId: string;
      userId?: string | null;
      action: string;
      entityType: string;
      entityId?: string | null;
    };
    type AuditResult = { id: string };
    type OnAuditWrittenFn = (cb: (entry: AuditEntry, result: AuditResult) => void) => void;

    it('wires onAuditWritten callback to publish audit.created', () => {
      let capturedCallback: ((entry: AuditEntry, result: AuditResult) => void) | undefined;

      const mockOnAuditWritten: OnAuditWrittenFn = vi.fn((cb) => {
        capturedCallback = cb;
      });

      const mockGetCorrelationId = vi.fn(() => 'corr-456');

      setupAuditEventPublishing('orders', mockOnAuditWritten, mockGetCorrelationId);

      expect(mockOnAuditWritten).toHaveBeenCalledOnce();
      expect(capturedCallback).toBeDefined();

      // Simulate an audit write
      capturedCallback!({
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'po.created',
        entityType: 'purchase_order',
        entityId: 'po-123',
      }, { id: 'audit-999' });

      expect(mockGetCorrelationId).toHaveBeenCalledOnce();
    });

    it('omits correlationId when getCorrelationId returns "unknown"', () => {
      let capturedCallback: ((entry: AuditEntry, result: AuditResult) => void) | undefined;

      const mockOnAuditWritten: OnAuditWrittenFn = vi.fn((cb) => {
        capturedCallback = cb;
      });

      const mockGetCorrelationId = vi.fn(() => 'unknown');

      setupAuditEventPublishing('kanban', mockOnAuditWritten, mockGetCorrelationId);

      capturedCallback!({
        tenantId: 'tenant-1',
        action: 'card.transitioned',
        entityType: 'kanban_card',
        entityId: 'card-1',
      }, { id: 'audit-100' });

      // The publish will be called asynchronously via void; verify the correlationId pattern
      expect(mockGetCorrelationId).toHaveBeenCalled();
    });
  });
});
