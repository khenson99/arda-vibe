import {
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  pgEnum,
  jsonb,
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

// ─── API Keys ──────────────────────────────────────────────────────────
export const apiKeys = authSchema.table(
  'api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    keyHash: varchar('key_hash', { length: 255 }).notNull().unique(),
    keyPrefix: varchar('key_prefix', { length: 32 }).notNull(),
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('api_keys_tenant_idx').on(table.tenantId),
    index('api_keys_created_by_idx').on(table.createdBy),
    index('api_keys_active_idx').on(table.isActive),
    index('api_keys_prefix_idx').on(table.keyPrefix),
  ]
);

// ─── User OAuth Tokens (for service integrations like Gmail) ─────────
// Separate from oauthAccounts (used for login). These tokens allow the app
// to act on behalf of the user with third-party APIs (e.g., send Gmail).
export const oauthTokenProviderEnum = pgEnum('oauth_token_provider', [
  'google',
]);

export const userOauthTokens = authSchema.table(
  'user_oauth_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    provider: oauthTokenProviderEnum('provider').notNull(),
    accessToken: text('access_token').notNull(), // encrypted at rest
    refreshToken: text('refresh_token').notNull(), // encrypted at rest
    tokenExpiry: timestamp('token_expiry', { withTimezone: true }),
    scopes: text('scopes').array().notNull().default([]),
    email: varchar('email', { length: 255 }), // provider email for display
    isValid: boolean('is_valid').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('user_oauth_tokens_user_provider_idx').on(table.userId, table.provider),
    index('user_oauth_tokens_tenant_idx').on(table.tenantId),
  ]
);

// ─── Relations ────────────────────────────────────────────────────────
export const userOauthTokensRelations = relations(userOauthTokens, ({ one }) => ({
  user: one(users, {
    fields: [userOauthTokens.userId],
    references: [users.id],
  }),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [users.tenantId],
    references: [tenants.id],
  }),
  oauthAccounts: many(oauthAccounts),
  refreshTokens: many(refreshTokens),
  passwordResetTokens: many(passwordResetTokens),
  apiKeys: many(apiKeys),
  userOauthTokens: many(userOauthTokens),
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

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  tenant: one(tenants, {
    fields: [apiKeys.tenantId],
    references: [tenants.id],
  }),
  creator: one(users, {
    fields: [apiKeys.createdBy],
    references: [users.id],
  }),
}));
