import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InferSelectModel } from 'drizzle-orm';
import type { schema } from '@arda/db';

// ─── Hoisted Mocks ──────────────────────────────────────────────────
const mockDb = vi.hoisted(() => {
  const mockInsertReturning = vi.fn().mockResolvedValue([]);
  const mockInsertValues = vi.fn().mockReturnValue({ returning: mockInsertReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  const mockUpdateReturning = vi.fn().mockResolvedValue([]);
  const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

  const mockDeleteReturning = vi.fn().mockResolvedValue([]);
  const mockDeleteWhere = vi.fn().mockReturnValue({ returning: mockDeleteReturning });
  const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

  return {
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    query: {
      apiKeys: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      tenants: {
        findFirst: vi.fn(),
      },
    },
    _mocks: {
      insertValues: mockInsertValues,
      insertReturning: mockInsertReturning,
      updateSet: mockUpdateSet,
      updateWhere: mockUpdateWhere,
      updateReturning: mockUpdateReturning,
      deleteWhere: mockDeleteWhere,
      deleteReturning: mockDeleteReturning,
    },
  };
});

const mockSchema = vi.hoisted(() => ({
  apiKeys: {
    id: 'id',
    tenantId: 'tenant_id',
    name: 'name',
    keyHash: 'key_hash',
    keyPrefix: 'key_prefix',
    lastUsedAt: 'last_used_at',
    expiresAt: 'expires_at',
    isActive: 'is_active',
    permissions: 'permissions',
    createdBy: 'created_by',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  tenants: {
    id: 'id',
    settings: 'settings',
  },
}));

vi.mock('@arda/db', () => ({
  db: mockDb,
  schema: mockSchema,
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'mock', sequenceNumber: 1 })),
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/config', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ─── Import Service After Mocks ───────────────────────────────────────
import * as integrationService from './integration.service.js';

describe('Integration Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createApiKey', () => {
    it('should create an API key with all fields', async () => {
      const mockApiKey = {
        id: 'api-key-1',
        tenantId: 'tenant-1',
        name: 'Production API Key',
        keyHash: 'mock-hash',
        keyPrefix: 'arda_abc123',
        permissions: ['read', 'write'],
        expiresAt: new Date('2027-01-01'),
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        isActive: true,
        lastUsedAt: null,
      };

      mockDb._mocks.insertReturning.mockResolvedValue([mockApiKey]);

      const result = await integrationService.createApiKey({
        tenantId: 'tenant-1',
        userId: 'user-1',
        name: 'Production API Key',
        permissions: ['read', 'write'],
        expiresInDays: 365,
      });

      expect(result.id).toBe('api-key-1');
      expect(result.name).toBe('Production API Key');
      expect(result.keyPrefix).toBe('arda_abc123'); // From mock
      expect(result.key).toMatch(/^arda_[a-f0-9]{8}_[a-f0-9]{64}$/); // Generated key format
      expect(result.permissions).toEqual(['read', 'write']);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('should create an API key without expiration', async () => {
      const mockApiKey = {
        id: 'api-key-2',
        tenantId: 'tenant-1',
        name: 'Dev API Key',
        keyHash: 'mock-hash',
        keyPrefix: 'arda_def456',
        permissions: [],
        expiresAt: null,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        isActive: true,
        lastUsedAt: null,
      };

      mockDb._mocks.insertReturning.mockResolvedValue([mockApiKey]);

      const result = await integrationService.createApiKey({
        tenantId: 'tenant-1',
        userId: 'user-1',
        name: 'Dev API Key',
      });

      expect(result.expiresAt).toBeNull();
    });
  });

  describe('listApiKeys', () => {
    it('should list all API keys for a tenant', async () => {
      const mockKeys = [
        {
          id: 'key-1',
          name: 'Production Key',
          keyPrefix: 'arda_abc123',
          lastUsedAt: new Date('2026-02-10'),
          expiresAt: null,
          isActive: true,
          permissions: ['read', 'write'],
          createdAt: new Date('2026-01-01'),
        },
        {
          id: 'key-2',
          name: 'Staging Key',
          keyPrefix: 'arda_def456',
          lastUsedAt: null,
          expiresAt: new Date('2027-01-01'),
          isActive: true,
          permissions: ['read'],
          createdAt: new Date('2026-01-15'),
        },
      ];

      mockDb.query.apiKeys.findMany.mockResolvedValue(mockKeys);

      const result = await integrationService.listApiKeys('tenant-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('key-1');
      expect(result[1].id).toBe('key-2');
      expect(mockDb.query.apiKeys.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.anything(),
        })
      );
    });

    it('should return empty array when no keys exist', async () => {
      mockDb.query.apiKeys.findMany.mockResolvedValue([]);

      const result = await integrationService.listApiKeys('tenant-1');

      expect(result).toEqual([]);
    });
  });

  describe('revokeApiKey', () => {
    it('should revoke an API key', async () => {
      mockDb.query.apiKeys.findFirst.mockResolvedValue({
        id: 'key-1',
        keyPrefix: 'arda_abc123',
        isActive: true,
      });

      const mockRevokedKey = {
        id: 'key-1',
        keyPrefix: 'arda_abc123',
        isActive: false,
      };

      mockDb._mocks.updateReturning.mockResolvedValue([mockRevokedKey]);

      await integrationService.revokeApiKey('key-1', 'tenant-1');

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb._mocks.updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false })
      );
    });

    it('should throw error when API key not found', async () => {
      mockDb.query.apiKeys.findFirst.mockResolvedValue(null);

      await expect(integrationService.revokeApiKey('nonexistent', 'tenant-1')).rejects.toThrow(
        'API key not found'
      );
    });

    it('should throw error when API key is already revoked', async () => {
      mockDb.query.apiKeys.findFirst.mockResolvedValue({
        id: 'key-1',
        keyPrefix: 'arda_abc123',
        isActive: false,
      });

      await expect(integrationService.revokeApiKey('key-1', 'tenant-1')).rejects.toThrow(
        'API key is already revoked'
      );
    });
  });

  describe('deleteApiKey', () => {
    it('should delete an API key', async () => {
      mockDb._mocks.deleteReturning.mockResolvedValue([{ id: 'key-1' }]);

      await integrationService.deleteApiKey('key-1', 'tenant-1');

      expect(mockDb.delete).toHaveBeenCalled();
    });

    it('should throw error when API key not found', async () => {
      mockDb._mocks.deleteReturning.mockResolvedValue([]);

      await expect(integrationService.deleteApiKey('nonexistent', 'tenant-1')).rejects.toThrow(
        'API key not found'
      );
    });
  });

  describe('updateWebhookSettings', () => {
    it('should update webhook URL and events', async () => {
      const mockTenant = {
        id: 'tenant-1',
        settings: {
          timezone: 'America/Los_Angeles',
        },
      };

      const mockUpdatedTenant = {
        id: 'tenant-1',
        settings: {
          timezone: 'America/Los_Angeles',
          webhookUrl: 'https://example.com/webhook',
          webhookEvents: ['order.created', 'order.updated'],
        },
      };

      mockDb.query.tenants.findFirst.mockResolvedValue(mockTenant);
      mockDb._mocks.updateReturning.mockResolvedValue([mockUpdatedTenant]);

      const result = await integrationService.updateWebhookSettings({
        tenantId: 'tenant-1',
        webhookUrl: 'https://example.com/webhook',
        webhookEvents: ['order.created', 'order.updated'],
      });

      expect(result.webhookUrl).toBe('https://example.com/webhook');
      expect(result.webhookEvents).toEqual(['order.created', 'order.updated']);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should update webhook secret', async () => {
      const mockTenant = {
        id: 'tenant-1',
        settings: {},
      };

      mockDb.query.tenants.findFirst.mockResolvedValue(mockTenant);
      mockDb._mocks.updateReturning.mockResolvedValue([mockTenant]);

      await integrationService.updateWebhookSettings({
        tenantId: 'tenant-1',
        webhookSecret: 'new-secret',
      });

      expect(mockDb._mocks.updateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ webhookSecret: 'new-secret' }),
        })
      );
    });

    it('should throw error when tenant not found', async () => {
      mockDb.query.tenants.findFirst.mockResolvedValue(null);

      await expect(
        integrationService.updateWebhookSettings({
          tenantId: 'nonexistent',
          webhookUrl: 'https://example.com/webhook',
        })
      ).rejects.toThrow('Tenant not found');
    });
  });

  describe('getWebhookSettings', () => {
    it('should return webhook settings', async () => {
      const mockTenant = {
        id: 'tenant-1',
        settings: {
          webhookUrl: 'https://example.com/webhook',
          webhookSecret: 'secret-value',
          webhookEvents: ['order.created'],
        },
      };

      mockDb.query.tenants.findFirst.mockResolvedValue(mockTenant);

      const result = await integrationService.getWebhookSettings('tenant-1');

      expect(result.webhookUrl).toBe('https://example.com/webhook');
      expect(result.webhookEvents).toEqual(['order.created']);
      expect(result.hasWebhookSecret).toBe(true);
      expect(result).not.toHaveProperty('webhookSecret'); // Security: never expose secret
    });

    it('should return defaults when no webhook configured', async () => {
      const mockTenant = {
        id: 'tenant-1',
        settings: {},
      };

      mockDb.query.tenants.findFirst.mockResolvedValue(mockTenant);

      const result = await integrationService.getWebhookSettings('tenant-1');

      expect(result.webhookUrl).toBeNull();
      expect(result.webhookEvents).toEqual([]);
      expect(result.hasWebhookSecret).toBe(false);
    });

    it('should throw error when tenant not found', async () => {
      mockDb.query.tenants.findFirst.mockResolvedValue(null);

      await expect(integrationService.getWebhookSettings('nonexistent')).rejects.toThrow(
        'Tenant not found'
      );
    });
  });
});
