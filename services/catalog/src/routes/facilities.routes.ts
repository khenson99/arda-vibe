import { Router } from 'express';
import { z } from 'zod';
import { and, eq, ilike, sql } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import type { AuthRequest, AuditContext } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

function getRequestAuditContext(req: AuthRequest): AuditContext {
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

export const facilitiesRouter = Router();
const { facilities, storageLocations } = schema;

function escapeLike(str: string): string {
  return str.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const createFacilitySchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(50),
  type: z.string().min(1).max(50).default('warehouse'),
  addressLine1: z.string().max(255).optional(),
  addressLine2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(100).default('US'),
  timezone: z.string().max(50).default('America/Chicago'),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const updateFacilitySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  code: z.string().min(1).max(50).optional(),
  type: z.string().min(1).max(50).optional(),
  addressLine1: z.string().max(255).nullable().optional(),
  addressLine2: z.string().max(255).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  postalCode: z.string().max(20).nullable().optional(),
  country: z.string().max(100).optional(),
  timezone: z.string().max(50).optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});

// ─── GET /facilities ─────────────────────────────────────────────────
facilitiesRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const search = req.query.search as string | undefined;
    const includeInactive = req.query.includeInactive === 'true';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));

    const conditions = [eq(facilities.tenantId, tenantId)];
    if (!includeInactive) {
      conditions.push(eq(facilities.isActive, true));
    }
    if (search) {
      const escaped = escapeLike(search);
      conditions.push(
        sql`(${ilike(facilities.name, `%${escaped}%`)} OR ${ilike(facilities.code, `%${escaped}%`)})`
      );
    }

    const whereClause = and(...conditions);
    const offset = (page - 1) * pageSize;

    const [data, countResult] = await Promise.all([
      db.select().from(facilities).where(whereClause).limit(pageSize).offset(offset).orderBy(facilities.name),
      db.select({ count: sql<number>`count(*)` }).from(facilities).where(whereClause),
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    res.json({
      data,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /facilities/:id ─────────────────────────────────────────────
facilitiesRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const facilityId = req.params.id as string;

    // Check if requesting storage-locations sub-resource
    // (this route won't match /:id/storage-locations due to route ordering)
    const row = await db.query.facilities.findFirst({
      where: and(eq(facilities.id, facilityId), eq(facilities.tenantId, tenantId)),
      with: { storageLocations: true },
    });
    if (!row) throw new AppError(404, 'Facility not found');
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// ─── POST /facilities ────────────────────────────────────────────────
facilitiesRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const input = createFacilitySchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(facilities)
        .values({ ...input, tenantId })
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'facility.created',
        entityType: 'facility',
        entityId: row.id,
        newState: { name: row.name, code: row.code, type: row.type, colorHex: row.colorHex },
        metadata: { source: 'facilities.create' },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.status(201).json(created);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── PATCH /facilities/:id ───────────────────────────────────────────
facilitiesRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const input = updateFacilitySchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.facilities.findFirst({
      where: and(eq(facilities.id, req.params.id as string), eq(facilities.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Facility not found');

    const changedFields = Object.keys(input) as (keyof typeof input)[];
    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};
    for (const key of changedFields) {
      previousState[key] = (existing as Record<string, unknown>)[key];
      newState[key] = input[key];
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(facilities)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(facilities.id, req.params.id as string), eq(facilities.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'facility.updated',
        entityType: 'facility',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'facilities.update', facilityName: row.name },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── DELETE /facilities/:id (soft delete) ────────────────────────────
facilitiesRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.facilities.findFirst({
      where: and(eq(facilities.id, req.params.id as string), eq(facilities.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Facility not found');
    if (!existing.isActive) throw new AppError(400, 'Facility is already deactivated');

    const deactivated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(facilities)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(facilities.id, req.params.id as string), eq(facilities.tenantId, tenantId)))
        .returning();

      // Also deactivate storage locations within this facility
      await tx
        .update(storageLocations)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(storageLocations.facilityId, row.id), eq(storageLocations.tenantId, tenantId)));

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'facility.deactivated',
        entityType: 'facility',
        entityId: row.id,
        previousState: { isActive: true },
        newState: { isActive: false },
        metadata: { source: 'facilities.deactivate', facilityName: row.name },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(deactivated);
  } catch (err) {
    next(err);
  }
});

// ─── GET /facilities/:id/storage-locations ──────────────────────────
facilitiesRouter.get('/:id/storage-locations', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const facilityId = req.params.id as string;
    const search = req.query.search as string | undefined;
    const includeInactive = req.query.includeInactive === 'true';
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));

    const conditions = [
      eq(storageLocations.tenantId, tenantId),
      eq(storageLocations.facilityId, facilityId),
    ];
    if (!includeInactive) {
      conditions.push(eq(storageLocations.isActive, true));
    }

    if (search) {
      const escaped = escapeLike(search);
      conditions.push(
        sql`(${ilike(storageLocations.name, `%${escaped}%`)} OR ${ilike(storageLocations.code, `%${escaped}%`)})`
      );
    }

    const whereClause = and(...conditions);
    const offset = (page - 1) * pageSize;

    const [data, countResult] = await Promise.all([
      db
        .select()
        .from(storageLocations)
        .where(whereClause)
        .limit(pageSize)
        .offset(offset)
        .orderBy(storageLocations.code),
      db.select({ count: sql<number>`count(*)` }).from(storageLocations).where(whereClause),
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    res.json({
      data,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /facilities/:id/storage-locations ─────────────────────────
const createStorageLocationSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(100),
  zone: z.string().max(100).optional(),
  description: z.string().optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

facilitiesRouter.post('/:id/storage-locations', async (req: AuthRequest, res, next) => {
  try {
    const input = createStorageLocationSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const facilityId = req.params.id as string;
    const auditContext = getRequestAuditContext(req);

    // Verify facility exists and belongs to tenant
    const facility = await db.query.facilities.findFirst({
      where: and(eq(facilities.id, facilityId), eq(facilities.tenantId, tenantId)),
    });
    if (!facility) throw new AppError(404, 'Facility not found');

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(storageLocations)
        .values({ ...input, facilityId, tenantId })
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'storage_location.created',
        entityType: 'storage_location',
        entityId: row.id,
        newState: { name: row.name, code: row.code, zone: row.zone, facilityId, colorHex: row.colorHex },
        metadata: { source: 'facilities.storage-locations.create', facilityName: facility.name },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.status(201).json(created);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── PATCH /facilities/:facilityId/storage-locations/:id ────────────
const updateStorageLocationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  code: z.string().min(1).max(100).optional(),
  zone: z.string().max(100).nullable().optional(),
  description: z.string().nullable().optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});

facilitiesRouter.patch('/:facilityId/storage-locations/:id', async (req: AuthRequest, res, next) => {
  try {
    const input = updateStorageLocationSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const slId = req.params.id as string;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.storageLocations.findFirst({
      where: and(eq(storageLocations.id, slId), eq(storageLocations.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Storage location not found');

    const changedFields = Object.keys(input) as (keyof typeof input)[];
    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};
    for (const key of changedFields) {
      previousState[key] = (existing as Record<string, unknown>)[key];
      newState[key] = input[key];
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(storageLocations)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(storageLocations.id, slId), eq(storageLocations.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'storage_location.updated',
        entityType: 'storage_location',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'facilities.storage-locations.update', locationName: row.name },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── DELETE /facilities/:facilityId/storage-locations/:id (soft delete)
facilitiesRouter.delete('/:facilityId/storage-locations/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const slId = req.params.id as string;
    const auditContext = getRequestAuditContext(req);

    const existing = await db.query.storageLocations.findFirst({
      where: and(eq(storageLocations.id, slId), eq(storageLocations.tenantId, tenantId)),
    });
    if (!existing) throw new AppError(404, 'Storage location not found');
    if (!existing.isActive) throw new AppError(400, 'Storage location is already deactivated');

    const deactivated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(storageLocations)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(storageLocations.id, slId), eq(storageLocations.tenantId, tenantId)))
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'storage_location.deactivated',
        entityType: 'storage_location',
        entityId: row.id,
        previousState: { isActive: true },
        newState: { isActive: false },
        metadata: { source: 'facilities.storage-locations.deactivate', locationName: row.name },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(deactivated);
  } catch (err) {
    next(err);
  }
});
