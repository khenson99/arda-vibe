import { db, schema } from '@arda/db';
import { eq } from 'drizzle-orm';
import { createLogger } from '@arda/config';
import {
  NOTIFICATION_DEFAULT_PREFERENCES,
  API_TO_DB_CHANNEL,
  type NotificationApiChannel,
} from '@arda/shared-types';

const log = createLogger('auth:notification-preference-init');

/**
 * Initializes notification preference rows for a newly created user.
 *
 * Priority:
 *  1. Tenant default preferences (if rows exist in tenant_default_preferences)
 *  2. System defaults (NOTIFICATION_DEFAULT_PREFERENCES from @arda/shared-types)
 *
 * This function is safe to call during user provisioning (register or invite).
 * Errors are caught and logged — user creation must not fail due to preference init.
 */
export async function initializeUserNotificationPreferences(
  tenantId: string,
  userId: string
): Promise<void> {
  try {
    // 1. Try to load tenant-specific defaults
    const tenantDefaults = await db
      .select()
      .from(schema.tenantDefaultPreferences)
      .where(eq(schema.tenantDefaultPreferences.tenantId, tenantId));

    const now = new Date();

    if (tenantDefaults.length > 0) {
      // Use tenant defaults — insert each row as a user preference
      const values = tenantDefaults.map((td) => ({
        tenantId,
        userId,
        notificationType: td.notificationType,
        channel: td.channel,
        isEnabled: td.isEnabled,
        createdAt: now,
        updatedAt: now,
      }));

      await db.insert(schema.notificationPreferences).values(values);
      log.info({ userId, tenantId, count: values.length }, 'User preferences initialized from tenant defaults');
      return;
    }

    // 2. Fallback: use system defaults
    const values: Array<{
      tenantId: string;
      userId: string;
      notificationType: (typeof schema.notificationTypeEnum.enumValues)[number];
      channel: (typeof schema.notificationChannelEnum.enumValues)[number];
      isEnabled: boolean;
      createdAt: Date;
      updatedAt: Date;
    }> = [];

    for (const [notifType, channelPrefs] of Object.entries(NOTIFICATION_DEFAULT_PREFERENCES)) {
      for (const [apiChannel, isEnabled] of Object.entries(channelPrefs)) {
        const dbChannel = API_TO_DB_CHANNEL[apiChannel as NotificationApiChannel];
        if (!dbChannel) continue;

        values.push({
          tenantId,
          userId,
          notificationType: notifType as (typeof schema.notificationTypeEnum.enumValues)[number],
          channel: dbChannel as (typeof schema.notificationChannelEnum.enumValues)[number],
          isEnabled,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    if (values.length > 0) {
      await db.insert(schema.notificationPreferences).values(values);
    }

    log.info({ userId, tenantId, count: values.length }, 'User preferences initialized from system defaults');
  } catch (err) {
    // Log but don't throw — user creation should not fail due to preference initialization
    log.error({ err, userId, tenantId }, 'Failed to initialize user notification preferences');
  }
}
