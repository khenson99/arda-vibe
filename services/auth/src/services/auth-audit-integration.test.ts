import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Test State ──────────────────────────────────────────────────────
const testState = vi.hoisted(() => ({
  auditEntries: [] as Array<Record<string, unknown>>,
}));

// ─── Hoisted Mocks ──────────────────────────────────────────────────
const mockWriteAuditEntry = vi.hoisted(() =>
  vi.fn(async (_dbOrTx: unknown, entry: Record<string, unknown>) => {
    testState.auditEntries.push(entry);
    return { id: 'audit-' + testState.auditEntries.length, hashChain: 'abc', sequenceNumber: testState.auditEntries.length };
  })
);

const mockWriteAuditEntries = vi.hoisted(() => vi.fn(async () => []));

const mockDb = vi.hoisted(() => {
  const mockInsertReturning = vi.fn().mockResolvedValue([]);
  const mockInsertValues = vi.fn().mockReturnValue({ returning: mockInsertReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  const mockUpdateReturning = vi.fn().mockResolvedValue([]);
  const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

  const mockTransaction = vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const tx = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      execute: vi.fn(),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    };
    return fn(tx);
  });

  return {
    insert: mockInsert,
    update: mockUpdate,
    transaction: mockTransaction,
    execute: vi.fn(),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }),
    query: {
      users: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      tenants: {
        findFirst: vi.fn(),
      },
      refreshTokens: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      oauthAccounts: {
        findFirst: vi.fn(),
      },
      passwordResetTokens: {
        findFirst: vi.fn(),
      },
      apiKeys: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    _mocks: {
      insert: mockInsert,
      insertValues: mockInsertValues,
      insertReturning: mockInsertReturning,
      update: mockUpdate,
      updateSet: mockUpdateSet,
      updateWhere: mockUpdateWhere,
      updateReturning: mockUpdateReturning,
      transaction: mockTransaction,
    },
  };
});

const mockSchema = vi.hoisted(() => ({
  tenants: { id: 'id', slug: 'slug' },
  users: {
    id: 'id',
    tenantId: 'tenantId',
    email: 'email',
    role: 'role',
    isActive: 'isActive',
  },
  refreshTokens: {
    id: 'id',
    userId: 'userId',
    tokenHash: 'tokenHash',
    revokedAt: 'revokedAt',
  },
  oauthAccounts: {
    id: 'id',
    provider: 'provider',
    providerAccountId: 'providerAccountId',
    userId: 'userId',
  },
  passwordResetTokens: {
    id: 'id',
    userId: 'userId',
    tokenHash: 'tokenHash',
    usedAt: 'usedAt',
  },
  apiKeys: {
    id: 'id',
    tenantId: 'tenant_id',
    name: 'name',
    keyHash: 'key_hash',
    keyPrefix: 'key_prefix',
    isActive: 'is_active',
    permissions: 'permissions',
    createdBy: 'created_by',
    expiresAt: 'expires_at',
  },
}));

vi.mock('@arda/db', () => ({
  db: mockDb,
  schema: mockSchema,
  writeAuditEntry: mockWriteAuditEntry,
  writeAuditEntries: mockWriteAuditEntries,
}));

vi.mock('@arda/config', () => ({
  config: {
    JWT_SECRET: 'test-secret',
    JWT_EXPIRY: '15m',
    REFRESH_TOKEN_EXPIRY: '7d',
    APP_URL: 'http://localhost:5173',
    CORS_ORIGINS: '',
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@arda/auth-utils', () => ({
  hashPassword: vi.fn(async () => 'hashed-password'),
  verifyPassword: vi.fn(async () => true),
  generateAccessToken: vi.fn(() => 'mock-access-token'),
  generateRefreshToken: vi.fn(() => 'mock-refresh-token'),
  verifyRefreshToken: vi.fn(() => ({
    sub: 'user-123',
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: 'token-id-123',
  })),
  authMiddleware: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock('../middleware/error-handler.js', () => ({
  AppError: class AppError extends Error {
    statusCode: number;
    code?: string;
    constructor(statusCode: number, message: string, code?: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  },
}));

vi.mock('./email.service.js', () => ({
  sendPasswordResetEmail: vi.fn(async () => {}),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn(),
}));

// ─── Import Services After Mocks ─────────────────────────────────────
import * as authService from './auth.service.js';
import * as userManagementService from './user-management.service.js';
import * as integrationService from './integration.service.js';

// ─── Test Helpers ────────────────────────────────────────────────────

const auditCtx = {
  userId: 'admin-user-123',
  ipAddress: '192.168.1.100',
  userAgent: 'TestBrowser/1.0',
};

function findAuditEntry(action: string) {
  return testState.auditEntries.find((e) => e.action === action);
}

function findAllAuditEntries(action: string) {
  return testState.auditEntries.filter((e) => e.action === action);
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('Auth Audit Integration', () => {
  beforeEach(() => {
    testState.auditEntries = [];
    vi.clearAllMocks();
  });

  // ─── Registration ────────────────────────────────────────────────

  describe('register', () => {
    it('should write user.registered audit entry on successful registration', async () => {
      mockDb.query.users.findFirst.mockResolvedValue(null);
      mockDb.query.tenants.findFirst.mockResolvedValue(null);

      mockDb._mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          insert: vi.fn()
            .mockReturnValueOnce({
              values: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ id: 'tenant-new', name: 'Test Co', slug: 'test-co' }]),
              }),
            })
            .mockReturnValueOnce({
              values: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{
                  id: 'user-new',
                  tenantId: 'tenant-new',
                  email: 'admin@testco.com',
                  firstName: 'Admin',
                  lastName: 'User',
                  role: 'tenant_admin',
                }]),
              }),
            }),
          execute: vi.fn(),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        };
        return fn(tx);
      });

      // createTokenPair needs refresh token insert
      mockDb._mocks.insertReturning.mockResolvedValue([]);

      const result = await authService.register({
        email: 'admin@testco.com',
        password: 'SecurePass123',
        firstName: 'Admin',
        lastName: 'User',
        companyName: 'Test Co',
      }, auditCtx);

      const entry = findAuditEntry('user.registered');
      expect(entry).toBeDefined();
      expect(entry!.entityType).toBe('user');
      expect(entry!.entityId).toBe('user-new');
      expect(entry!.userId).toBe('user-new');
      expect(entry!.tenantId).toBe('tenant-new');
      expect(entry!.ipAddress).toBe('192.168.1.100');
      expect(entry!.userAgent).toBe('TestBrowser/1.0');
      // Should not contain password in newState
      expect(entry!.newState).toBeDefined();
      expect((entry!.newState as Record<string, unknown>).password).toBeUndefined();
    });
  });

  // ─── Login ───────────────────────────────────────────────────────

  describe('login', () => {
    it('should write user.login audit entry on successful login', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        passwordHash: 'hashed',
        isActive: true,
        tenantId: 'tenant-123',
        firstName: 'Test',
        lastName: 'User',
        role: 'tenant_admin',
        tenant: { id: 'tenant-123', name: 'Test Tenant' },
      });

      const result = await authService.login(
        { email: 'test@example.com', password: 'password123' },
        auditCtx,
      );

      const entry = findAuditEntry('user.login');
      expect(entry).toBeDefined();
      expect(entry!.entityType).toBe('user');
      expect(entry!.entityId).toBe('user-123');
      expect(entry!.userId).toBe('user-123');
      expect(entry!.tenantId).toBe('tenant-123');
      expect((entry!.metadata as Record<string, unknown>).method).toBe('password');
      expect(entry!.ipAddress).toBe('192.168.1.100');
    });

    it('should write user.login_failed audit entry for invalid credentials', async () => {
      const { verifyPassword } = await import('@arda/auth-utils');
      (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        passwordHash: 'hashed',
        isActive: true,
        tenantId: 'tenant-123',
        tenant: { id: 'tenant-123', name: 'Test Tenant' },
      });

      await expect(
        authService.login({ email: 'test@example.com', password: 'wrong' }, auditCtx),
      ).rejects.toThrow('Invalid email or password');

      const entry = findAuditEntry('user.login_failed');
      expect(entry).toBeDefined();
      expect(entry!.userId).toBeNull();
      expect((entry!.metadata as Record<string, unknown>).reason).toBe('invalid_credentials');
      expect(entry!.ipAddress).toBe('192.168.1.100');
    });

    it('should write user.login_failed audit entry for deactivated account', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        passwordHash: 'hashed',
        isActive: false,
        tenantId: 'tenant-123',
        tenant: { id: 'tenant-123', name: 'Test Tenant' },
      });

      await expect(
        authService.login({ email: 'test@example.com', password: 'password123' }, auditCtx),
      ).rejects.toThrow('Account is deactivated');

      const entry = findAuditEntry('user.login_failed');
      expect(entry).toBeDefined();
      expect(entry!.userId).toBeNull();
      expect((entry!.metadata as Record<string, unknown>).reason).toBe('account_deactivated');
    });
  });

  // ─── User Management ─────────────────────────────────────────────

  describe('inviteUser', () => {
    it('should write user.invited audit entry', async () => {
      mockDb.query.tenants.findFirst.mockResolvedValue({
        id: 'tenant-123',
        seatLimit: 10,
      });
      mockDb.query.users.findMany.mockResolvedValue([
        { id: 'user-1', email: 'existing@example.com' },
      ]);
      mockDb._mocks.insertReturning.mockResolvedValue([{
        id: 'user-new',
        email: 'invited@example.com',
        firstName: 'Invited',
        lastName: 'User',
        role: 'inventory_manager',
        isActive: true,
        createdAt: new Date(),
      }]);

      await userManagementService.inviteUser({
        tenantId: 'tenant-123',
        email: 'invited@example.com',
        firstName: 'Invited',
        lastName: 'User',
        role: 'inventory_manager',
        performedBy: 'admin-user-123',
      }, auditCtx);

      const entry = findAuditEntry('user.invited');
      expect(entry).toBeDefined();
      expect(entry!.entityType).toBe('user');
      expect(entry!.entityId).toBe('user-new');
      expect(entry!.userId).toBe('admin-user-123');
      expect(entry!.tenantId).toBe('tenant-123');
      expect((entry!.metadata as Record<string, unknown>).invitedEmail).toBe('invited@example.com');
      expect((entry!.metadata as Record<string, unknown>).assignedRole).toBe('inventory_manager');
    });
  });

  describe('updateUserRole', () => {
    it('should write user.role_changed audit entry with previous/new state', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-456',
        email: 'existing@example.com',
        role: 'inventory_manager',
        tenantId: 'tenant-123',
      });
      mockDb._mocks.updateReturning.mockResolvedValue([{
        id: 'user-456',
        email: 'existing@example.com',
        firstName: 'Existing',
        lastName: 'User',
        role: 'procurement_manager',
        isActive: true,
        updatedAt: new Date(),
      }]);

      await userManagementService.updateUserRole({
        userId: 'user-456',
        tenantId: 'tenant-123',
        role: 'procurement_manager',
        performedBy: 'admin-user-123',
      }, auditCtx);

      const entry = findAuditEntry('user.role_changed');
      expect(entry).toBeDefined();
      expect(entry!.entityType).toBe('user');
      expect(entry!.entityId).toBe('user-456');
      expect(entry!.userId).toBe('admin-user-123');
      expect(entry!.previousState).toEqual({ role: 'inventory_manager' });
      expect(entry!.newState).toEqual({ role: 'procurement_manager' });
      expect((entry!.metadata as Record<string, unknown>).previousRole).toBe('inventory_manager');
      expect((entry!.metadata as Record<string, unknown>).newRole).toBe('procurement_manager');
    });
  });

  describe('deactivateUser', () => {
    it('should write user.deactivated audit entry with state transition', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-456',
        email: 'existing@example.com',
        role: 'inventory_manager',
        tenantId: 'tenant-123',
        isActive: true,
      });
      mockDb._mocks.updateReturning.mockResolvedValue([{
        id: 'user-456',
        email: 'existing@example.com',
        firstName: 'Existing',
        lastName: 'User',
        role: 'inventory_manager',
        isActive: false,
        updatedAt: new Date(),
      }]);

      await userManagementService.deactivateUser({
        userId: 'user-456',
        tenantId: 'tenant-123',
        performedBy: 'admin-user-123',
      }, auditCtx);

      const entry = findAuditEntry('user.deactivated');
      expect(entry).toBeDefined();
      expect(entry!.entityType).toBe('user');
      expect(entry!.entityId).toBe('user-456');
      expect(entry!.userId).toBe('admin-user-123');
      expect(entry!.previousState).toEqual({ isActive: true, role: 'inventory_manager' });
      expect(entry!.newState).toEqual({ isActive: false, role: 'inventory_manager' });
      expect((entry!.metadata as Record<string, unknown>).tokensRevoked).toBe(true);
    });
  });

  // ─── Sensitive Data Redaction ────────────────────────────────────

  describe('sensitive data redaction', () => {
    it('should not persist password in audit metadata for registration', async () => {
      mockDb.query.users.findFirst.mockResolvedValue(null);
      mockDb.query.tenants.findFirst.mockResolvedValue(null);

      mockDb._mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          insert: vi.fn()
            .mockReturnValueOnce({
              values: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ id: 'tenant-new', name: 'Co', slug: 'co' }]),
              }),
            })
            .mockReturnValueOnce({
              values: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{
                  id: 'user-new',
                  tenantId: 'tenant-new',
                  email: 'user@example.com',
                  firstName: 'A',
                  lastName: 'B',
                  role: 'tenant_admin',
                }]),
              }),
            }),
          execute: vi.fn(),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        };
        return fn(tx);
      });
      mockDb._mocks.insertReturning.mockResolvedValue([]);

      await authService.register({
        email: 'user@example.com',
        password: 'SuperSecret!',
        firstName: 'A',
        lastName: 'B',
        companyName: 'Co',
      }, auditCtx);

      // Check all audit entries don't contain raw passwords
      for (const entry of testState.auditEntries) {
        const allValues = JSON.stringify(entry);
        expect(allValues).not.toContain('SuperSecret!');
      }
    });
  });

  // ─── IP / User-Agent Propagation ──────────────────────────────────

  describe('audit context propagation', () => {
    it('should include ipAddress and userAgent from audit context', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        passwordHash: 'hashed',
        isActive: true,
        tenantId: 'tenant-123',
        firstName: 'Test',
        lastName: 'User',
        role: 'tenant_admin',
        tenant: { id: 'tenant-123', name: 'Test Tenant' },
      });

      await authService.login(
        { email: 'test@example.com', password: 'password123' },
        { ipAddress: '10.0.0.1', userAgent: 'MobileApp/2.0' },
      );

      const entry = findAuditEntry('user.login');
      expect(entry).toBeDefined();
      expect(entry!.ipAddress).toBe('10.0.0.1');
      expect(entry!.userAgent).toBe('MobileApp/2.0');
    });

    it('should handle missing audit context gracefully', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        passwordHash: 'hashed',
        isActive: true,
        tenantId: 'tenant-123',
        firstName: 'Test',
        lastName: 'User',
        role: 'tenant_admin',
        tenant: { id: 'tenant-123', name: 'Test Tenant' },
      });

      // Call without audit context
      await authService.login({ email: 'test@example.com', password: 'password123' });

      const entry = findAuditEntry('user.login');
      expect(entry).toBeDefined();
      // ipAddress and userAgent should be null when no context provided
      expect(entry!.ipAddress).toBeNull();
      expect(entry!.userAgent).toBeNull();
    });
  });

  // ─── System-Initiated Actions ─────────────────────────────────────

  describe('system-initiated actions', () => {
    it('should use userId: null for failed login attempts', async () => {
      const { verifyPassword } = await import('@arda/auth-utils');
      (verifyPassword as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        passwordHash: 'hashed',
        isActive: true,
        tenantId: 'tenant-123',
        tenant: { id: 'tenant-123', name: 'Test Tenant' },
      });

      await expect(
        authService.login({ email: 'test@example.com', password: 'wrong' }, auditCtx),
      ).rejects.toThrow();

      const entry = findAuditEntry('user.login_failed');
      expect(entry).toBeDefined();
      expect(entry!.userId).toBeNull();
    });
  });

  // ─── Password Reset ────────────────────────────────────────────────

  describe('forgotPassword', () => {
    it('should write user.password_reset_requested audit entry', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        isActive: true,
        tenantId: 'tenant-123',
        firstName: 'Test',
      });

      // forgotPassword uses db.transaction — tx needs update().set().where() chain (no .returning())
      mockDb._mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const mockWhere = vi.fn().mockResolvedValue(undefined);
        const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
        const mockTxUpdate = vi.fn().mockReturnValue({ set: mockSet });
        const tx = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
          }),
          update: mockTxUpdate,
          execute: vi.fn(),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        };
        return fn(tx);
      });

      await authService.forgotPassword({ email: 'test@example.com' }, auditCtx);

      const entry = findAuditEntry('user.password_reset_requested');
      expect(entry).toBeDefined();
      expect(entry!.entityType).toBe('user');
      expect(entry!.entityId).toBe('user-123');
      expect(entry!.userId).toBe('user-123');
      expect(entry!.tenantId).toBe('tenant-123');
      expect((entry!.metadata as Record<string, unknown>).email).toBe('test@example.com');
      expect(entry!.ipAddress).toBe('192.168.1.100');
    });
  });

  describe('resetPassword', () => {
    it('should write user.password_reset_completed audit entry', async () => {
      const futureDate = new Date(Date.now() + 3600_000);
      mockDb.query.passwordResetTokens.findFirst.mockResolvedValue({
        id: 'reset-token-1',
        userId: 'user-123',
        tokenHash: 'hash',
        expiresAt: futureDate,
        usedAt: null,
      });

      // user lookup after token validation (resetPassword calls db.query.users.findFirst)
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-123',
        tenantId: 'tenant-123',
        email: 'test@example.com',
        isActive: true,
      });

      // Transaction for resetPassword — tx.update() called 3 times (password, token, refresh tokens)
      mockDb._mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const mockWhere = vi.fn().mockResolvedValue(undefined);
        const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
        const mockTxUpdate = vi.fn().mockReturnValue({ set: mockSet });
        const tx = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
          update: mockTxUpdate,
          execute: vi.fn(),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        };
        return fn(tx);
      });

      await authService.resetPassword({ token: 'mock-token', newPassword: 'NewPass123!' }, auditCtx);

      const entry = findAuditEntry('user.password_reset_completed');
      expect(entry).toBeDefined();
      expect(entry!.entityType).toBe('user');
      expect(entry!.entityId).toBe('user-123');
      expect(entry!.userId).toBe('user-123');
      expect((entry!.metadata as Record<string, unknown>).tokensRevoked).toBe(true);
      // Ensure no raw password in audit
      const allValues = JSON.stringify(entry);
      expect(allValues).not.toContain('NewPass123!');
    });
  });

  // ─── Token Refresh ─────────────────────────────────────────────────

  describe('refreshAccessToken', () => {
    it('should write token.refreshed audit entry on successful refresh', async () => {
      // Token record exists, not revoked, not expired
      mockDb.query.refreshTokens.findFirst.mockResolvedValue({
        id: 'token-record-1',
        tokenHash: 'hash',
        userId: 'user-123',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 3600_000),
      });

      // User lookup
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com',
        isActive: true,
        tenantId: 'tenant-123',
        role: 'tenant_admin',
        tenant: { id: 'tenant-123', name: 'Test Tenant' },
      });

      // Transaction for token rotation
      mockDb._mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
          execute: vi.fn(),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        };
        return fn(tx);
      });

      await authService.refreshAccessToken('mock-refresh-token', auditCtx);

      const entry = findAuditEntry('token.refreshed');
      expect(entry).toBeDefined();
      expect(entry!.entityType).toBe('token');
      expect(entry!.entityId).toBe('token-record-1');
      expect(entry!.userId).toBe('user-123');
      expect(entry!.tenantId).toBe('tenant-123');
      expect((entry!.metadata as Record<string, unknown>).method).toBe('refresh');
      expect(entry!.ipAddress).toBe('192.168.1.100');
    });

    it('should write token.replay_detected audit entry on revoked token reuse', async () => {
      // Token record exists but is already revoked
      mockDb.query.refreshTokens.findFirst.mockResolvedValue({
        id: 'token-record-1',
        tokenHash: 'hash',
        userId: 'user-123',
        revokedAt: new Date(), // already revoked
        expiresAt: new Date(Date.now() + 3600_000),
      });

      // User lookup for replay audit
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-123',
        tenantId: 'tenant-123',
        email: 'test@example.com',
      });

      await expect(
        authService.refreshAccessToken('mock-refresh-token', auditCtx),
      ).rejects.toThrow('Refresh token has been revoked');

      const entry = findAuditEntry('token.replay_detected');
      expect(entry).toBeDefined();
      expect(entry!.entityType).toBe('token');
      expect(entry!.entityId).toBe('token-record-1');
      expect(entry!.userId).toBe('user-123');
      expect(entry!.tenantId).toBe('tenant-123');
      expect((entry!.metadata as Record<string, unknown>).reason).toBe('revoked_token_reuse');
    });
  });

  // ─── API Key Management ─────────────────────────────────────────────

  describe('createApiKey', () => {
    it('should write api_key.created audit entry', async () => {
      const mockApiKey = {
        id: 'api-key-1',
        tenantId: 'tenant-123',
        name: 'Production Key',
        keyHash: 'mock-hash',
        keyPrefix: 'arda_abc12345',
        permissions: ['read', 'write'],
        expiresAt: new Date('2027-01-01'),
        createdBy: 'user-123',
        createdAt: new Date(),
        updatedAt: new Date(),
        isActive: true,
        lastUsedAt: null,
      };

      mockDb._mocks.insertReturning.mockResolvedValue([mockApiKey]);

      await integrationService.createApiKey({
        tenantId: 'tenant-123',
        userId: 'user-123',
        name: 'Production Key',
        permissions: ['read', 'write'],
        expiresInDays: 365,
      }, auditCtx);

      const entry = findAuditEntry('api_key.created');
      expect(entry).toBeDefined();
      expect(entry!.entityType).toBe('api_key');
      expect(entry!.entityId).toBe('api-key-1');
      expect(entry!.userId).toBe('user-123');
      expect(entry!.tenantId).toBe('tenant-123');
      expect((entry!.newState as Record<string, unknown>).name).toBe('Production Key');
      expect(entry!.ipAddress).toBe('192.168.1.100');
      // Ensure no raw API key in audit
      const allValues = JSON.stringify(entry);
      expect(allValues).not.toMatch(/arda_[a-f0-9]{8}_[a-f0-9]{64}/);
    });
  });

  describe('revokeApiKey', () => {
    it('should write api_key.revoked audit entry with state transition', async () => {
      mockDb._mocks.updateReturning.mockResolvedValue([{
        id: 'api-key-1',
        keyPrefix: 'arda_abc12345',
        isActive: false,
      }]);

      await integrationService.revokeApiKey('api-key-1', 'tenant-123', 'admin-user-123', auditCtx);

      const entry = findAuditEntry('api_key.revoked');
      expect(entry).toBeDefined();
      expect(entry!.entityType).toBe('api_key');
      expect(entry!.entityId).toBe('api-key-1');
      expect(entry!.userId).toBe('admin-user-123');
      expect(entry!.tenantId).toBe('tenant-123');
      expect(entry!.previousState).toEqual({ isActive: true, keyPrefix: 'arda_abc12345' });
      expect(entry!.newState).toEqual({ isActive: false, keyPrefix: 'arda_abc12345' });
      expect(entry!.ipAddress).toBe('192.168.1.100');
    });
  });
});
