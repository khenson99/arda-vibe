import { Router, type Request } from 'express';
import { z } from 'zod';
import { db, schema, writeAuditEntry } from '@arda/db';
import { eq, and } from 'drizzle-orm';
import type { AuditContext } from '@arda/auth-utils';

function getRequestAuditContext(req: Request): AuditContext {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded as string | undefined)?.split(',')[0]?.trim();
  const rawIp = forwardedIp || req.socket.remoteAddress || undefined;
  const userAgentHeader = req.headers['user-agent'];
  const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
  return {
    userId: req.user?.sub,
    ipAddress: rawIp?.slice(0, 45),
    userAgent,
  };
}

export const preferencesRouter = Router();

// Validation schema for preferences update
const preferencesBodySchema = z.object({
  preferences: z.record(
    z.string(),
    z
      .object({
        inApp: z.boolean().optional().default(true),
        email: z.boolean().optional().default(true),
        webhook: z.boolean().optional().default(false),
      })
      .strict()
  ),
});

const API_TO_DB_CHANNEL = {
  inApp: 'in_app',
  email: 'email',
  webhook: 'webhook',
} as const;

const DB_TO_API_CHANNEL = {
  in_app: 'inApp',
  email: 'email',
  webhook: 'webhook',
} as const;

// Default preferences for all notification types
const DEFAULT_PREFERENCES = {
  card_triggered: { inApp: true, email: false, webhook: false },
  po_created: { inApp: true, email: true, webhook: false },
  po_sent: { inApp: true, email: false, webhook: false },
  po_received: { inApp: true, email: true, webhook: false },
  stockout_warning: { inApp: true, email: true, webhook: false },
  relowisa_recommendation: { inApp: true, email: false, webhook: false },
  exception_alert: { inApp: true, email: true, webhook: true },
  wo_status_change: { inApp: true, email: false, webhook: false },
  transfer_status_change: { inApp: true, email: false, webhook: false },
  system_alert: { inApp: true, email: true, webhook: false },
  receiving_completed: { inApp: true, email: true, webhook: false },
  production_hold: { inApp: true, email: true, webhook: false },
  automation_escalated: { inApp: true, email: true, webhook: true },
};

const DEFAULT_CHANNEL_PREFERENCES = { inApp: true, email: true, webhook: false };

// GET / — Get notification preferences for current user
preferencesRouter.get('/', async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;

    const prefs = await db
      .select()
      .from(schema.notificationPreferences)
      .where(
        and(
          eq(schema.notificationPreferences.tenantId, tenantId),
          eq(schema.notificationPreferences.userId, userId)
        )
      );

    // Format preferences by notification type and API channel names.
    const formatted: Record<string, Record<string, boolean>> = Object.fromEntries(
      Object.entries(DEFAULT_PREFERENCES).map(([notifType, channelPrefs]) => [notifType, { ...channelPrefs }])
    );

    // Override with user preferences if they exist
    for (const pref of prefs) {
      if (!formatted[pref.notificationType]) {
        formatted[pref.notificationType] = { ...DEFAULT_CHANNEL_PREFERENCES };
      }
      const channel = DB_TO_API_CHANNEL[pref.channel as keyof typeof DB_TO_API_CHANNEL];
      if (!channel) {
        continue;
      }
      formatted[pref.notificationType][channel] = pref.isEnabled;
    }

    res.json({ data: formatted });
  } catch (err) {
    next(err);
  }
});

// PUT / — Create or update notification preferences
preferencesRouter.put('/', async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const body = preferencesBodySchema.parse(req.body);

    // Snapshot previous state before mutation
    const previousPrefs = await db
      .select()
      .from(schema.notificationPreferences)
      .where(
        and(
          eq(schema.notificationPreferences.tenantId, tenantId),
          eq(schema.notificationPreferences.userId, userId)
        )
      );

    const previousState: Record<string, Record<string, boolean>> = {};
    for (const pref of previousPrefs) {
      const channel = DB_TO_API_CHANNEL[pref.channel as keyof typeof DB_TO_API_CHANNEL];
      if (!channel) continue;
      if (!previousState[pref.notificationType]) previousState[pref.notificationType] = {};
      previousState[pref.notificationType][channel] = pref.isEnabled;
    }

    const prefs = await db.transaction(async (tx) => {
      // Process each notification type and its channel preferences
      for (const [notifType, channelPrefs] of Object.entries(body.preferences)) {
        for (const [apiChannel, isEnabled] of Object.entries(channelPrefs)) {
          const channel = API_TO_DB_CHANNEL[apiChannel as keyof typeof API_TO_DB_CHANNEL];
          if (!channel) {
            continue;
          }

          const existing = await tx
            .select()
            .from(schema.notificationPreferences)
            .where(
              and(
                eq(schema.notificationPreferences.tenantId, tenantId),
                eq(schema.notificationPreferences.userId, userId),
                eq(schema.notificationPreferences.notificationType, notifType as (typeof schema.notificationTypeEnum.enumValues)[number]),
                eq(schema.notificationPreferences.channel, channel as (typeof schema.notificationChannelEnum.enumValues)[number])
              )
            );

          if (existing.length) {
            await tx
              .update(schema.notificationPreferences)
              .set({ isEnabled, updatedAt: new Date() })
              .where(eq(schema.notificationPreferences.id, existing[0].id));
          } else {
            await tx.insert(schema.notificationPreferences).values({
              tenantId,
              userId,
              notificationType: notifType as (typeof schema.notificationTypeEnum.enumValues)[number],
              channel: channel as (typeof schema.notificationChannelEnum.enumValues)[number],
              isEnabled,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
        }
      }

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'notification_preference.updated',
        entityType: 'notification_preference',
        entityId: null,
        previousState,
        newState: body.preferences,
        metadata: { source: 'preferences.update', targetUserId: userId },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return tx
        .select()
        .from(schema.notificationPreferences)
        .where(
          and(
            eq(schema.notificationPreferences.tenantId, tenantId),
            eq(schema.notificationPreferences.userId, userId)
          )
        );
    });

    const formatted: Record<string, Record<string, boolean>> = Object.fromEntries(
      Object.entries(DEFAULT_PREFERENCES).map(([notifType, channelPrefs]) => [notifType, { ...channelPrefs }])
    );
    for (const pref of prefs) {
      if (!formatted[pref.notificationType]) {
        formatted[pref.notificationType] = { ...DEFAULT_CHANNEL_PREFERENCES };
      }
      const channel = DB_TO_API_CHANNEL[pref.channel as keyof typeof DB_TO_API_CHANNEL];
      if (!channel) {
        continue;
      }
      formatted[pref.notificationType][channel] = pref.isEnabled;
    }

    res.json({ data: formatted });
  } catch (err) {
    next(err);
  }
});
