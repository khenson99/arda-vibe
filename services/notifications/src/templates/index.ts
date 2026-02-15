export { baseLayout, resolveActionUrl, actionButton, escapeHtml } from './base-layout.js';
export { renderException, type ExceptionTemplateData } from './exception.js';
export { renderStockout, type StockoutTemplateData } from './stockout.js';
export { renderPOLifecycle, type POLifecycleTemplateData, type POLifecycleStatus } from './po-lifecycle.js';
export { renderOrderStatus, type OrderStatusTemplateData } from './order-status.js';
export { renderSystemAlert, type SystemAlertTemplateData } from './system-alert.js';
export { renderDigest, type DigestTemplateData, type DigestItem } from './digest.js';

// ─── Render Function Registry ───────────────────────────────────────────
import { renderException } from './exception.js';
import { renderStockout } from './stockout.js';
import { renderPOLifecycle } from './po-lifecycle.js';
import { renderOrderStatus } from './order-status.js';
import { renderSystemAlert } from './system-alert.js';
import { renderDigest } from './digest.js';

/**
 * Template type identifiers that map to render functions.
 * Downstream consumers (e.g., the queue worker) look up templates by type
 * and pass typed data to the appropriate render function.
 */
export type TemplateType =
  | 'exception'
  | 'stockout'
  | 'po_lifecycle'
  | 'order_status'
  | 'system_alert'
  | 'digest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const templateRegistry: Record<TemplateType, (data: any) => { subject: string; html: string }> = {
  exception: renderException,
  stockout: renderStockout,
  po_lifecycle: renderPOLifecycle,
  order_status: renderOrderStatus,
  system_alert: renderSystemAlert,
  digest: renderDigest,
};

/**
 * Map a notification type to the email template type used for rendering.
 * Returns undefined if no template mapping exists (the notification type
 * does not have a dedicated email template).
 */
export function resolveTemplateType(notificationType: string): TemplateType | undefined {
  const map: Record<string, TemplateType> = {
    exception_alert: 'exception',
    stockout_warning: 'stockout',
    po_created: 'po_lifecycle',
    po_sent: 'po_lifecycle',
    po_received: 'po_lifecycle',
    wo_status_change: 'order_status',
    transfer_status_change: 'order_status',
    system_alert: 'system_alert',
    production_hold: 'system_alert',
    automation_escalated: 'system_alert',
    card_triggered: 'system_alert',
    receiving_completed: 'system_alert',
    relowisa_recommendation: 'system_alert',
  };
  return map[notificationType];
}

/**
 * Render a notification email by template type.
 * Throws if the template type is not found in the registry.
 */
export function renderTemplate(
  type: TemplateType,
  data: unknown
): { subject: string; html: string } {
  const renderer = templateRegistry[type];
  if (!renderer) {
    throw new Error(`Unknown template type: ${type}`);
  }
  return renderer(data);
}
