import { Router } from 'express';
import { and, eq, ilike, sql } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';

export const facilitiesRouter = Router();
const { facilities, storageLocations } = schema;

function escapeLike(str: string): string {
  return str.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ─── GET /facilities ─────────────────────────────────────────────────
facilitiesRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const search = req.query.search as string | undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));

    const conditions = [eq(facilities.tenantId, tenantId), eq(facilities.isActive, true)];
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

// ─── GET /facilities/:id/storage-locations ──────────────────────────
facilitiesRouter.get('/:id/storage-locations', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const facilityId = req.params.id as string;
    const search = req.query.search as string | undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));

    const conditions = [
      eq(storageLocations.tenantId, tenantId),
      eq(storageLocations.facilityId, facilityId),
      eq(storageLocations.isActive, true),
    ];

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
