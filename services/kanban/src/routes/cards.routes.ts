import { Router } from 'express';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';
import { transitionCard, getCardHistory } from '../services/card-lifecycle.service.js';
import { generateQRDataUrl, generateQRSvg, buildScanUrl } from '../utils/qr-generator.js';

export const cardsRouter = Router();
const { kanbanCards, kanbanLoops } = schema;

// ─── GET /cards — List cards with filters ────────────────────────────
cardsRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const loopId = req.query.loopId as string | undefined;
    const stage = req.query.stage as string | undefined;

    const conditions = [eq(kanbanCards.tenantId, tenantId), eq(kanbanCards.isActive, true)];
    if (loopId) conditions.push(eq(kanbanCards.loopId, loopId));
    if (stage) conditions.push(eq(kanbanCards.currentStage, stage as (typeof schema.cardStageEnum.enumValues)[number]));

    const whereClause = and(...conditions);
    const offset = (page - 1) * pageSize;

    const [data, countResult] = await Promise.all([
      db
        .select({
          id: kanbanCards.id,
          tenantId: kanbanCards.tenantId,
          loopId: kanbanCards.loopId,
          cardNumber: kanbanCards.cardNumber,
          currentStage: kanbanCards.currentStage,
          currentStageEnteredAt: kanbanCards.currentStageEnteredAt,
          linkedPurchaseOrderId: kanbanCards.linkedPurchaseOrderId,
          linkedWorkOrderId: kanbanCards.linkedWorkOrderId,
          linkedTransferOrderId: kanbanCards.linkedTransferOrderId,
          lastPrintedAt: kanbanCards.lastPrintedAt,
          printCount: kanbanCards.printCount,
          completedCycles: kanbanCards.completedCycles,
          isActive: kanbanCards.isActive,
          createdAt: kanbanCards.createdAt,
          updatedAt: kanbanCards.updatedAt,
          loopType: kanbanLoops.loopType,
          partId: kanbanLoops.partId,
          facilityId: kanbanLoops.facilityId,
          numberOfCards: kanbanLoops.numberOfCards,
          orderQuantity: kanbanLoops.orderQuantity,
          minQuantity: kanbanLoops.minQuantity,
          partName: schema.parts.name,
          partNumber: schema.parts.partNumber,
          facilityName: schema.facilities.name,
          supplierName: schema.suppliers.name,
        })
        .from(kanbanCards)
        .innerJoin(kanbanLoops, eq(kanbanCards.loopId, kanbanLoops.id))
        .leftJoin(
          schema.parts,
          and(eq(schema.parts.id, kanbanLoops.partId), eq(schema.parts.tenantId, tenantId))
        )
        .leftJoin(
          schema.facilities,
          and(eq(schema.facilities.id, kanbanLoops.facilityId), eq(schema.facilities.tenantId, tenantId))
        )
        .leftJoin(
          schema.suppliers,
          and(eq(schema.suppliers.id, kanbanLoops.primarySupplierId), eq(schema.suppliers.tenantId, tenantId))
        )
        .where(whereClause)
        .limit(pageSize)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(kanbanCards).where(whereClause),
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

// ─── GET /cards/:id — Card detail with loop info ─────────────────────
cardsRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const card = await db.query.kanbanCards.findFirst({
      where: and(eq(kanbanCards.id, req.params.id as string), eq(kanbanCards.tenantId, tenantId)),
      with: {
        loop: true,
        transitions: { orderBy: schema.cardStageTransitions.transitionedAt },
      },
    });

    if (!card) throw new AppError(404, 'Card not found');

    // Include QR code data
    const qrDataUrl = await generateQRDataUrl(card.id);
    const scanUrl = buildScanUrl(card.id);

    const [partRow, facilityRow, supplierRow] = await Promise.all([
      db.query.parts.findFirst({
        where: and(eq(schema.parts.id, card.loop.partId), eq(schema.parts.tenantId, tenantId)),
      }),
      db.query.facilities.findFirst({
        where: and(eq(schema.facilities.id, card.loop.facilityId), eq(schema.facilities.tenantId, tenantId)),
      }),
      card.loop.primarySupplierId
        ? db.query.suppliers.findFirst({
            where: and(
              eq(schema.suppliers.id, card.loop.primarySupplierId),
              eq(schema.suppliers.tenantId, tenantId),
            ),
          })
        : Promise.resolve(null),
    ]);

    res.json({
      ...card,
      loopType: card.loop.loopType,
      partId: card.loop.partId,
      partName: partRow?.name ?? null,
      partNumber: partRow?.partNumber ?? null,
      facilityId: card.loop.facilityId,
      facilityName: facilityRow?.name ?? null,
      supplierName: supplierRow?.name ?? null,
      numberOfCards: card.loop.numberOfCards,
      orderQuantity: card.loop.orderQuantity,
      minQuantity: card.loop.minQuantity,
      qrCode: qrDataUrl,
      scanUrl,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /cards/:id/print-detail — Enriched card payload for label rendering ─────
cardsRouter.get('/:id/print-detail', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const card = await db.query.kanbanCards.findFirst({
      where: and(eq(kanbanCards.id, req.params.id as string), eq(kanbanCards.tenantId, tenantId)),
      with: {
        loop: true,
      },
    });
    if (!card) throw new AppError(404, 'Card not found');

    const [partRow, facilityRow, storageLocationRow, supplierRow, sourceFacilityRow] = await Promise.all([
      db.query.parts.findFirst({
        where: and(eq(schema.parts.id, card.loop.partId), eq(schema.parts.tenantId, tenantId)),
      }),
      db.query.facilities.findFirst({
        where: and(eq(schema.facilities.id, card.loop.facilityId), eq(schema.facilities.tenantId, tenantId)),
      }),
      card.loop.storageLocationId
        ? db.query.storageLocations.findFirst({
            where: and(
              eq(schema.storageLocations.id, card.loop.storageLocationId),
              eq(schema.storageLocations.tenantId, tenantId)
            ),
          })
        : Promise.resolve(null),
      card.loop.primarySupplierId
        ? db.query.suppliers.findFirst({
            where: and(eq(schema.suppliers.id, card.loop.primarySupplierId), eq(schema.suppliers.tenantId, tenantId)),
          })
        : Promise.resolve(null),
      card.loop.sourceFacilityId
        ? db.query.facilities.findFirst({
            where: and(eq(schema.facilities.id, card.loop.sourceFacilityId), eq(schema.facilities.tenantId, tenantId)),
          })
        : Promise.resolve(null),
    ]);

    const qrCode = await generateQRDataUrl(card.id);
    const scanUrl = buildScanUrl(card.id);
    const safetyStockDaysRaw = card.loop.safetyStockDays;
    const safetyStockDays = safetyStockDaysRaw == null ? undefined : Number(safetyStockDaysRaw);

    res.json({
      id: card.id,
      cardNumber: card.cardNumber,
      stage: card.currentStage,
      currentStage: card.currentStage,
      loopType: card.loop.loopType,
      partName: partRow?.name ?? null,
      partNumber: partRow?.partNumber ?? null,
      imageUrl: partRow?.imageUrl ?? null,
      itemNotes: partRow?.itemNotes ?? null,
      facilityName: facilityRow?.name ?? null,
      supplierName: supplierRow?.name ?? null,
      minQuantity: card.loop.minQuantity,
      orderQuantity: card.loop.orderQuantity,
      qrCode,
      scanUrl,
      loop: {
        loopType: card.loop.loopType,
        numberOfCards: card.loop.numberOfCards,
        partNumber: partRow?.partNumber ?? null,
        partName: partRow?.name ?? null,
        partDescription: partRow?.description ?? null,
        facilityName: facilityRow?.name ?? null,
        storageLocationName: storageLocationRow?.name ?? null,
        primarySupplierName: supplierRow?.name ?? null,
        sourceFacilityName: sourceFacilityRow?.name ?? null,
        orderQuantity: card.loop.orderQuantity,
        minQuantity: card.loop.minQuantity,
        statedLeadTimeDays: card.loop.statedLeadTimeDays ?? undefined,
        safetyStockDays: Number.isFinite(safetyStockDays) ? safetyStockDays : undefined,
        notes: card.loop.notes ?? undefined,
        imageUrl: partRow?.imageUrl ?? undefined,
        itemNotes: partRow?.itemNotes ?? undefined,
      },
      part: partRow
        ? {
            partNumber: partRow.partNumber ?? undefined,
            name: partRow.name ?? undefined,
            type: partRow.type ?? undefined,
            uom: partRow.uom ?? undefined,
            orderMechanism: partRow.orderMechanism ?? undefined,
            location: partRow.location ?? undefined,
            minQty: partRow.minQty ?? undefined,
            minQtyUnit: partRow.minQtyUnit ?? undefined,
            orderQty: partRow.orderQty ?? undefined,
            orderQtyUnit: partRow.orderQtyUnit ?? undefined,
            primarySupplierName: partRow.primarySupplierName ?? undefined,
            primarySupplierLink: partRow.primarySupplierLink ?? undefined,
            itemNotes: partRow.itemNotes ?? undefined,
            unitPrice: partRow.unitPrice ?? undefined,
            glCode: partRow.glCode ?? undefined,
            itemSubtype: partRow.itemSubtype ?? undefined,
            updatedAt: partRow.updatedAt?.toISOString() ?? undefined,
            imageUrl: partRow.imageUrl ?? undefined,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /cards/:id/transition — Move card to next stage ────────────
cardsRouter.post('/:id/transition', async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({
      toStage: z.enum(['created', 'triggered', 'ordered', 'in_transit', 'received', 'restocked']),
      notes: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    }).parse(req.body);

    const result = await transitionCard({
      cardId: req.params.id as string,
      tenantId: req.user!.tenantId,
      toStage: input.toStage,
      userId: req.user!.sub,
      method: 'manual',
      notes: input.notes,
      metadata: input.metadata,
    });

    res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── GET /cards/:id/history — Full transition history ────────────────
cardsRouter.get('/:id/history', async (req: AuthRequest, res, next) => {
  try {
    const history = await getCardHistory(req.params.id as string, req.user!.tenantId);
    res.json(history);
  } catch (err) {
    next(err);
  }
});

// ─── GET /cards/:id/qr — Generate QR code for printing ──────────────
cardsRouter.get('/:id/qr', async (req: AuthRequest, res, next) => {
  try {
    const card = await db.query.kanbanCards.findFirst({
      where: and(eq(kanbanCards.id, req.params.id as string), eq(kanbanCards.tenantId, req.user!.tenantId)),
    });
    if (!card) throw new AppError(404, 'Card not found');

    const format = (req.query.format as string) || 'svg';
    const width = Number(req.query.width) || 300;

    if (format === 'svg') {
      const svg = await generateQRSvg(card.id, undefined, { width });
      res.type('image/svg+xml').send(svg);
    } else {
      const dataUrl = await generateQRDataUrl(card.id, undefined, { width });
      res.json({ qrCode: dataUrl, scanUrl: buildScanUrl(card.id) });
    }

    // Track print
    await db
      .update(kanbanCards)
      .set({
        lastPrintedAt: new Date(),
        printCount: sql`${kanbanCards.printCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(kanbanCards.id, card.id as string));
  } catch (err) {
    next(err);
  }
});

// ─── POST /cards/:id/link-order — Link a PO/WO/TO to this card ──────
cardsRouter.post('/:id/link-order', async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({
      purchaseOrderId: z.string().uuid().optional(),
      workOrderId: z.string().uuid().optional(),
      transferOrderId: z.string().uuid().optional(),
    }).parse(req.body);

    const [updated] = await db
      .update(kanbanCards)
      .set({
        linkedPurchaseOrderId: input.purchaseOrderId ?? undefined,
        linkedWorkOrderId: input.workOrderId ?? undefined,
        linkedTransferOrderId: input.transferOrderId ?? undefined,
        updatedAt: new Date(),
      })
      .where(
        and(eq(kanbanCards.id, req.params.id as string), eq(kanbanCards.tenantId, req.user!.tenantId))
      )
      .returning();

    if (!updated) throw new AppError(404, 'Card not found');
    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});
