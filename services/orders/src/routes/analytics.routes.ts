import { Router } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '@arda/auth-utils';
import { createLogger } from '@arda/config';
import { AppError } from '../middleware/error-handler.js';
import {
  computeAllKpis,
  computeKpiTrend,
  KpiNotFoundError,
  VALID_KPI_IDS,
} from '../services/analytics/kpi-engine.js';

const log = createLogger('orders:analytics');

export const analyticsRouter = Router();

// ─── Validation Schemas ────────────────────────────────────────────────

const WINDOW_DAYS = [30, 60, 90] as const;
type WindowDays = (typeof WINDOW_DAYS)[number];

const kpiTrendQuerySchema = z.object({
  window: z
    .enum(['30', '60', '90'])
    .optional()
    .transform((v) => (v ? (Number(v) as WindowDays) : undefined)),
  startDate: z
    .string()
    .optional()
    .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid startDate' }),
  endDate: z
    .string()
    .optional()
    .refine((v) => !v || !isNaN(Date.parse(v)), { message: 'Invalid endDate' }),
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

// ─── GET /analytics/kpis/:kpiName/trend ─────────────────────────────

analyticsRouter.get('/kpis/:kpiName/trend', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const kpiName = req.params.kpiName as string;

    // Validate KPI name
    if (!VALID_KPI_IDS.includes(kpiName)) {
      return next(
        new AppError(
          400,
          `Unknown KPI: '${kpiName}'. Valid KPIs: ${VALID_KPI_IDS.join(', ')}`,
        ),
      );
    }

    const parsed = kpiTrendQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return next(new AppError(400, parsed.error.errors.map((e) => e.message).join('; ')));
    }

    const { window: windowDays, startDate: startStr, endDate: endStr, facilityIds } = parsed.data;

    // Determine date range: either window-based or custom range
    let startDate: Date;
    let endDate: Date;

    if (startStr && endStr) {
      startDate = new Date(startStr);
      endDate = new Date(endStr);
      if (endDate <= startDate) {
        return next(new AppError(400, 'endDate must be after startDate'));
      }
    } else if (windowDays) {
      endDate = new Date();
      startDate = new Date(endDate.getTime() - windowDays * 86_400_000);
    } else {
      // Default to 30-day window
      endDate = new Date();
      startDate = new Date(endDate.getTime() - 30 * 86_400_000);
    }

    // Choose bucket strategy: daily for <=60 days, weekly for longer
    const periodDays = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
    const bucket: 'daily' | 'weekly' = periodDays <= 60 ? 'daily' : 'weekly';

    log.info(
      {
        tenantId,
        kpiName,
        periodDays,
        bucket,
        facilityCount: facilityIds?.length ?? 0,
      },
      'Computing KPI trend',
    );

    const trend = await computeKpiTrend({
      tenantId,
      kpiId: kpiName,
      startDate,
      endDate,
      bucket,
      facilityIds,
    });

    res.json({ data: trend });
  } catch (error) {
    if (error instanceof KpiNotFoundError) {
      return next(new AppError(400, error.message));
    }
    next(error);
  }
});
