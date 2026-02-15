import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
  integer,
} from 'drizzle-orm/pg-core';

export const notificationsSchema = pgSchema('notifications');

// ─── Enums ────────────────────────────────────────────────────────────
export const notificationTypeEnum = pgEnum('notification_type', [
  'card_triggered',
  'po_created',
  'po_sent',
  'po_received',
  'stockout_warning',
  'relowisa_recommendation',
  'exception_alert',
  'wo_status_change',
  'transfer_status_change',
  'system_alert',
  'receiving_completed',
  'production_hold',
  'automation_escalated',
]);

export const notificationChannelEnum = pgEnum('notification_channel', [
  'in_app',
  'email',
  'webhook',
]);

export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',
  'sent',
  'delivered',
  'failed',
  'bounced',
]);

// ─── Notifications ───────────────────────────────────────────────────
export const notifications = notificationsSchema.table(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(), // recipient
    type: notificationTypeEnum('type').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    body: text('body').notNull(),
    isRead: boolean('is_read').notNull().default(false),
    readAt: timestamp('read_at', { withTimezone: true }),
    actionUrl: text('action_url'), // deep link into the app
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('notifications_tenant_idx').on(table.tenantId),
    index('notifications_user_idx').on(table.userId),
    index('notifications_user_unread_idx').on(table.userId, table.isRead),
    index('notifications_time_idx').on(table.createdAt),
  ]
);

// ─── Notification Preferences ────────────────────────────────────────
export const notificationPreferences = notificationsSchema.table(
  'notification_preferences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    notificationType: notificationTypeEnum('notification_type').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    isEnabled: boolean('is_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('notif_prefs_user_idx').on(table.userId),
    index('notif_prefs_tenant_idx').on(table.tenantId),
    uniqueIndex('notif_prefs_unique_idx').on(
      table.tenantId, table.userId, table.notificationType, table.channel
    ),
  ]
);

// ─── Tenant Default Preferences ──────────────────────────────────────
export const tenantDefaultPreferences = notificationsSchema.table(
  'tenant_default_preferences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    notificationType: notificationTypeEnum('notification_type').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    isEnabled: boolean('is_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tenant_default_prefs_tenant_idx').on(table.tenantId),
    index('tenant_default_prefs_type_idx').on(table.notificationType),
    uniqueIndex('tenant_default_prefs_unique_idx').on(
      table.tenantId, table.notificationType, table.channel
    ),
  ]
);

// ─── Notification Deliveries ─────────────────────────────────────────
export const notificationDeliveries = notificationsSchema.table(
  'notification_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    notificationId: uuid('notification_id').notNull(),
    userId: uuid('user_id').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    status: deliveryStatusEnum('status').notNull().default('pending'),
    provider: varchar('provider', { length: 50 }),
    providerMessageId: varchar('provider_message_id', { length: 255 }),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('notif_deliveries_tenant_idx').on(table.tenantId),
    index('notif_deliveries_user_status_idx').on(table.userId, table.status),
    index('notif_deliveries_notification_idx').on(table.notificationId),
    index('notif_deliveries_status_created_idx').on(table.status, table.createdAt),
  ]
);

// ─── Digest Run Markers ──────────────────────────────────────────────
export const digestRunMarkers = notificationsSchema.table(
  'digest_run_markers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }).notNull(),
    notificationCount: integer('notification_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('digest_markers_user_idx').on(table.userId),
    index('digest_markers_tenant_idx').on(table.tenantId),
    index('digest_markers_last_run_idx').on(table.lastRunAt),
  ]
);
