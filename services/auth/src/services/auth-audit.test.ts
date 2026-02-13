import { describe, it, expect, vi } from 'vitest';

// Mock @arda/db before importing auth-audit
vi.mock('@arda/db', () => ({
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'mock', sequenceNumber: 1 })),
  writeAuditEntries: vi.fn(async () => []),
}));

import { redactSensitiveFields, AuthAuditAction } from './auth-audit.js';

describe('auth-audit', () => {
  describe('AuthAuditAction', () => {
    it('should define all expected FR-05 action constants', () => {
      expect(AuthAuditAction.USER_LOGIN).toBe('user.login');
      expect(AuthAuditAction.USER_LOGIN_FAILED).toBe('user.login_failed');
      expect(AuthAuditAction.USER_LOGOUT).toBe('user.logout');
      expect(AuthAuditAction.USER_REGISTERED).toBe('user.registered');
      expect(AuthAuditAction.PASSWORD_RESET_REQUESTED).toBe('user.password_reset_requested');
      expect(AuthAuditAction.PASSWORD_RESET_COMPLETED).toBe('user.password_reset_completed');
      expect(AuthAuditAction.TOKEN_REFRESHED).toBe('token.refreshed');
      expect(AuthAuditAction.TOKEN_REPLAY_DETECTED).toBe('token.replay_detected');
      expect(AuthAuditAction.TOKEN_REVOKED).toBe('token.revoked');
      expect(AuthAuditAction.USER_INVITED).toBe('user.invited');
      expect(AuthAuditAction.USER_ROLE_CHANGED).toBe('user.role_changed');
      expect(AuthAuditAction.USER_DEACTIVATED).toBe('user.deactivated');
      expect(AuthAuditAction.USER_REACTIVATED).toBe('user.reactivated');
      expect(AuthAuditAction.OAUTH_GOOGLE_LINKED).toBe('oauth.google_linked');
      expect(AuthAuditAction.OAUTH_GOOGLE_LOGIN).toBe('oauth.google_login');
      expect(AuthAuditAction.OAUTH_GOOGLE_REGISTERED).toBe('oauth.google_registered');
      expect(AuthAuditAction.API_KEY_CREATED).toBe('api_key.created');
      expect(AuthAuditAction.API_KEY_REVOKED).toBe('api_key.revoked');
    });
  });

  describe('redactSensitiveFields', () => {
    it('should redact password fields', () => {
      const input = { email: 'test@example.com', password: 'secret123' };
      const result = redactSensitiveFields(input);
      expect(result).toEqual({ email: 'test@example.com', password: '[REDACTED]' });
    });

    it('should redact token-related fields', () => {
      const input = {
        tokenHash: 'abc123',
        refreshToken: 'rt_xyz',
        accessToken: 'at_xyz',
        idToken: 'id_xyz',
      };
      const result = redactSensitiveFields(input);
      expect(result).toEqual({
        tokenHash: '[REDACTED]',
        refreshToken: '[REDACTED]',
        accessToken: '[REDACTED]',
        idToken: '[REDACTED]',
      });
    });

    it('should redact nested sensitive fields', () => {
      const input = {
        user: { email: 'test@example.com', passwordHash: 'hash123' },
        config: { apiKey: 'key_123', webhookSecret: 'sec_abc' },
      };
      const result = redactSensitiveFields(input);
      expect(result).toEqual({
        user: { email: 'test@example.com', passwordHash: '[REDACTED]' },
        config: { apiKey: '[REDACTED]', webhookSecret: '[REDACTED]' },
      });
    });

    it('should handle null and undefined', () => {
      expect(redactSensitiveFields(null)).toBe(null);
      expect(redactSensitiveFields(undefined)).toBe(undefined);
    });

    it('should handle arrays', () => {
      const input = [{ password: 'a' }, { password: 'b' }];
      const result = redactSensitiveFields(input);
      expect(result).toEqual([{ password: '[REDACTED]' }, { password: '[REDACTED]' }]);
    });

    it('should preserve non-sensitive fields', () => {
      const input = { email: 'test@example.com', role: 'admin', isActive: true };
      const result = redactSensitiveFields(input);
      expect(result).toEqual(input);
    });

    it('should not mutate the original object', () => {
      const input = { password: 'secret', email: 'test@example.com' };
      redactSensitiveFields(input);
      expect(input.password).toBe('secret');
    });
  });
});
