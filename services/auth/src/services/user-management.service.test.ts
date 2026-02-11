import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted Mocks ────────────────────────────────────────────────────

const mockDb = vi.hoisted(() => {
  const mockInsertReturning = vi.fn().mockResolvedValue([
    {
      id: 'user-123',
      email: 'newuser@example.com',
      firstName: 'New',
      lastName: 'User',
      role: 'inventory_manager',
      isActive: true,
      createdAt: new Date('2024-01-01'),
    },
  ]);
  const mockInsertValues = vi.fn().mockReturnValue({ returning: mockInsertReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  const mockUpdateReturning = vi.fn().mockResolvedValue([
    {
      id: 'user-456',
      email: 'existing@example.com',
      firstName: 'Existing',
      lastName: 'User',
      role: 'procurement_manager',
      isActive: false,
      updatedAt: new Date('2024-01-02'),
    },
  ]);
  const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

  return {
    insert: mockInsert,
    update: mockUpdate,
    query: {
      tenants: {
        findFirst: vi.fn(),
      },
      users: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
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
  tenants: { id: 'id' },
  users: {
    id: 'id',
    tenantId: 'tenantId',
    email: 'email',
    role: 'role',
    isActive: 'isActive',
  },
  refreshTokens: {
    userId: 'userId',
  },
}));

vi.mock('@arda/db', () => ({
  db: mockDb,
  schema: mockSchema,
}));

vi.mock('@arda/config', () => ({
  config: {},
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ─── Tests ────────────────────────────────────────────────────────────

import * as userManagementService from './user-management.service.js';

describe('user-management.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('inviteUser', () => {
    it('should create a new user when seat limit is not reached', async () => {
      // Mock tenant with available seats
      mockDb.query.tenants.findFirst.mockResolvedValue({
        id: 'tenant-123',
        seatLimit: 10,
      });

      // Mock existing users (less than seat limit)
      mockDb.query.users.findMany.mockResolvedValue([
        { id: 'user-1', email: 'existing@example.com' },
      ]);

      const result = await userManagementService.inviteUser({
        tenantId: 'tenant-123',
        email: 'newuser@example.com',
        firstName: 'New',
        lastName: 'User',
        role: 'inventory_manager',
      });

      expect(result).toEqual({
        id: 'user-123',
        email: 'newuser@example.com',
        firstName: 'New',
        lastName: 'User',
        role: 'inventory_manager',
        isActive: true,
        createdAt: expect.any(Date),
      });

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb._mocks.insertValues).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
        email: 'newuser@example.com',
        firstName: 'New',
        lastName: 'User',
        role: 'inventory_manager',
      });
    });

    it('should throw an error when seat limit is reached', async () => {
      mockDb.query.tenants.findFirst.mockResolvedValue({
        id: 'tenant-123',
        seatLimit: 3,
      });

      mockDb.query.users.findMany.mockResolvedValue([
        { id: 'user-1', email: 'user1@example.com' },
        { id: 'user-2', email: 'user2@example.com' },
        { id: 'user-3', email: 'user3@example.com' },
      ]);

      await expect(
        userManagementService.inviteUser({
          tenantId: 'tenant-123',
          email: 'newuser@example.com',
          firstName: 'New',
          lastName: 'User',
          role: 'inventory_manager',
        })
      ).rejects.toThrow('Seat limit reached');
    });

    it('should throw an error when email already exists in tenant', async () => {
      mockDb.query.tenants.findFirst.mockResolvedValue({
        id: 'tenant-123',
        seatLimit: 10,
      });

      mockDb.query.users.findMany.mockResolvedValue([
        { id: 'user-1', email: 'existing@example.com' },
      ]);

      await expect(
        userManagementService.inviteUser({
          tenantId: 'tenant-123',
          email: 'existing@example.com',
          firstName: 'New',
          lastName: 'User',
          role: 'inventory_manager',
        })
      ).rejects.toThrow('User with this email already exists');
    });

    it('should throw an error when tenant not found', async () => {
      mockDb.query.tenants.findFirst.mockResolvedValue(null);

      await expect(
        userManagementService.inviteUser({
          tenantId: 'nonexistent',
          email: 'newuser@example.com',
          firstName: 'New',
          lastName: 'User',
          role: 'inventory_manager',
        })
      ).rejects.toThrow('Tenant not found');
    });
  });

  describe('updateUserRole', () => {
    it('should update a user role successfully', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-456',
        email: 'existing@example.com',
        role: 'inventory_manager',
        tenantId: 'tenant-123',
      });

      const result = await userManagementService.updateUserRole({
        userId: 'user-456',
        tenantId: 'tenant-123',
        role: 'procurement_manager',
      });

      expect(result).toEqual({
        id: 'user-456',
        email: 'existing@example.com',
        firstName: 'Existing',
        lastName: 'User',
        role: 'procurement_manager',
        isActive: false,
        updatedAt: expect.any(Date),
      });

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb._mocks.updateSet).toHaveBeenCalledWith({
        role: 'procurement_manager',
        updatedAt: expect.any(Date),
      });
    });

    it('should throw an error when user not found in tenant', async () => {
      mockDb.query.users.findFirst.mockResolvedValue(null);

      await expect(
        userManagementService.updateUserRole({
          userId: 'nonexistent',
          tenantId: 'tenant-123',
          role: 'procurement_manager',
        })
      ).rejects.toThrow('User not found in your organization');
    });
  });

  describe('deactivateUser', () => {
    beforeEach(() => {
      // Reset mocks to prevent cross-test contamination
      mockDb.query.users.findFirst.mockReset();
      mockDb.query.users.findMany.mockReset();
    });

    it('should deactivate a user successfully', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-456',
        email: 'existing@example.com',
        role: 'inventory_manager',
        tenantId: 'tenant-123',
        isActive: true,
      });

      const result = await userManagementService.deactivateUser({
        userId: 'user-456',
        tenantId: 'tenant-123',
      });

      expect(result).toEqual({
        id: 'user-456',
        email: 'existing@example.com',
        firstName: 'Existing',
        lastName: 'User',
        role: 'procurement_manager',
        isActive: false,
        updatedAt: expect.any(Date),
      });

      expect(mockDb.update).toHaveBeenCalledTimes(2); // User update + refresh token revocation
      expect(mockDb._mocks.updateSet).toHaveBeenCalledWith({
        isActive: false,
        updatedAt: expect.any(Date),
      });
    });

    it('should throw an error when user not found in tenant', async () => {
      mockDb.query.users.findFirst.mockResolvedValue(null);

      await expect(
        userManagementService.deactivateUser({
          userId: 'nonexistent',
          tenantId: 'tenant-123',
        })
      ).rejects.toThrow('User not found in your organization');
    });

    it('should throw an error when trying to deactivate the last tenant admin', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-456',
        email: 'admin@example.com',
        role: 'tenant_admin',
        tenantId: 'tenant-123',
        isActive: true,
      });

      mockDb.query.users.findMany.mockResolvedValue([
        {
          id: 'user-456',
          email: 'admin@example.com',
          role: 'tenant_admin',
          isActive: true,
        },
      ]);

      await expect(
        userManagementService.deactivateUser({
          userId: 'user-456',
          tenantId: 'tenant-123',
        })
      ).rejects.toThrow('Cannot deactivate the last tenant admin');
    });
  });
});
