/**
 * Tier Classification
 *
 * Centralised mapping of notification types to delivery tiers.
 *
 *   IMMEDIATE — high-urgency; email is dispatched within seconds of event.
 *   DIGEST    — lower-urgency; persisted for periodic digest aggregation.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export type NotificationTier = 'immediate' | 'digest';

// ─── Tier Sets ──────────────────────────────────────────────────────────

export const IMMEDIATE_TIER_TYPES = new Set([
  'exception_alert',
  'stockout_warning',
  'production_hold',
  'automation_escalated',
] as const);

export const DIGEST_TIER_TYPES = new Set([
  'card_triggered',
  'po_created',
  'po_sent',
  'po_received',
  'wo_status_change',
  'transfer_status_change',
  'system_alert',
  'receiving_completed',
  'relowisa_recommendation',
] as const);

// ─── Lookup ─────────────────────────────────────────────────────────────

/**
 * Return the delivery tier for a given notification type.
 *
 * @throws if the type is not recognised in either tier set.
 */
export function getNotificationTier(notificationType: string): NotificationTier {
  if (IMMEDIATE_TIER_TYPES.has(notificationType as any)) {
    return 'immediate';
  }
  if (DIGEST_TIER_TYPES.has(notificationType as any)) {
    return 'digest';
  }
  throw new Error(`Unknown notification type for tier classification: ${notificationType}`);
}
