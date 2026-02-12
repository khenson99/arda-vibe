import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import { authMiddleware, requireRole, type AuthRequest } from '@arda/auth-utils';

export const tenantRouter = Router();

// All tenant routes require authentication
tenantRouter.use(authMiddleware);

// ─── GET /tenants/current ─────────────────────────────────────────────
// Returns the current user's tenant details
tenantRouter.get('/current', async (req: AuthRequest, res, next) => {
  try {
    const tenant = await db.query.tenants.findFirst({
      where: eq(schema.tenants.id, req.user!.tenantId),
    });

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    const effectiveSettings: schema.TenantSettings = {
      ...(tenant.settings ?? {}),
      cardTemplateDesignerEnabled: true,
    };

    res.json({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      logoUrl: tenant.logoUrl,
      planId: tenant.planId,
      cardLimit: tenant.cardLimit,
      seatLimit: tenant.seatLimit,
      settings: effectiveSettings,
      createdAt: tenant.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /tenants/current ───────────────────────────────────────────
// Update tenant settings (tenant_admin only)
tenantRouter.patch(
  '/current',
  requireRole('tenant_admin'),
  async (req: AuthRequest, res, next) => {
    try {
      const updateSchema = z.object({
        name: z.string().min(1).max(255).optional(),
        logoUrl: z.string().url().nullable().optional(),
        settings: z
          .object({
            timezone: z.string().optional(),
            dateFormat: z.string().optional(),
            currency: z.string().optional(),
            defaultCardFormat: z.string().optional(),
            requireApprovalForPO: z.boolean().optional(),
            autoConsolidateOrders: z.boolean().optional(),
            reloWisaEnabled: z.boolean().optional(),
            cardTemplateDesignerEnabled: z.boolean().optional(),
          })
          .optional(),
      });

      const input = updateSchema.parse(req.body);

      const [updated] = await db
        .update(schema.tenants)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(schema.tenants.id, req.user!.tenantId))
        .returning();

      res.json({
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        logoUrl: updated.logoUrl,
        settings: updated.settings,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: err.errors,
        });
        return;
      }
      next(err);
    }
  }
);

// ─── GET /tenants/current/users ───────────────────────────────────────
// List all users in the current tenant
tenantRouter.get('/current/users', async (req: AuthRequest, res, next) => {
  try {
    const tenantUsers = await db.query.users.findMany({
      where: eq(schema.users.tenantId, req.user!.tenantId),
      columns: {
        passwordHash: false, // never expose
      },
    });

    res.json(tenantUsers);
  } catch (err) {
    next(err);
  }
});

// ─── POST /tenants/current/users ──────────────────────────────────────
// Invite/create a new user in the current tenant (tenant_admin only)
tenantRouter.post(
  '/current/users',
  requireRole('tenant_admin'),
  async (req: AuthRequest, res, next) => {
    try {
      const createUserSchema = z.object({
        email: z.string().email(),
        firstName: z.string().min(1).max(100),
        lastName: z.string().min(1).max(100),
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

      const input = createUserSchema.parse(req.body);

      // Check seat limit
      const tenant = await db.query.tenants.findFirst({
        where: eq(schema.tenants.id, req.user!.tenantId),
      });

      const existingUsers = await db.query.users.findMany({
        where: eq(schema.users.tenantId, req.user!.tenantId),
      });

      if (tenant && existingUsers.length >= tenant.seatLimit) {
        res.status(403).json({
          error: 'Seat limit reached. Upgrade your plan to add more users.',
          code: 'SEAT_LIMIT_REACHED',
        });
        return;
      }

      // Check if email exists in this tenant
      const existing = existingUsers.find((u) => u.email === input.email);
      if (existing) {
        res.status(409).json({ error: 'User with this email already exists in your organization' });
        return;
      }

      // Create user (no password — they'll set one via invite link or use OAuth)
      const [newUser] = await db
        .insert(schema.users)
        .values({
          tenantId: req.user!.tenantId,
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          role: input.role,
        })
        .returning();

      // TODO: Send invitation email

      res.status(201).json({
        id: newUser.id,
        email: newUser.email,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        role: newUser.role,
        isActive: newUser.isActive,
        createdAt: newUser.createdAt,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: err.errors,
        });
        return;
      }
      next(err);
    }
  }
);
