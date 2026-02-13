import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const authSchema = pgSchema('auth');

// ─── Tenants (Companies) ──────────────────────────────────────────────
export const tenants = authSchema.table(
  'tenants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull().unique(),
    domain: varchar('domain', { length: 255 }),
    logoUrl: text('logo_url'),
    settings: jsonb('settings').$type<TenantSettings>().default({}),
    stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
    stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
    planId: varchar('plan_id', { length: 50 }).notNull().default('free'),
    cardLimit: integer('card_limit').notNull().default(50),
    seatLimit: integer('seat_limit').notNull().default(3),
    isActive: boolean('is_active').notNull().default(true),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tenants_slug_idx').on(table.slug),
    index('tenants_stripe_customer_idx').on(table.stripeCustomerId),
  ]
);

// ─── Types ────────────────────────────────────────────────────────────
export interface TenantSettings {
  timezone?: string;
  dateFormat?: string;
  currency?: string;
  defaultCardFormat?: string;
  requireApprovalForPO?: boolean;
  autoConsolidateOrders?: boolean;
  reloWisaEnabled?: boolean;
  cardTemplateDesignerEnabled?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookEvents?: string[];
  /** Number of days to retain audit logs before archiving. Default: 365. */
  auditRetentionDays?: number;
  /** Whether automatic audit log archiving is enabled. Default: false. */
  auditArchiveEnabled?: boolean;
}
