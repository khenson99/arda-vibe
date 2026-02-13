import { Router, type Request } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole, type AuthRequest } from '@arda/auth-utils';
import * as userManagementService from '../services/user-management.service.js';
import type { AuthAuditContext } from '../services/auth-audit.js';

export const usersRouter = Router();

// All user management routes require authentication
usersRouter.use(authMiddleware);

function extractAuditContext(req: Request): AuthAuditContext {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0]?.trim();
  const rawIp = forwardedIp || req.socket.remoteAddress || undefined;
  const userAgentHeader = req.headers['user-agent'];
  const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
  const authReq = req as AuthRequest;
  return {
    userId: authReq.user?.sub,
    ipAddress: rawIp?.slice(0, 45),
    userAgent,
  };
}

// ─── Validation Schemas ───────────────────────────────────────────────

const inviteUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  firstName: z.string().min(1, 'First name is required').max(100),
  lastName: z.string().min(1, 'Last name is required').max(100),
  role: z.enum([
    'tenant_admin',
    'inventory_manager',
    'procurement_manager',
    'receiving_manager',
    'ecommerce_director',
    'salesperson',
    'executive',
  ]),
});

const updateRoleSchema = z.object({
  role: z.enum([
    'tenant_admin',
    'inventory_manager',
    'procurement_manager',
    'receiving_manager',
    'ecommerce_director',
    'salesperson',
    'executive',
  ]),
});

// ─── POST /users/invite ───────────────────────────────────────────────
// Invite a new user to the tenant (tenant_admin only)
usersRouter.post('/invite', requireRole('tenant_admin'), async (req: AuthRequest, res, next) => {
  try {
    const input = inviteUserSchema.parse(req.body);
    const auditCtx = extractAuditContext(req);
    const result = await userManagementService.inviteUser({
      tenantId: req.user!.tenantId,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      role: input.role,
      performedBy: req.user!.sub,
    }, auditCtx);

    res.status(201).json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    // Handle known error codes
    if (err instanceof Error) {
      const errWithCode = err as Error & { code?: string };
      if (errWithCode.code === 'SEAT_LIMIT_REACHED') {
        res.status(403).json({ error: err.message, code: errWithCode.code });
        return;
      }
      if (err.message.includes('already exists')) {
        res.status(409).json({ error: err.message });
        return;
      }
    }
    next(err);
  }
});

// ─── PUT /users/:id/role ──────────────────────────────────────────────
// Update a user's role (tenant_admin only)
usersRouter.put('/:id/role', requireRole('tenant_admin'), async (req: AuthRequest, res, next) => {
  try {
    const rawUserId = req.params.id;
    const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    const input = updateRoleSchema.parse(req.body);
    const auditCtx = extractAuditContext(req);
    const result = await userManagementService.updateUserRole({
      userId,
      tenantId: req.user!.tenantId,
      role: input.role,
      performedBy: req.user!.sub,
    }, auditCtx);

    res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ─── PUT /users/:id/deactivate ────────────────────────────────────────
// Deactivate a user account (tenant_admin only)
usersRouter.put('/:id/deactivate', requireRole('tenant_admin'), async (req: AuthRequest, res, next) => {
  try {
    const rawUserId = req.params.id;
    const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    const auditCtx = extractAuditContext(req);
    const result = await userManagementService.deactivateUser({
      userId,
      tenantId: req.user!.tenantId,
      performedBy: req.user!.sub,
    }, auditCtx);

    res.json(result);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('not found')) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err.message.includes('last tenant admin')) {
        res.status(403).json({ error: err.message, code: 'LAST_ADMIN_PROTECTION' });
        return;
      }
    }
    next(err);
  }
});
