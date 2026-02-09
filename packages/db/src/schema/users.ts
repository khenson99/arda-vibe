import {
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { authSchema, tenants } from './tenants.js';

// ─── Enums ────────────────────────────────────────────────────────────
export const userRoleEnum = pgEnum('user_role', [
  'tenant_admin',
  'inventory_manager',
  'procurement_manager',
  'receiving_manager',
  'ecommerce_director',
  'salesperson',
  'executive',
]);

export const oauthProviderEnum = pgEnum('oauth_provider', [
  'google',
]);

// ─── Users ────────────────────────────────────────────────────────────
export const users = authSchema.table(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: text('password_hash'), // null if OAuth-only
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    avatarUrl: text('avatar_url'),
    role: userRoleEnum('role').notNull().default('inventory_manager'),
    isActive: boolean('is_active').notNull().default(true),
    emailVerified: boolean('email_verified').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_tenant_email_idx').on(table.tenantId, table.email),
    index('users_tenant_idx').on(table.tenantId),
    index('users_email_idx').on(table.email),
  ]
);

// ─── OAuth Accounts ───────────────────────────────────────────────────
export const oauthAccounts = authSchema.table(
  'oauth_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: oauthProviderEnum('provider').notNull(),
    providerAccountId: varchar('provider_account_id', { length: 255 }).notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('oauth_provider_account_idx').on(table.provider, table.providerAccountId),
    index('oauth_user_idx').on(table.userId),
  ]
);

// ─── Refresh Tokens ───────────────────────────────────────────────────
export const refreshTokens = authSchema.table(
  'refresh_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedByTokenId: uuid('replaced_by_token_id'),
    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('refresh_tokens_user_idx').on(table.userId),
    index('refresh_tokens_hash_idx').on(table.tokenHash),
  ]
);

// ─── Password Reset Tokens ────────────────────────────────────────────
export const passwordResetTokens = authSchema.table(
  'password_reset_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('password_reset_tokens_user_idx').on(table.userId),
    index('password_reset_tokens_hash_idx').on(table.tokenHash),
    index('password_reset_tokens_expires_idx').on(table.expiresAt),
  ]
);

// ─── Relations ────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [users.tenantId],
    references: [tenants.id],
  }),
  oauthAccounts: many(oauthAccounts),
  refreshTokens: many(refreshTokens),
  passwordResetTokens: many(passwordResetTokens),
}));

export const oauthAccountsRelations = relations(oauthAccounts, ({ one }) => ({
  user: one(users, {
    fields: [oauthAccounts.userId],
    references: [users.id],
  }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, {
    fields: [refreshTokens.userId],
    references: [users.id],
  }),
}));

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, {
    fields: [passwordResetTokens.userId],
    references: [users.id],
  }),
}));
