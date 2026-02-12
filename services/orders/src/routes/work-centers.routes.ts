import { Router } from 'express';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

export const workCentersRouter = Router();
const { workCenters } = schema;

interface RequestAuditContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

function getRequestAuditContext(req: AuthRequest): RequestAuditContext {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0]?.trim();

  const rawIp = forwardedIp || req.socket.remoteAddress || undefined;
  const userAgentHeader = req.headers['user-agent'];
  const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;

  return {
    userId: req.user?.sub,
    ipAddress: rawIp?.slice(0, 45),
    userAgent,
  };
}

async function writeWorkCenterAudit(
  tx: any,
  input: {
    tenantId: string;
    action: 'work_center.created' | 'work_center.updated' | 'work_center.deactivated';
    centerId: string;
    previousState: Record<string, unknown> | null;
    newState: Record<string, unknown> | null;
    metadata: Record<string, unknown>;
    context: RequestAuditContext;
  }
) {
  await writeAuditEntry(tx, {
    tenantId: input.tenantId,
    userId: input.context.userId,
    action: input.action,
    entityType: 'work_center',
    entityId: input.centerId,
    previousState: input.previousState,
    newState: input.newState,
    metadata: input.metadata,
    ipAddress: input.context.ipAddress,
    userAgent: input.context.userAgent,
  });
}

// Validation schemas
const createWorkCenterSchema = z.object({
  facilityId: z.string().uuid(),
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50),
  description: z.string().max(1000).optional(),
  capacityPerHour: z.number().positive(),
  costPerHour: z.number().nonnegative(),
});

const updateWorkCenterSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  code: z.string().min(1).max(50).optional(),
  description: z.string().max(1000).optional(),
  capacityPerHour: z.number().positive().optional(),
  costPerHour: z.number().nonnegative().optional(),
  isActive: z.boolean().optional(),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  facilityId: z.string().uuid().optional(),
});

// GET / - List work centers with pagination and filters
workCentersRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { page, limit, facilityId } = paginationSchema.parse(req.query);
    const tenantId = req.user!.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const offset = (page - 1) * limit;
    const conditions = [eq(workCenters.tenantId, tenantId)];

    if (facilityId) {
      conditions.push(eq(workCenters.facilityId, facilityId));
    }

    const centers = await db
      .select()
      .from(workCenters)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset)
      .orderBy(sql`${workCenters.createdAt} DESC`);

    const [{ count }] = await db
      .select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
      .from(workCenters)
      .where(and(...conditions));

    res.json({
      data: centers,
      pagination: {
        page,
        limit,
        total: count,
        pages: Math.ceil(count / limit),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});

// GET /:id - Get work center detail
workCentersRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const tenantId = req.user!.tenantId;

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const [center] = await db
      .select()
      .from(workCenters)
      .where(and(eq(workCenters.id, id), eq(workCenters.tenantId, tenantId)));

    if (!center) {
      throw new AppError(404, 'Work center not found');
    }

    res.json(center);
  } catch (error) {
    next(error);
  }
});

// POST / - Create work center
workCentersRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const payload = createWorkCenterSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    // Check code uniqueness per tenant
    const [existingCenter] = await db
      .select()
      .from(workCenters)
      .where(
        and(
          eq(workCenters.tenantId, tenantId),
          eq(workCenters.code, payload.code)
        )
      );

    if (existingCenter) {
      throw new AppError(409, 'Work center code must be unique per tenant');
    }

    const [createdCenter] = await db.transaction(async (tx) => {
      const [createdCenter] = await tx
        .insert(workCenters)
        .values({
          tenantId,
          facilityId: payload.facilityId,
          name: payload.name,
          code: payload.code,
          description: payload.description || null,
          capacityPerHour: payload.capacityPerHour.toString(),
          costPerHour: payload.costPerHour.toString(),
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      await writeWorkCenterAudit(tx, {
        tenantId,
        action: 'work_center.created',
        centerId: createdCenter.id,
        previousState: null,
        newState: {
          name: createdCenter.name,
          code: createdCenter.code,
          isActive: createdCenter.isActive,
          facilityId: createdCenter.facilityId,
        },
        metadata: {
          source: 'work_centers.create',
        },
        context: auditContext,
      });

      return [createdCenter];
    });

    res.status(201).json(createdCenter);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

// PATCH /:id - Update work center
workCentersRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const payload = updateWorkCenterSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const [center] = await db
      .select()
      .from(workCenters)
      .where(and(eq(workCenters.id, id), eq(workCenters.tenantId, tenantId)));

    if (!center) {
      throw new AppError(404, 'Work center not found');
    }

    // If code is being updated, check uniqueness
    if (payload.code && payload.code !== center.code) {
      const [existingCenter] = await db
        .select()
        .from(workCenters)
        .where(
          and(
            eq(workCenters.tenantId, tenantId),
            eq(workCenters.code, payload.code)
          )
        );

      if (existingCenter) {
        throw new AppError(409, 'Work center code must be unique per tenant');
      }
    }

    const updateData: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (payload.name !== undefined) {
      updateData.name = payload.name;
    }
    if (payload.code !== undefined) {
      updateData.code = payload.code;
    }
    if (payload.description !== undefined) {
      updateData.description = payload.description || null;
    }
    if (payload.capacityPerHour !== undefined) {
      updateData.capacityPerHour = payload.capacityPerHour.toString();
    }
    if (payload.costPerHour !== undefined) {
      updateData.costPerHour = payload.costPerHour.toString();
    }
    if (payload.isActive !== undefined) {
      updateData.isActive = payload.isActive;
    }

    const [updatedCenter] = await db.transaction(async (tx) => {
      const [updatedCenter] = await tx
        .update(workCenters)
        .set(updateData)
        .where(and(eq(workCenters.id, id), eq(workCenters.tenantId, tenantId)))
        .returning();

      await writeWorkCenterAudit(tx, {
        tenantId,
        action: 'work_center.updated',
        centerId: id,
        previousState: {
          name: center.name,
          code: center.code,
          description: center.description,
          capacityPerHour: center.capacityPerHour,
          costPerHour: center.costPerHour,
          isActive: center.isActive,
        },
        newState: {
          name: updatedCenter.name,
          code: updatedCenter.code,
          description: updatedCenter.description,
          capacityPerHour: updatedCenter.capacityPerHour,
          costPerHour: updatedCenter.costPerHour,
          isActive: updatedCenter.isActive,
        },
        metadata: {
          source: 'work_centers.update',
        },
        context: auditContext,
      });

      return [updatedCenter];
    });

    res.json(updatedCenter);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid request body'));
    }
    next(error);
  }
});

// DELETE /:id - Soft delete work center
workCentersRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = req.params.id as string;
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    if (!tenantId) {
      throw new AppError(401, 'Unauthorized');
    }

    const [center] = await db
      .select()
      .from(workCenters)
      .where(and(eq(workCenters.id, id), eq(workCenters.tenantId, tenantId)));

    if (!center) {
      throw new AppError(404, 'Work center not found');
    }

    const [deletedCenter] = await db.transaction(async (tx) => {
      const [deletedCenter] = await tx
        .update(workCenters)
        .set({
          isActive: false,
          updatedAt: new Date(),
        })
        .where(and(eq(workCenters.id, id), eq(workCenters.tenantId, tenantId)))
        .returning();

      await writeWorkCenterAudit(tx, {
        tenantId,
        action: 'work_center.deactivated',
        centerId: id,
        previousState: {
          isActive: center.isActive,
          name: center.name,
          code: center.code,
        },
        newState: {
          isActive: deletedCenter.isActive,
          name: deletedCenter.name,
          code: deletedCenter.code,
        },
        metadata: {
          source: 'work_centers.delete',
        },
        context: auditContext,
      });

      return [deletedCenter];
    });

    res.json(deletedCenter);
  } catch (error) {
    next(error);
  }
});
