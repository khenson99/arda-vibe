import { db, schema } from '@arda/db';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@arda/config';
import crypto from 'crypto';
import {
  AuthAuditAction,
  writeAuthAuditEntry,
  type AuthAuditContext,
} from './auth-audit.js';

const log = createLogger('auth:integration');

// ─── Types ────────────────────────────────────────────────────────────

export interface CreateApiKeyInput {
  tenantId: string;
  userId: string;
  name: string;
  permissions?: string[];
  expiresInDays?: number;
}

export interface CreateApiKeyResult {
  id: string;
  name: string;
  key: string; // Only returned on creation, never stored or returned again
  keyPrefix: string;
  permissions: string[];
  expiresAt: Date | null;
  createdAt: Date;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
  permissions: string[];
  createdAt: Date;
}

export interface UpdateWebhookInput {
  tenantId: string;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  webhookEvents?: string[];
}

// ─── API Key Generation ───────────────────────────────────────────────

/**
 * Generate a secure API key with format: arda_<prefix>_<secret>
 * Returns the full key (to be shown once) and its hash (to be stored).
 */
function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const prefix = crypto.randomBytes(4).toString('hex'); // 8 chars
  const secret = crypto.randomBytes(32).toString('hex'); // 64 chars
  const key = `arda_${prefix}_${secret}`;
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');

  return { key, keyHash, keyPrefix: `arda_${prefix}` };
}

// ─── Create API Key ───────────────────────────────────────────────────

/**
 * Create a new API key for the tenant.
 * Returns the full key (only shown once) and metadata.
 */
export async function createApiKey(input: CreateApiKeyInput, auditCtx?: AuthAuditContext): Promise<CreateApiKeyResult> {
  const { tenantId, userId, name, permissions = [], expiresInDays } = input;

  const { key, keyHash, keyPrefix } = generateApiKey();

  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const [apiKey] = await db
    .insert(schema.apiKeys)
    .values({
      tenantId,
      name,
      keyHash,
      keyPrefix,
      permissions,
      expiresAt,
      createdBy: userId,
    })
    .returning();

  log.info({ apiKeyId: apiKey.id, keyPrefix, name }, 'API key created');

  // Audit: API key created
  await writeAuthAuditEntry(db, {
    tenantId,
    action: AuthAuditAction.API_KEY_CREATED,
    entityType: 'api_key',
    entityId: apiKey.id,
    userId,
    newState: { name, keyPrefix, permissions, expiresAt },
    ipAddress: auditCtx?.ipAddress,
    userAgent: auditCtx?.userAgent,
  });

  return {
    id: apiKey.id,
    name: apiKey.name,
    key, // Full key returned ONLY on creation
    keyPrefix: apiKey.keyPrefix,
    permissions: apiKey.permissions as string[],
    expiresAt: apiKey.expiresAt,
    createdAt: apiKey.createdAt,
  };
}

// ─── List API Keys ────────────────────────────────────────────────────

/**
 * List all API keys for a tenant (without exposing the actual keys).
 */
export async function listApiKeys(tenantId: string): Promise<ApiKeyInfo[]> {
  const keys = await db.query.apiKeys.findMany({
    where: eq(schema.apiKeys.tenantId, tenantId),
    orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
  });

  return keys.map((k) => ({
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    lastUsedAt: k.lastUsedAt,
    expiresAt: k.expiresAt,
    isActive: k.isActive,
    permissions: k.permissions as string[],
    createdAt: k.createdAt,
  }));
}

// ─── Revoke API Key ───────────────────────────────────────────────────

/**
 * Revoke (deactivate) an API key.
 */
export async function revokeApiKey(
  apiKeyId: string,
  tenantId: string,
  revokedBy?: string,
  auditCtx?: AuthAuditContext,
): Promise<void> {
  // Read prior state before mutation for accurate audit trail
  const existing = await db.query.apiKeys.findFirst({
    where: and(eq(schema.apiKeys.id, apiKeyId), eq(schema.apiKeys.tenantId, tenantId)),
  });

  if (!existing) {
    throw new Error('API key not found');
  }

  if (!existing.isActive) {
    throw new Error('API key is already revoked');
  }

  const [updated] = await db
    .update(schema.apiKeys)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(schema.apiKeys.id, apiKeyId), eq(schema.apiKeys.tenantId, tenantId)))
    .returning();

  log.info({ apiKeyId, keyPrefix: updated.keyPrefix }, 'API key revoked');

  // Audit: API key revoked — previousState reflects actual persisted state
  await writeAuthAuditEntry(db, {
    tenantId,
    action: AuthAuditAction.API_KEY_REVOKED,
    entityType: 'api_key',
    entityId: apiKeyId,
    userId: revokedBy ?? null,
    previousState: { isActive: existing.isActive, keyPrefix: existing.keyPrefix },
    newState: { isActive: false, keyPrefix: updated.keyPrefix },
    metadata: { keyPrefix: updated.keyPrefix },
    ipAddress: auditCtx?.ipAddress,
    userAgent: auditCtx?.userAgent,
  });
}

// ─── Delete API Key ───────────────────────────────────────────────────

/**
 * Permanently delete an API key.
 */
export async function deleteApiKey(apiKeyId: string, tenantId: string): Promise<void> {
  const result = await db
    .delete(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, apiKeyId), eq(schema.apiKeys.tenantId, tenantId)))
    .returning();

  if (result.length === 0) {
    throw new Error('API key not found');
  }

  log.info({ apiKeyId }, 'API key deleted');
}

// ─── Update Webhook Settings ──────────────────────────────────────────

/**
 * Update tenant webhook configuration.
 */
export async function updateWebhookSettings(input: UpdateWebhookInput) {
  const { tenantId, webhookUrl, webhookSecret, webhookEvents } = input;

  const tenant = await db.query.tenants.findFirst({
    where: eq(schema.tenants.id, tenantId),
  });

  if (!tenant) {
    throw new Error('Tenant not found');
  }

  const updatedSettings: schema.TenantSettings = { ...(tenant.settings ?? {}) };

  if (webhookUrl !== undefined) {
    if (webhookUrl === null) {
      delete updatedSettings.webhookUrl;
    } else {
      updatedSettings.webhookUrl = webhookUrl;
    }
  }

  if (webhookSecret !== undefined) {
    if (webhookSecret === null) {
      delete updatedSettings.webhookSecret;
    } else {
      updatedSettings.webhookSecret = webhookSecret;
    }
  }

  if (webhookEvents !== undefined) {
    updatedSettings.webhookEvents = webhookEvents;
  }

  const [updated] = await db
    .update(schema.tenants)
    .set({ settings: updatedSettings, updatedAt: new Date() })
    .where(eq(schema.tenants.id, tenantId))
    .returning();

  log.info({ tenantId, hasWebhookUrl: !!webhookUrl }, 'Webhook settings updated');

  return {
    webhookUrl: updatedSettings.webhookUrl ?? null,
    webhookEvents: updatedSettings.webhookEvents ?? [],
    // Never return webhookSecret for security
  };
}

// ─── Get Webhook Settings ─────────────────────────────────────────────

/**
 * Get tenant webhook configuration (without exposing the secret).
 */
export async function getWebhookSettings(tenantId: string) {
  const tenant = await db.query.tenants.findFirst({
    where: eq(schema.tenants.id, tenantId),
  });

  if (!tenant) {
    throw new Error('Tenant not found');
  }

  const settings = (tenant.settings || {}) as Record<string, unknown>;

  return {
    webhookUrl: (settings.webhookUrl as string | null | undefined) || null,
    webhookEvents: (settings.webhookEvents as string[] | undefined) || [],
    hasWebhookSecret: !!settings.webhookSecret,
  };
}
