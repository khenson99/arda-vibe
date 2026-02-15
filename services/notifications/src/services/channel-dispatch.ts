/**
 * Channel Dispatch Service
 *
 * After a notification is persisted (in-app), this module checks the
 * recipient's channel preferences and dispatches to email and/or webhook
 * channels accordingly.
 *
 * Flow per notification:
 *   1. Resolve channel preferences  (user → tenant default → hardcoded)
 *   2. For email (if enabled):
 *      - Immediate tier → create delivery record + enqueue email job
 *      - Digest tier    → skip (picked up by digest scheduler later)
 *   3. For webhook (if enabled):
 *      - Create delivery record (stub — actual webhook dispatch is future work)
 */

import type { Queue, Job } from 'bullmq';
import type { JobEnvelope } from '@arda/jobs';
import { createLogger } from '@arda/config';
import { db, schema } from '@arda/db';
import { and, eq } from 'drizzle-orm';
import { getNotificationTier } from './tier-classification.js';
import { enqueueEmail } from '../workers/email-queue.worker.js';
import type { EmailJobPayload } from '../workers/email-queue.worker.js';
import { renderTemplate, type TemplateType } from '../templates/index.js';
import {
  generateUnsubscribeToken,
  buildUnsubscribeUrl,
  buildUnsubscribeHeaders,
} from './unsubscribe-token.js';

const log = createLogger('channel-dispatch');

// ─── Types ──────────────────────────────────────────────────────────────

export interface DispatchParams {
  notificationId: string;
  tenantId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface DispatchContext {
  emailQueue: Queue<JobEnvelope<EmailJobPayload>>;
}

type ChannelName = 'email' | 'webhook';

// ─── Hardcoded Fallback Defaults ────────────────────────────────────────

/**
 * When neither user preference nor tenant default rows exist,
 * we fall back to these hardcoded defaults.
 */
function getHardcodedDefault(channel: ChannelName, tier: string): boolean {
  if (channel === 'email') {
    return tier === 'immediate'; // true for immediate, false for digest
  }
  // webhook — always false by default (tenants must opt in)
  return false;
}

// ─── Preference Resolution ──────────────────────────────────────────────

/**
 * Check whether a channel is enabled for a given user + notification type,
 * falling through: user pref → tenant default → hardcoded default.
 */
async function isChannelEnabled(
  tenantId: string,
  userId: string,
  notificationType: string,
  channel: ChannelName,
  tier: string,
): Promise<boolean> {
  // 1. User-level preference
  const [userPref] = await db
    .select({ isEnabled: schema.notificationPreferences.isEnabled })
    .from(schema.notificationPreferences)
    .where(
      and(
        eq(schema.notificationPreferences.tenantId, tenantId),
        eq(schema.notificationPreferences.userId, userId),
        eq(schema.notificationPreferences.notificationType, notificationType as any),
        eq(schema.notificationPreferences.channel, channel as any),
      ),
    );

  if (userPref !== undefined) {
    return userPref.isEnabled;
  }

  // 2. Tenant default preference
  const [tenantDefault] = await db
    .select({ isEnabled: schema.tenantDefaultPreferences.isEnabled })
    .from(schema.tenantDefaultPreferences)
    .where(
      and(
        eq(schema.tenantDefaultPreferences.tenantId, tenantId),
        eq(schema.tenantDefaultPreferences.notificationType, notificationType as any),
        eq(schema.tenantDefaultPreferences.channel, channel as any),
      ),
    );

  if (tenantDefault !== undefined) {
    return tenantDefault.isEnabled;
  }

  // 3. Hardcoded fallback
  return getHardcodedDefault(channel, tier);
}

// ─── Template Type Mapping ──────────────────────────────────────────────

/**
 * Map a notification type to the email template type used for rendering.
 * Returns undefined if no template mapping exists (the notification type
 * does not have a dedicated email template).
 */
function resolveTemplateType(notificationType: string): TemplateType | undefined {
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

// ─── Email Template Data Builder ────────────────────────────────────────

/**
 * Build the template data object for a given template type from
 * the notification params.  Falls back to a generic system_alert
 * structure when the metadata doesn't perfectly match.
 */
function buildTemplateData(
  templateType: TemplateType,
  params: DispatchParams,
): Record<string, unknown> {
  const meta = params.metadata || {};

  switch (templateType) {
    case 'exception':
      return {
        exceptionType: meta.exceptionType || params.title,
        severity: meta.severity || 'medium',
        quantityAffected: meta.quantityAffected || 0,
        referenceNumber: meta.receiptId || meta.orderId || '',
        details: params.body,
        actionUrl: params.actionUrl || '',
      };

    case 'stockout':
      return {
        partName: meta.partId || 'Unknown part',
        riskLevel: meta.riskLevel || 'medium',
        triggeredAgeHours: meta.triggeredAgeHours || 0,
        estimatedDaysOfSupply: meta.estimatedDaysOfSupply || 0,
        reason: params.body,
        actionUrl: params.actionUrl || '',
      };

    case 'po_lifecycle':
      return {
        orderNumber: meta.orderNumber || '',
        status: mapPOStatus(params.type, meta),
        supplierName: meta.supplierName,
        linkedCardCount: meta.linkedCardCount,
        actionUrl: params.actionUrl || '',
      };

    case 'order_status':
      return {
        orderNumber: meta.orderNumber || '',
        orderType: meta.orderType || '',
        fromStatus: meta.fromStatus || '',
        toStatus: meta.toStatus || '',
        actionUrl: params.actionUrl || '',
      };

    case 'system_alert':
    default:
      return {
        title: params.title,
        message: params.body,
        severity: meta.severity || 'info',
        actionUrl: params.actionUrl,
      };
  }
}

function mapPOStatus(
  notificationType: string,
  meta: Record<string, unknown>,
): string {
  if (notificationType === 'po_created') return 'created';
  if (notificationType === 'po_sent') return 'sent';
  if (notificationType === 'po_received') {
    return meta.toStatus === 'partially_received' ? 'partially_received' : 'received';
  }
  return 'created';
}

// ─── User Email Lookup ──────────────────────────────────────────────────

async function getUserEmail(userId: string): Promise<string | null> {
  const [user] = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId));

  return user?.email ?? null;
}

// ─── Delivery Record ────────────────────────────────────────────────────

async function createDeliveryRecord(
  tenantId: string,
  notificationId: string,
  userId: string,
  channel: ChannelName,
): Promise<string> {
  const [row] = await db
    .insert(schema.notificationDeliveries)
    .values({
      tenantId,
      notificationId,
      userId,
      channel: channel as any,
      status: 'pending',
      attemptCount: 0,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: schema.notificationDeliveries.id });

  return row.id;
}

// ─── Main Dispatch ──────────────────────────────────────────────────────

/**
 * Dispatch a single notification to email and/or webhook channels
 * based on the user's preferences and the notification's tier.
 */
export async function dispatchNotificationChannels(
  params: DispatchParams,
  ctx: DispatchContext,
): Promise<void> {
  const { notificationId, tenantId, userId, type } = params;

  let tier: string;
  try {
    tier = getNotificationTier(type);
  } catch {
    log.warn({ notificationType: type }, 'Skipping channel dispatch for unknown tier');
    return;
  }

  // ── Email Channel ────────────────────────────────────────────────────

  const emailEnabled = await isChannelEnabled(tenantId, userId, type, 'email', tier);

  if (emailEnabled) {
    if (tier === 'immediate') {
      await dispatchImmediateEmail(params, ctx, tier);
    } else {
      // Digest tier: notification already persisted; digest scheduler picks it up.
      log.debug(
        { notificationId, notificationType: type },
        'Digest-tier notification persisted; skipping immediate email',
      );
    }
  }

  // ── Webhook Channel ──────────────────────────────────────────────────

  const webhookEnabled = await isChannelEnabled(tenantId, userId, type, 'webhook', tier);

  if (webhookEnabled) {
    await dispatchWebhook(params);
  }
}

// ─── Email Dispatch (Immediate) ─────────────────────────────────────────

async function dispatchImmediateEmail(
  params: DispatchParams,
  ctx: DispatchContext,
  _tier: string,
): Promise<void> {
  const { notificationId, tenantId, userId, type } = params;

  // Look up user email
  const email = await getUserEmail(userId);
  if (!email) {
    log.warn({ userId, notificationId }, 'User has no email; skipping email dispatch');
    return;
  }

  // Create delivery record
  const deliveryId = await createDeliveryRecord(tenantId, notificationId, userId, 'email');

  // Render email template
  const templateType = resolveTemplateType(type);
  let subject: string;
  let html: string;

  if (templateType) {
    const templateData = buildTemplateData(templateType, params);
    const rendered = renderTemplate(templateType, templateData);
    subject = rendered.subject;
    html = rendered.html;
  } else {
    // Fallback plain text for unmapped types
    subject = params.title;
    html = `<p>${params.body}</p>`;
  }

  // Build unsubscribe headers (RFC 8058)
  const baseUrl = process.env.APP_URL || 'https://app.arda.cards';
  const unsubToken = generateUnsubscribeToken({
    userId,
    tenantId,
    notificationType: type,
    channel: 'email',
  });
  const unsubUrl = buildUnsubscribeUrl(baseUrl, unsubToken);
  const headers = buildUnsubscribeHeaders(unsubUrl);

  // Enqueue email job
  await enqueueEmail(ctx.emailQueue, {
    deliveryId,
    notificationId,
    tenantId,
    userId,
    to: email,
    subject,
    html,
    headers,
  });

  log.info(
    { deliveryId, notificationId, tenantId, userId, to: email },
    'Immediate email job enqueued',
  );
}

// ─── Webhook Dispatch (Stub) ────────────────────────────────────────────

async function dispatchWebhook(params: DispatchParams): Promise<void> {
  const { notificationId, tenantId, userId } = params;

  // Create delivery record for webhook
  const deliveryId = await createDeliveryRecord(tenantId, notificationId, userId, 'webhook');

  // TODO: Enqueue actual webhook delivery job in a future task
  log.info(
    { deliveryId, notificationId, tenantId, userId },
    'Webhook delivery record created (dispatch stub)',
  );
}
