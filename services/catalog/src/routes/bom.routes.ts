import { Router } from 'express';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
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

export const bomRouter = Router();
const { bomItems, parts } = schema;

// ─── GET /bom/:parentPartId — Get BOM for a part ────────────────────
bomRouter.get('/:parentPartId', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;

    // Verify parent part exists
    const parentPart = await db.query.parts.findFirst({
      where: and(eq(parts.id, req.params.parentPartId as string), eq(parts.tenantId, tenantId)),
    });
    if (!parentPart) throw new AppError(404, 'Parent part not found');

    const items = await db.query.bomItems.findMany({
      where: and(
        eq(bomItems.parentPartId, req.params.parentPartId as string),
        eq(bomItems.tenantId, tenantId)
      ),
      with: { childPart: true },
      orderBy: bomItems.sortOrder,
    });

    res.json({
      parentPart: {
        id: parentPart.id,
        partNumber: parentPart.partNumber,
        name: parentPart.name,
      },
      items,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /bom/:parentPartId — Add a component to a BOM ─────────────
bomRouter.post('/:parentPartId', async (req: AuthRequest, res, next) => {
  try {
    const addSchema = z.object({
      childPartId: z.string().uuid(),
      quantityPer: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a positive number'),
      sortOrder: z.number().int().default(0),
      notes: z.string().optional(),
    });

    const input = addSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    // Prevent self-referencing
    if (input.childPartId === req.params.parentPartId) {
      throw new AppError(400, 'A part cannot be a component of itself');
    }

    // Verify both parts exist in this tenant
    const [parentPart, childPart] = await Promise.all([
      db.query.parts.findFirst({
        where: and(eq(parts.id, req.params.parentPartId as string), eq(parts.tenantId, tenantId)),
      }),
      db.query.parts.findFirst({
        where: and(eq(parts.id, input.childPartId), eq(parts.tenantId, tenantId)),
      }),
    ]);

    if (!parentPart) throw new AppError(404, 'Parent part not found');
    if (!childPart) throw new AppError(404, 'Child part not found');

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(bomItems)
        .values({
          tenantId,
          parentPartId: req.params.parentPartId as string,
          childPartId: input.childPartId,
          quantityPer: input.quantityPer,
          sortOrder: input.sortOrder,
          notes: input.notes,
        })
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'bom_line.added',
        entityType: 'bom_item',
        entityId: row.id,
        newState: {
          parentPartId: req.params.parentPartId as string,
          childPartId: input.childPartId,
          quantityPer: input.quantityPer,
          sortOrder: input.sortOrder,
        },
        metadata: {
          source: 'bom.add_line',
          parentPartNumber: parentPart.partNumber,
          parentPartName: parentPart.name,
          childPartNumber: childPart.partNumber,
          childPartName: childPart.name,
        },
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

// ─── DELETE /bom/:parentPartId/:bomItemId ────────────────────────────
bomRouter.delete('/:parentPartId/:bomItemId', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    const deleted = await db.transaction(async (tx) => {
      const rows = await tx
        .delete(bomItems)
        .where(
          and(
            eq(bomItems.id, req.params.bomItemId as string),
            eq(bomItems.parentPartId, req.params.parentPartId as string),
            eq(bomItems.tenantId, tenantId)
          )
        )
        .returning();

      if (!rows.length) throw new AppError(404, 'BOM item not found');

      const removedItem = rows[0];
      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'bom_line.removed',
        entityType: 'bom_item',
        entityId: removedItem.id,
        previousState: {
          parentPartId: removedItem.parentPartId,
          childPartId: removedItem.childPartId,
          quantityPer: removedItem.quantityPer,
          sortOrder: removedItem.sortOrder,
        },
        metadata: {
          source: 'bom.remove_line',
          parentPartId: req.params.parentPartId as string,
          childPartId: removedItem.childPartId,
        },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return rows;
    });

    res.json({ message: 'BOM item removed', id: req.params.bomItemId as string });
  } catch (err) {
    next(err);
  }
});
