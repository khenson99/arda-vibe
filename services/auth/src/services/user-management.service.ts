import { db, schema } from '@arda/db';
import { eq, and } from 'drizzle-orm';
import { config, createLogger } from '@arda/config';
import type { UserRole } from '@arda/shared-types';

const log = createLogger('auth:user-management');

// ─── Types ────────────────────────────────────────────────────────────

export interface InviteUserInput {
  tenantId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
}

export interface UpdateUserRoleInput {
  userId: string;
  tenantId: string;
  role: UserRole;
}

export interface DeactivateUserInput {
  userId: string;
  tenantId: string;
}

// ─── Invite User ──────────────────────────────────────────────────────

/**
 * Create a new user in the tenant (invite flow).
 * Checks seat limits and email uniqueness within the tenant.
 */
export async function inviteUser(input: InviteUserInput) {
  const { tenantId, email, firstName, lastName, role } = input;

  // Check seat limit
  const tenant = await db.query.tenants.findFirst({
    where: eq(schema.tenants.id, tenantId),
  });

  if (!tenant) {
    throw new Error('Tenant not found');
  }

  const existingUsers = await db.query.users.findMany({
    where: eq(schema.users.tenantId, tenantId),
  });

  if (existingUsers.length >= tenant.seatLimit) {
    const error = new Error('Seat limit reached. Upgrade your plan to add more users.') as Error & {
      code?: string;
    };
    error.code = 'SEAT_LIMIT_REACHED';
    throw error;
  }

  // Check if email exists in this tenant
  const existing = existingUsers.find((u) => u.email === email);
  if (existing) {
    throw new Error('User with this email already exists in your organization');
  }

  // Create user (no password — they'll set one via invite link or use OAuth)
  const [newUser] = await db
    .insert(schema.users)
    .values({
      tenantId,
      email,
      firstName,
      lastName,
      role,
    })
    .returning();

  log.info({ userId: newUser.id, email: newUser.email, role }, 'User invited');

  // TODO: Send invitation email

  return {
    id: newUser.id,
    email: newUser.email,
    firstName: newUser.firstName,
    lastName: newUser.lastName,
    role: newUser.role,
    isActive: newUser.isActive,
    createdAt: newUser.createdAt,
  };
}

// ─── Update User Role ─────────────────────────────────────────────────

/**
 * Update a user's role within their tenant.
 * Only tenant_admin can perform this action (enforced by middleware).
 */
export async function updateUserRole(input: UpdateUserRoleInput) {
  const { userId, tenantId, role } = input;

  // Verify user belongs to the tenant
  const user = await db.query.users.findFirst({
    where: and(eq(schema.users.id, userId), eq(schema.users.tenantId, tenantId)),
  });

  if (!user) {
    throw new Error('User not found in your organization');
  }

  // Update role
  const [updated] = await db
    .update(schema.users)
    .set({ role, updatedAt: new Date() })
    .where(eq(schema.users.id, userId))
    .returning();

  log.info({ userId, oldRole: user.role, newRole: role }, 'User role updated');

  return {
    id: updated.id,
    email: updated.email,
    firstName: updated.firstName,
    lastName: updated.lastName,
    role: updated.role,
    isActive: updated.isActive,
    updatedAt: updated.updatedAt,
  };
}

// ─── Deactivate User ──────────────────────────────────────────────────

/**
 * Deactivate a user account within the tenant.
 * This prevents login but preserves the user record.
 */
export async function deactivateUser(input: DeactivateUserInput) {
  const { userId, tenantId } = input;

  // Verify user belongs to the tenant
  const user = await db.query.users.findFirst({
    where: and(eq(schema.users.id, userId), eq(schema.users.tenantId, tenantId)),
  });

  if (!user) {
    throw new Error('User not found in your organization');
  }

  // Prevent deactivating the last tenant_admin
  if (user.role === 'tenant_admin') {
    const adminCount = await db.query.users.findMany({
      where: and(
        eq(schema.users.tenantId, tenantId),
        eq(schema.users.role, 'tenant_admin'),
        eq(schema.users.isActive, true)
      ),
    });

    if (adminCount.length <= 1) {
      throw new Error('Cannot deactivate the last tenant admin');
    }
  }

  // Deactivate user
  const [updated] = await db
    .update(schema.users)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(schema.users.id, userId))
    .returning();

  log.info({ userId, email: user.email }, 'User deactivated');

  // Revoke all refresh tokens for this user (force logout)
  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.refreshTokens.userId, userId));

  return {
    id: updated.id,
    email: updated.email,
    firstName: updated.firstName,
    lastName: updated.lastName,
    role: updated.role,
    isActive: updated.isActive,
    updatedAt: updated.updatedAt,
  };
}
