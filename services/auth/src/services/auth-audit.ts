import { writeAuditEntry, type AuditEntryInput } from '@arda/db';
import type { DbOrTransaction } from '@arda/db';

// ─── Auth Audit Action Constants ─────────────────────────────────────
// FR-05: Identity & authentication lifecycle events

export const AuthAuditAction = {
  // Authentication
  USER_LOGIN: 'user.login',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGOUT: 'user.logout',
  USER_REGISTERED: 'user.registered',

  // Password
  PASSWORD_RESET_REQUESTED: 'user.password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'user.password_reset_completed',

  // Token
  TOKEN_REFRESHED: 'token.refreshed',
  TOKEN_REPLAY_DETECTED: 'token.replay_detected',
  TOKEN_REVOKED: 'token.revoked',

  // User management
  USER_INVITED: 'user.invited',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_DEACTIVATED: 'user.deactivated',
  USER_REACTIVATED: 'user.reactivated',

  // OAuth
  OAUTH_GOOGLE_LINKED: 'oauth.google_linked',
  OAUTH_GOOGLE_LOGIN: 'oauth.google_login',
  OAUTH_GOOGLE_REGISTERED: 'oauth.google_registered',

  // API keys
  API_KEY_CREATED: 'api_key.created',
  API_KEY_REVOKED: 'api_key.revoked',
} as const;

export type AuthAuditActionType = (typeof AuthAuditAction)[keyof typeof AuthAuditAction];

// ─── Sensitive Field Redaction ───────────────────────────────────────

const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'newPassword',
  'token',
  'tokenHash',
  'refreshToken',
  'accessToken',
  'idToken',
  'apiKey',
  'keyHash',
  'secret',
  'webhookSecret',
  'resetToken',
]);

/**
 * Deep-clone an object and replace sensitive field values with '[REDACTED]'.
 * Returns null if input is null/undefined.
 */
export function redactSensitiveFields<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveFields(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = REDACTED;
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitiveFields(value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

// ─── Auth Audit Context ──────────────────────────────────────────────

export interface AuthAuditContext {
  userId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

// ─── Convenience Writer ──────────────────────────────────────────────

/**
 * Write an auth audit entry with standard field mapping.
 * Wraps writeAuditEntry to reduce boilerplate in auth service functions.
 */
export async function writeAuthAuditEntry(
  dbOrTx: DbOrTransaction,
  input: {
    tenantId: string;
    action: AuthAuditActionType;
    entityType: string;
    entityId?: string | null;
    userId?: string | null;
    previousState?: unknown;
    newState?: unknown;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
) {
  const entry: AuditEntryInput = {
    tenantId: input.tenantId,
    userId: input.userId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    previousState: input.previousState ? redactSensitiveFields(input.previousState) : null,
    newState: input.newState ? redactSensitiveFields(input.newState) : null,
    metadata: input.metadata ? redactSensitiveFields(input.metadata) : {},
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  };

  return writeAuditEntry(dbOrTx, entry);
}
