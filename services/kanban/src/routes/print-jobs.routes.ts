// ─── Print Jobs Routes ───────────────────────────────────────────────
// CRUD + status transitions for batch print job tracking.

import { Router } from 'express';
import { z } from 'zod';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { db, schema } from '@arda/db';
import type { AuthRequest } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

export const printJobsRouter = Router();
const { printJobs, printJobItems, kanbanCards } = schema;

// ─── Validation Schemas ──────────────────────────────────────────────

const createPrintJobSchema = z.object({
  format: z.enum([
    'order_card_3x5_portrait',
    '3x5_card', '4x6_card', 'business_card',
    'business_label', '1x3_label', 'bin_label', '1x1_label',
  ]),
  printerClass: z.enum(['standard', 'thermal']),
  cardIds: z.array(z.string().uuid()).min(1).max(200),
  settings: z.object({
    scale: z.number().min(0.5).max(1.5).optional(),
    margins: z.object({
      top: z.number().min(0).max(25),
      right: z.number().min(0).max(25),
      bottom: z.number().min(0).max(25),
      left: z.number().min(0).max(25),
    }).optional(),
    colorMode: z.enum(['color', 'monochrome']).optional(),
    orientation: z.enum(['portrait', 'landscape']).optional(),
  }).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['printing', 'completed', 'failed', 'cancelled']),
});

// ─── POST /print-jobs — Create a new print job ──────────────────────
printJobsRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const input = createPrintJobSchema.parse(req.body);

    // Validate all card IDs exist and belong to the tenant
    const cards = await db
      .select({ id: kanbanCards.id, printCount: kanbanCards.printCount })
      .from(kanbanCards)
      .where(and(
        inArray(kanbanCards.id, input.cardIds),
        eq(kanbanCards.tenantId, tenantId),
      ));

    if (cards.length !== input.cardIds.length) {
      const foundIds = new Set(cards.map((c) => c.id));
      const missing = input.cardIds.filter((id) => !foundIds.has(id));
      throw new AppError(400, `Cards not found: ${missing.join(', ')}`, 'CARDS_NOT_FOUND');
    }

    // Create print job + items in a transaction
    const result = await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(printJobs)
        .values({
          tenantId,
          format: input.format,
          printerClass: input.printerClass,
          cardCount: input.cardIds.length,
          isReprint: cards.some((c) => c.printCount > 0),
          settings: input.settings ?? {},
          requestedByUserId: userId,
        })
        .returning();

      // Build items with previousPrintCount snapshot
      const cardPrintCountMap = new Map(cards.map((c) => [c.id, c.printCount]));
      const itemValues = input.cardIds.map((cardId) => ({
        tenantId,
        printJobId: job.id,
        cardId,
        previousPrintCount: cardPrintCountMap.get(cardId) ?? 0,
      }));

      await tx.insert(printJobItems).values(itemValues);

      // Update printCount on each card
      for (const cardId of input.cardIds) {
        await tx
          .update(kanbanCards)
          .set({
            printCount: sql`${kanbanCards.printCount} + 1`,
            lastPrintedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(kanbanCards.id, cardId));
      }

      return job;
    });

    res.status(201).json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── GET /print-jobs — List print jobs ───────────────────────────────
printJobsRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const status = req.query.status as string | undefined;

    const conditions = [eq(printJobs.tenantId, tenantId)];
    if (status) {
      conditions.push(eq(printJobs.status, status as (typeof schema.printJobStatusEnum.enumValues)[number]));
    }

    const whereClause = and(...conditions);
    const offset = (page - 1) * pageSize;

    const [data, countResult] = await Promise.all([
      db.select().from(printJobs).where(whereClause).limit(pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(printJobs).where(whereClause),
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

// ─── GET /print-jobs/:id — Print job detail ─────────────────────────
printJobsRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const printJobId = req.params.id as string;

    const job = await db.query.printJobs.findFirst({
      where: and(eq(printJobs.id, printJobId), eq(printJobs.tenantId, tenantId)),
      with: { items: true },
    });

    if (!job) throw new AppError(404, 'Print job not found');

    res.json(job);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /print-jobs/:id/status — Update print job status ─────────
printJobsRouter.patch('/:id/status', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const printJobId = req.params.id as string;
    const input = updateStatusSchema.parse(req.body);

    const now = new Date();
    const updateData: Record<string, unknown> = {
      status: input.status,
      updatedAt: now,
    };

    if (input.status === 'printing') updateData.startedAt = now;
    if (input.status === 'completed') updateData.completedAt = now;
    if (input.status === 'failed') updateData.failedAt = now;

    const [updated] = await db
      .update(printJobs)
      .set(updateData)
      .where(and(eq(printJobs.id, printJobId), eq(printJobs.tenantId, tenantId)))
      .returning();

    if (!updated) throw new AppError(404, 'Print job not found');

    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── POST /print-jobs/:id/reprint — Reprint from existing job ───────
printJobsRouter.post('/:id/reprint', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const printJobId = req.params.id as string;

    // Fetch the original job with items
    const originalJob = await db.query.printJobs.findFirst({
      where: and(eq(printJobs.id, printJobId), eq(printJobs.tenantId, tenantId)),
      with: { items: true },
    });

    if (!originalJob) throw new AppError(404, 'Print job not found');

    const cardIds = originalJob.items.map((item) => item.cardId);

    // Get current print counts
    const cards = await db
      .select({ id: kanbanCards.id, printCount: kanbanCards.printCount })
      .from(kanbanCards)
      .where(inArray(kanbanCards.id, cardIds));

    // Create the reprint job
    const result = await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(printJobs)
        .values({
          tenantId,
          format: originalJob.format,
          printerClass: originalJob.printerClass,
          cardCount: cardIds.length,
          isReprint: true,
          settings: originalJob.settings ?? {},
          requestedByUserId: userId,
        })
        .returning();

      const cardPrintCountMap = new Map(cards.map((c) => [c.id, c.printCount]));
      const itemValues = cardIds.map((cardId) => ({
        tenantId,
        printJobId: job.id,
        cardId,
        previousPrintCount: cardPrintCountMap.get(cardId) ?? 0,
      }));

      await tx.insert(printJobItems).values(itemValues);

      // Increment print counts
      for (const cardId of cardIds) {
        await tx
          .update(kanbanCards)
          .set({
            printCount: sql`${kanbanCards.printCount} + 1`,
            lastPrintedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(kanbanCards.id, cardId));
      }

      return job;
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
