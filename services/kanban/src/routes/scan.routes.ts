import { Router } from 'express';
import { z } from 'zod';
import { triggerCardByScan, replayScans } from '../services/card-lifecycle.service.js';
import { config } from '@arda/config';
import { authMiddleware, type AuthRequest } from '@arda/auth-utils';

export const scanRouter = Router();

// ─── GET /scan/:cardId — QR Code Deep-Link Entry Point ───────────────
// This is the PUBLIC endpoint that QR codes point to.
// When scanned, it either:
//   1. Redirects to the PWA with the card context (if user has app installed)
//   2. Serves a mobile-friendly page that triggers the card and shows status
//
// In the PWA flow, the frontend will call the trigger API separately.
// This endpoint handles the direct-scan flow for non-PWA users.
scanRouter.get('/:cardId', async (req, res, next) => {
  try {
    const { cardId } = req.params;

    // For now, redirect to the frontend PWA with the card ID
    // The frontend will handle authentication and trigger logic
    const redirectUrl = `${config.APP_URL}/scan/${cardId}`;

    // If the request accepts JSON (API call from PWA), return data
    if (req.accepts('json') && !req.accepts('html')) {
      res.json({
        cardId,
        action: 'trigger',
        redirectUrl,
        message: 'Authenticate and POST to /api/kanban/cards/:id/transition to trigger this card',
      });
      return;
    }

    // Otherwise, redirect to the frontend
    res.redirect(302, redirectUrl);
  } catch (err) {
    next(err);
  }
});

// ─── POST /scan/:cardId/trigger — Direct trigger (for PWA offline sync) ──
// The PWA can call this endpoint when it comes back online to trigger
// queued card scans. Requires authentication.
scanRouter.post('/:cardId/trigger', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const cardId = req.params.cardId as string;
    const { location, idempotencyKey, scannedAt } = req.body || {};

    const result = await triggerCardByScan({
      cardId,
      scannedByUserId: req.user!.sub,
      tenantId: req.user!.tenantId,
      location,
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
      scannedAt: typeof scannedAt === 'string' ? scannedAt : undefined,
    });

    res.json({
      success: true,
      card: result.card,
      loopType: result.loopType,
      partId: result.partId,
      message: result.message,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Zod Schemas for Replay Validation ───────────────────────────────
const replayItemSchema = z.object({
  cardId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  scannedAt: z.string().min(1),
  location: z.object({
    lat: z.number().optional(),
    lng: z.number().optional(),
  }).optional(),
});

const replayBodySchema = z.object({
  scans: z.array(replayItemSchema).min(1).max(50),
});

// ─── POST /scan/replay — Batch replay of offline-queued scans ────────
// The PWA queues scans while offline and replays them when back online.
// This endpoint processes up to 50 scans sequentially, isolating failures.
scanRouter.post('/replay', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const parsed = replayBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid request body',
        details: parsed.error.flatten(),
      });
      return;
    }

    const { scans } = parsed.data;
    const results = await replayScans(scans, req.user!.tenantId, req.user!.sub);

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;

    res.json({
      total: results.length,
      succeeded,
      failed,
      results,
    });
  } catch (err) {
    next(err);
  }
});
