import { beforeEach, describe, expect, it } from 'vitest';

import { renderException } from './exception.js';
import { renderStockout } from './stockout.js';
import { renderPOLifecycle } from './po-lifecycle.js';
import { renderOrderStatus } from './order-status.js';
import { renderSystemAlert } from './system-alert.js';
import { renderDigest } from './digest.js';
import { renderTemplate, templateRegistry } from './index.js';
import { resolveActionUrl, escapeHtml, baseLayout } from './base-layout.js';

describe('templates', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.APP_URL = 'https://app.arda.cards';
  });

  // ─── Base Layout ────────────────────────────────────────────────────

  describe('baseLayout', () => {
    it('wraps content in a full HTML document', () => {
      const html = baseLayout({ content: '<p>Hello</p>' });
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<p>Hello</p>');
      expect(html).toContain('Arda');
    });

    it('includes preheader text when provided', () => {
      const html = baseLayout({ content: '<p>Test</p>', preheaderText: 'Preview text here' });
      expect(html).toContain('Preview text here');
      expect(html).toContain('display:none');
    });

    it('includes custom footer text', () => {
      const html = baseLayout({ content: '<p>Test</p>', footerText: 'Custom footer' });
      expect(html).toContain('Custom footer');
    });

    it('includes default footer text when no custom footer', () => {
      const html = baseLayout({ content: '<p>Test</p>' });
      expect(html).toContain('notification preferences');
    });
  });

  // ─── resolveActionUrl ───────────────────────────────────────────────

  describe('resolveActionUrl', () => {
    it('resolves relative paths using APP_URL', () => {
      expect(resolveActionUrl('/orders/123')).toBe('https://app.arda.cards/orders/123');
    });

    it('handles APP_URL with trailing slash', () => {
      process.env.APP_URL = 'https://app.arda.cards/';
      expect(resolveActionUrl('/notifications')).toBe('https://app.arda.cards/notifications');
    });

    it('adds leading slash if missing from path', () => {
      expect(resolveActionUrl('orders/123')).toBe('https://app.arda.cards/orders/123');
    });

    it('falls back to localhost when APP_URL is not set', () => {
      delete process.env.APP_URL;
      expect(resolveActionUrl('/test')).toBe('http://localhost:5173/test');
    });
  });

  // ─── escapeHtml ─────────────────────────────────────────────────────

  describe('escapeHtml', () => {
    it('escapes HTML special characters', () => {
      expect(escapeHtml('<script>"test" & \'more\'</script>')).toBe(
        '&lt;script&gt;&quot;test&quot; &amp; \'more\'&lt;/script&gt;'
      );
    });
  });

  // ─── Exception Template ─────────────────────────────────────────────

  describe('renderException', () => {
    it('produces valid HTML with subject', () => {
      const result = renderException({
        exceptionType: 'Short Shipment',
        severity: 'high',
        quantityAffected: 50,
        referenceNumber: 'REC-1001',
        actionUrl: '/receiving/exceptions/exc-123',
      });

      expect(result.subject).toContain('HIGH');
      expect(result.subject).toContain('Short Shipment');
      expect(result.html).toContain('<!DOCTYPE html>');
      expect(result.html).toContain('Exception Alert');
      expect(result.html).toContain('Short Shipment');
      expect(result.html).toContain('50 unit(s) affected');
      expect(result.html).toContain('https://app.arda.cards/receiving/exceptions/exc-123');
    });

    it('includes optional details when provided', () => {
      const result = renderException({
        exceptionType: 'Damaged',
        severity: 'medium',
        quantityAffected: 10,
        referenceNumber: 'REC-1002',
        details: 'Packaging was crushed during transit',
        actionUrl: '/receiving/exceptions/exc-456',
      });

      expect(result.html).toContain('Packaging was crushed during transit');
    });

    it('escapes HTML in user-supplied data', () => {
      const result = renderException({
        exceptionType: '<script>alert(1)</script>',
        severity: 'low',
        quantityAffected: 1,
        referenceNumber: 'REC-XSS',
        actionUrl: '/receiving/exceptions/exc-xss',
      });

      expect(result.html).not.toContain('<script>');
      expect(result.html).toContain('&lt;script&gt;');
    });
  });

  // ─── Stockout Template ──────────────────────────────────────────────

  describe('renderStockout', () => {
    it('produces valid HTML for high risk', () => {
      const result = renderStockout({
        partName: 'Widget-A',
        riskLevel: 'high',
        triggeredAgeHours: 96,
        estimatedDaysOfSupply: 1.5,
        reason: 'Triggered age 96h exceeds threshold',
        actionUrl: '/queue?loopType=procurement',
      });

      expect(result.subject).toContain('HIGH');
      expect(result.subject).toContain('Widget-A');
      expect(result.html).toContain('Stockout Risk Alert');
      expect(result.html).toContain('96h');
      expect(result.html).toContain('1.5');
      expect(result.html).toContain('https://app.arda.cards/queue?loopType=procurement');
    });

    it('produces valid HTML for medium risk', () => {
      const result = renderStockout({
        partName: 'Sprocket-B',
        riskLevel: 'medium',
        triggeredAgeHours: 36,
        estimatedDaysOfSupply: 4.2,
        reason: 'Supply declining',
        actionUrl: '/queue',
      });

      expect(result.subject).toContain('MEDIUM');
      expect(result.html).toContain('Sprocket-B');
    });
  });

  // ─── PO Lifecycle Template ──────────────────────────────────────────

  describe('renderPOLifecycle', () => {
    it('renders created status', () => {
      const result = renderPOLifecycle({
        orderNumber: 'PO-1001',
        status: 'created',
        supplierName: 'Acme Corp',
        linkedCardCount: 3,
        actionUrl: '/orders/po-123',
      });

      expect(result.subject).toContain('PO-1001');
      expect(result.subject).toContain('Created');
      expect(result.html).toContain('Purchase Order Created');
      expect(result.html).toContain('Acme Corp');
      expect(result.html).toContain('3');
      expect(result.html).toContain('https://app.arda.cards/orders/po-123');
    });

    it('renders received status', () => {
      const result = renderPOLifecycle({
        orderNumber: 'PO-2001',
        status: 'received',
        actionUrl: '/orders/po-456',
      });

      expect(result.subject).toContain('Received');
      expect(result.html).toContain('Purchase Order Received');
    });

    it('renders cancelled status', () => {
      const result = renderPOLifecycle({
        orderNumber: 'PO-3001',
        status: 'cancelled',
        notes: 'Vendor no longer available',
        actionUrl: '/orders/po-789',
      });

      expect(result.subject).toContain('Cancelled');
      expect(result.html).toContain('Vendor no longer available');
    });
  });

  // ─── Order Status Template ──────────────────────────────────────────

  describe('renderOrderStatus', () => {
    it('renders work order status change', () => {
      const result = renderOrderStatus({
        orderNumber: 'WO-1001',
        orderType: 'Work Order',
        fromStatus: 'scheduled',
        toStatus: 'in_progress',
        actionUrl: '/orders/wo-123',
      });

      expect(result.subject).toContain('Work Order');
      expect(result.subject).toContain('WO-1001');
      expect(result.html).toContain('Scheduled');
      expect(result.html).toContain('In Progress');
      expect(result.html).toContain('https://app.arda.cards/orders/wo-123');
    });

    it('includes notes when provided', () => {
      const result = renderOrderStatus({
        orderNumber: 'TO-1001',
        orderType: 'Transfer Order',
        fromStatus: 'pending',
        toStatus: 'in_transit',
        notes: 'Truck departed warehouse',
        actionUrl: '/orders/to-123',
      });

      expect(result.html).toContain('Truck departed warehouse');
    });

    it('formats status labels with proper capitalization', () => {
      const result = renderOrderStatus({
        orderNumber: 'WO-2001',
        orderType: 'Work Order',
        fromStatus: 'in_progress',
        toStatus: 'on_hold',
        actionUrl: '/orders/wo-456',
      });

      expect(result.html).toContain('In Progress');
      expect(result.html).toContain('On Hold');
    });
  });

  // ─── System Alert Template ──────────────────────────────────────────

  describe('renderSystemAlert', () => {
    it('renders info alert', () => {
      const result = renderSystemAlert({
        title: 'Kanban parameters updated',
        message: 'Loop parameters changed for optimization',
        severity: 'info',
        actionUrl: '/loops/loop-123',
      });

      expect(result.subject).toContain('Info');
      expect(result.html).toContain('System Alert');
      expect(result.html).toContain('Kanban parameters updated');
      expect(result.html).toContain('https://app.arda.cards/loops/loop-123');
    });

    it('renders warning alert', () => {
      const result = renderSystemAlert({
        title: 'Queue processing delayed',
        message: 'Workers experiencing high latency',
        severity: 'warning',
      });

      expect(result.subject).toContain('Warning');
    });

    it('renders error alert', () => {
      const result = renderSystemAlert({
        title: 'Integration failure',
        message: 'ERP sync failed',
        severity: 'error',
        actionUrl: '/admin/integrations',
        actionLabel: 'Check Integration',
      });

      expect(result.subject).toContain('ALERT');
      expect(result.html).toContain('Check Integration');
    });

    it('defaults to info severity when not provided', () => {
      const result = renderSystemAlert({
        title: 'Test',
        message: 'Just a test',
      });

      expect(result.subject).toContain('Info');
    });

    it('omits action button when no actionUrl provided', () => {
      const result = renderSystemAlert({
        title: 'No action needed',
        message: 'Informational only',
      });

      // No anchor tag with the action button URL
      expect(result.html).not.toContain('View Details');
    });
  });

  // ─── Digest Template ───────────────────────────────────────────────

  describe('renderDigest', () => {
    const sampleItems = [
      {
        type: 'po_created',
        title: 'PO-1001 created',
        body: 'New purchase order for Acme Corp',
        actionUrl: '/orders/po-1',
        timestamp: '2025-01-15T10:00:00Z',
      },
      {
        type: 'stockout_warning',
        title: 'Stockout risk for Widget-A',
        body: 'High risk detected',
        actionUrl: '/queue',
        timestamp: '2025-01-15T11:00:00Z',
      },
    ];

    it('renders daily digest with items', () => {
      const result = renderDigest({
        recipientName: 'Jane',
        period: 'Daily',
        items: sampleItems,
      });

      expect(result.subject).toContain('Daily Digest');
      expect(result.subject).toContain('2 notifications');
      expect(result.html).toContain('Hi Jane,');
      expect(result.html).toContain('daily');
      expect(result.html).toContain('PO-1001 created');
      expect(result.html).toContain('Stockout risk for Widget-A');
      expect(result.html).toContain('https://app.arda.cards/orders/po-1');
      expect(result.html).toContain('View All Notifications');
    });

    it('uses singular notification text for single item', () => {
      const result = renderDigest({
        period: 'Weekly',
        items: [sampleItems[0]],
      });

      expect(result.subject).toContain('1 notification');
      expect(result.subject).not.toContain('1 notifications');
    });

    it('renders generic greeting when no recipient name', () => {
      const result = renderDigest({
        period: 'Daily',
        items: sampleItems,
      });

      expect(result.html).toContain('Hi,');
      expect(result.html).not.toContain('Hi ,');
    });

    it('uses custom allNotificationsUrl when provided', () => {
      const result = renderDigest({
        period: 'Daily',
        items: sampleItems,
        allNotificationsUrl: '/notifications?filter=unread',
      });

      expect(result.html).toContain('https://app.arda.cards/notifications?filter=unread');
    });
  });

  // ─── Template Registry ─────────────────────────────────────────────

  describe('templateRegistry', () => {
    it('contains all required template types', () => {
      expect(templateRegistry).toHaveProperty('exception');
      expect(templateRegistry).toHaveProperty('stockout');
      expect(templateRegistry).toHaveProperty('po_lifecycle');
      expect(templateRegistry).toHaveProperty('order_status');
      expect(templateRegistry).toHaveProperty('system_alert');
      expect(templateRegistry).toHaveProperty('digest');
    });
  });

  // ─── renderTemplate ─────────────────────────────────────────────────

  describe('renderTemplate', () => {
    it('delegates to the correct renderer', () => {
      const result = renderTemplate('exception', {
        exceptionType: 'Short Shipment',
        severity: 'high',
        quantityAffected: 10,
        referenceNumber: 'REC-1',
        actionUrl: '/receiving/exceptions/exc-1',
      });

      expect(result.subject).toContain('Short Shipment');
      expect(result.html).toContain('<!DOCTYPE html>');
    });

    it('throws for unknown template type', () => {
      expect(() => renderTemplate('unknown_type' as never, {})).toThrow(
        'Unknown template type: unknown_type'
      );
    });
  });

  // ─── All templates produce valid HTML ───────────────────────────────

  describe('all templates produce valid HTML structure', () => {
    const testCases = [
      {
        name: 'exception',
        data: {
          exceptionType: 'Test',
          severity: 'low' as const,
          quantityAffected: 1,
          referenceNumber: 'REF-1',
          actionUrl: '/test',
        },
        renderer: renderException,
      },
      {
        name: 'stockout',
        data: {
          partName: 'Part-1',
          riskLevel: 'medium' as const,
          triggeredAgeHours: 24,
          estimatedDaysOfSupply: 3,
          reason: 'Test reason',
          actionUrl: '/test',
        },
        renderer: renderStockout,
      },
      {
        name: 'po_lifecycle',
        data: {
          orderNumber: 'PO-1',
          status: 'created' as const,
          actionUrl: '/test',
        },
        renderer: renderPOLifecycle,
      },
      {
        name: 'order_status',
        data: {
          orderNumber: 'WO-1',
          orderType: 'Work Order',
          fromStatus: 'pending',
          toStatus: 'active',
          actionUrl: '/test',
        },
        renderer: renderOrderStatus,
      },
      {
        name: 'system_alert',
        data: {
          title: 'Test Alert',
          message: 'Test message',
        },
        renderer: renderSystemAlert,
      },
      {
        name: 'digest',
        data: {
          period: 'Daily',
          items: [{ type: 'test', title: 'Test', body: 'Body', timestamp: '2025-01-01T00:00:00Z' }],
        },
        renderer: renderDigest,
      },
    ];

    for (const tc of testCases) {
      it(`${tc.name}: returns subject and valid HTML`, () => {
        const result = tc.renderer(tc.data as never);
        expect(result.subject).toBeTruthy();
        expect(typeof result.subject).toBe('string');
        expect(result.html).toContain('<!DOCTYPE html>');
        expect(result.html).toContain('</html>');
        expect(result.html).toContain('Arda');
      });
    }
  });
});
