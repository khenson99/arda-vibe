import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted Mocks ──────────────────────────────────────────────────
const mockDb = vi.hoisted(() => {
  const mockInsertReturning = vi.fn().mockResolvedValue([]);
  const mockInsertValues = vi.fn().mockReturnValue({ returning: mockInsertReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  const mockUpdateReturning = vi.fn().mockResolvedValue([]);
  const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

  const mockTransaction = vi.fn().mockImplementation(async (fn) => {
    // Create a mock tx that behaves like db
    const tx = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    return fn(tx);
  });

  return {
    insert: mockInsert,
    update: mockUpdate,
    transaction: mockTransaction,
    query: {
      refreshTokens: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      users: {
        findFirst: vi.fn(),
      },
    },
    _mocks: {
      insertValues: mockInsertValues,
      insertReturning: mockInsertReturning,
      updateSet: mockUpdateSet,
      updateWhere: mockUpdateWhere,
      updateReturning: mockUpdateReturning,
    },
  };
});

const mockSchema = vi.hoisted(() => ({
  refreshTokens: {
    id: 'id',
    userId: 'user_id',
    tokenHash: 'token_hash',
    expiresAt: 'expires_at',
    revokedAt: 'revoked_at',
    replacedByTokenId: 'replaced_by_token_id',
    userAgent: 'user_agent',
    ipAddress: 'ip_address',
  },
  users: {
    id: 'id',
  },
}));

const mockAuthUtils = vi.hoisted(() => ({
  generateAccessToken: vi.fn().mockReturnValue('mock-access-token'),
  generateRefreshToken: vi.fn().mockReturnValue('mock-refresh-token'),
  verifyRefreshToken: vi.fn().mockReturnValue({
    sub: 'user-1',
    tokenId: 'token-1',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
  }),
}));

// ─── Mock Modules ───────────────────────────────────────────────────
vi.mock('@arda/db', () => ({
  db: mockDb,
  schema: mockSchema,
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'mock', sequenceNumber: 1 })),
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/auth-utils', () => mockAuthUtils);

// ─── Import After Mocks ─────────────────────────────────────────────
import {
  createTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  countActiveSessions,
  hashToken,
  TokenError,
} from './token.service.js';

// ─── Tests ──────────────────────────────────────────────────────────
describe('token.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createTokenPair', () => {
    it('generates access and refresh tokens', async () => {
      const result = await createTokenPair({
        userId: 'user-1',
        tenantId: 'tenant-1',
        email: 'test@example.com',
        role: 'tenant_admin',
      });

      expect(result).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
      });

      expect(mockAuthUtils.generateAccessToken).toHaveBeenCalledWith({
        sub: 'user-1',
        tenantId: 'tenant-1',
        email: 'test@example.com',
        role: 'tenant_admin',
      });
    });

    it('stores the refresh token in the database', async () => {
      await createTokenPair({
        userId: 'user-1',
        tenantId: 'tenant-1',
        email: 'test@example.com',
        role: 'tenant_admin',
        userAgent: 'test-agent',
        ipAddress: '127.0.0.1',
      });

      expect(mockDb.insert).toHaveBeenCalledWith(mockSchema.refreshTokens);
      const insertCall = mockDb._mocks.insertValues.mock.calls[0][0];
      expect(insertCall).toMatchObject({
        userId: 'user-1',
        userAgent: 'test-agent',
        ipAddress: '127.0.0.1',
      });
      expect(insertCall.tokenHash).toBeTruthy();
      expect(insertCall.expiresAt).toBeInstanceOf(Date);
    });
  });

  describe('rotateRefreshToken', () => {
    it('rejects an invalid JWT', async () => {
      mockAuthUtils.verifyRefreshToken.mockImplementationOnce(() => {
        throw new Error('invalid');
      });

      await expect(
        rotateRefreshToken({ token: 'bad-token' }),
      ).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
    });

    it('rejects a token not found in the database', async () => {
      mockDb.query.refreshTokens.findFirst.mockResolvedValueOnce(null);

      await expect(
        rotateRefreshToken({ token: 'mock-refresh-token' }),
      ).rejects.toThrow(TokenError);
    });

    it('detects replay and revokes all user tokens', async () => {
      // Return a token record that is already revoked (replay attack)
      mockDb.query.refreshTokens.findFirst.mockResolvedValueOnce({
        id: 'token-1',
        userId: 'user-1',
        tokenHash: hashToken('mock-refresh-token'),
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: new Date(), // Already revoked!
        replacedByTokenId: 'token-2',
      });

      await expect(
        rotateRefreshToken({ token: 'mock-refresh-token' }),
      ).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSE' });

      // Should have called update to revoke all tokens for the user
      expect(mockDb.update).toHaveBeenCalledWith(mockSchema.refreshTokens);
    });

    it('rejects an expired token', async () => {
      mockDb.query.refreshTokens.findFirst.mockResolvedValueOnce({
        id: 'token-1',
        userId: 'user-1',
        tokenHash: hashToken('mock-refresh-token'),
        expiresAt: new Date(Date.now() - 86400000), // Expired yesterday
        revokedAt: null,
      });

      await expect(
        rotateRefreshToken({ token: 'mock-refresh-token' }),
      ).rejects.toMatchObject({ code: 'REFRESH_TOKEN_EXPIRED' });
    });

    it('rejects if user is deactivated', async () => {
      mockDb.query.refreshTokens.findFirst.mockResolvedValueOnce({
        id: 'token-1',
        userId: 'user-1',
        tokenHash: hashToken('mock-refresh-token'),
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: null,
      });

      mockDb.query.users.findFirst.mockResolvedValueOnce({
        id: 'user-1',
        isActive: false,
        tenantId: 'tenant-1',
        email: 'test@example.com',
        role: 'tenant_admin',
        tenant: { name: 'Test' },
      });

      await expect(
        rotateRefreshToken({ token: 'mock-refresh-token' }),
      ).rejects.toMatchObject({ code: 'USER_INVALID' });
    });

    it('successfully rotates a valid token', async () => {
      mockDb.query.refreshTokens.findFirst.mockResolvedValueOnce({
        id: 'token-1',
        userId: 'user-1',
        tokenHash: hashToken('mock-refresh-token'),
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: null,
      });

      mockDb.query.users.findFirst.mockResolvedValueOnce({
        id: 'user-1',
        isActive: true,
        tenantId: 'tenant-1',
        email: 'test@example.com',
        role: 'tenant_admin',
        tenant: { name: 'Test' },
      });

      const result = await rotateRefreshToken({
        token: 'mock-refresh-token',
        userAgent: 'test-agent',
        ipAddress: '127.0.0.1',
      });

      expect(result).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
      });

      // Transaction should have been called
      expect(mockDb.transaction).toHaveBeenCalled();
    });
  });

  describe('revokeRefreshToken', () => {
    it('revokes a token by hash', async () => {
      await revokeRefreshToken('some-token');

      expect(mockDb.update).toHaveBeenCalledWith(mockSchema.refreshTokens);
      expect(mockDb._mocks.updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ revokedAt: expect.any(Date) }),
      );
    });
  });

  describe('revokeAllUserTokens', () => {
    it('revokes all active tokens for a user and returns count', async () => {
      mockDb._mocks.updateReturning.mockResolvedValueOnce([
        { id: 'token-1' },
        { id: 'token-2' },
      ]);

      const count = await revokeAllUserTokens('user-1');
      expect(count).toBe(2);
    });
  });

  describe('countActiveSessions', () => {
    it('counts only non-expired sessions', async () => {
      mockDb.query.refreshTokens.findMany.mockResolvedValueOnce([
        { expiresAt: new Date(Date.now() + 86400000) }, // Active
        { expiresAt: new Date(Date.now() + 86400000) }, // Active
        { expiresAt: new Date(Date.now() - 86400000) }, // Expired
      ]);

      const count = await countActiveSessions('user-1');
      expect(count).toBe(2);
    });
  });

  describe('hashToken', () => {
    it('produces a consistent SHA-256 hash', () => {
      const hash1 = hashToken('test-token');
      const hash2 = hashToken('test-token');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    it('produces different hashes for different tokens', () => {
      expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
    });
  });

  describe('TokenError', () => {
    it('has correct properties', () => {
      const err = new TokenError('test message', 'TEST_CODE');
      expect(err.message).toBe('test message');
      expect(err.code).toBe('TEST_CODE');
      expect(err.statusCode).toBe(401);
      expect(err.name).toBe('TokenError');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
