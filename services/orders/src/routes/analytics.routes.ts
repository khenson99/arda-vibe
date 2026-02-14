import { Router } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '@arda/auth-utils';
import { createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';
import { computeAllKpis } from '../services/analytics/kpi-engine.js';

const log = createLogger('orders:analytics');

export const analyticsRouter = Router();

// ─── Validation Schemas ────────────────────────────────────────────────

const kpiQuerySchema = z.object({
  startDate: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), { message: 'Invalid startDate' }),
  endDate: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), { message: 'Invalid endDate' }),
  facilityIds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(
      z
        .array(z.string().uuid({ message: 'Each facilityId must be a valid UUID' }))
        .optional(),
    ),
});

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Compute the previous-period date range by shifting back by the same duration.
 * e.g., if range is 30 days, previous period is the 30 days before startDate.
 *
 * All KPI queries use half-open intervals [start, end), so setting
 * previousEnd = startDate guarantees no overlap with the current period.
 */
function computePreviousPeriod(startDate: Date, endDate: Date) {
  const durationMs = endDate.getTime() - startDate.getTime();
  return {
    startDate: new Date(startDate.getTime() - durationMs),
    endDate: new Date(startDate.getTime()),
  };
}

// ─── GET /analytics/kpis ───────────────────────────────────────────────

analyticsRouter.get('/kpis', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const parsed = kpiQuerySchema.safeParse(req.query);

    if (!parsed.success) {
      return next(new AppError(400, parsed.error.errors.map((e) => e.message).join('; ')));
    }

    const { startDate: startStr, endDate: endStr, facilityIds } = parsed.data;
    const startDate = new Date(startStr);
    const endDate = new Date(endStr);

    // Validate date range
    if (endDate <= startDate) {
      return next(new AppError(400, 'endDate must be after startDate'));
    }

    const previousDateRange = computePreviousPeriod(startDate, endDate);

    log.info(
      { tenantId, startDate: startStr, endDate: endStr, facilityCount: facilityIds?.length ?? 0 },
      'Computing KPIs',
    );

    const kpis = await computeAllKpis({
      tenantId,
      dateRange: { startDate, endDate },
      previousDateRange,
      facilityIds,
    });

    res.json({ data: kpis });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return next(new AppError(400, 'Invalid query parameters'));
    }
    next(error);
  }
});
