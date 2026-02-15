import { Router } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';
import {
  processReceipt,
  getReceipt,
  getReceiptsForOrder,
  getOpenExceptions,
  getAllExceptions,
  resolveException,
  getExpectedOrders,
  getReceivingHistory,
} from '../services/receiving.service.js';
import {
  processExceptionAutomation,
  processAllOpenExceptions,
} from '../services/exception-automation.service.js';
import { getReceivingMetrics } from '../services/receiving-metrics.service.js';

export const receivingRouter = Router();

// ─── Validation Schemas ─────────────────────────────────────────────

const ReceiptLineSchema = z.object({
  orderLineId: z.string().uuid(),
  partId: z.string().uuid(),
  quantityExpected: z.number().int().min(0),
  quantityAccepted: z.number().int().min(0),
  quantityDamaged: z.number().int().min(0),
  quantityRejected: z.number().int().min(0),
  notes: z.string().optional(),
});

const CreateReceiptSchema = z.object({
  orderId: z.string().uuid(),
  orderType: z.enum(['purchase_order', 'transfer_order', 'work_order']),
  lines: z.array(ReceiptLineSchema).min(1),
  notes: z.string().optional(),
});

const ResolveExceptionSchema = z.object({
  resolutionType: z.enum([
    'follow_up_po',
    'replacement_card',
    'return_to_supplier',
    'credit',
    'accept_as_is',
  ]),
  resolutionNotes: z.string().optional(),
});

const MetricsQuerySchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

// ─── POST / — Create Receipt ────────────────────────────────────────

receivingRouter.post('/', async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Missing tenant context');

    const parsed = CreateReceiptSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, `Validation error: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const result = await processReceipt({
      tenantId,
      ...parsed.data,
      receivedByUserId: authReq.user?.sub,
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ─── GET /metrics — Receiving Metrics ───────────────────────────────

receivingRouter.get('/metrics', async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Missing tenant context');

    const parsed = MetricsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, `Validation error: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const metrics = await getReceivingMetrics({
      tenantId,
      ...parsed.data,
    });

    res.json(metrics);
  } catch (err) {
    next(err);
  }
});

// ─── GET /exceptions — List Open Exceptions ─────────────────────────

receivingRouter.get('/exceptions', async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Missing tenant context');

    const includeResolved = req.query.includeResolved === 'true';
    const exceptions = includeResolved
      ? await getAllExceptions(tenantId)
      : await getOpenExceptions(tenantId);

    res.json(exceptions);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /exceptions/:id/resolve — Resolve Exception ──────────────

receivingRouter.patch('/exceptions/:id/resolve', async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Missing tenant context');

    const parsed = ResolveExceptionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, `Validation error: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const result = await resolveException({
      tenantId,
      exceptionId: req.params.id,
      resolvedByUserId: authReq.user?.sub,
      ...parsed.data,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── POST /exceptions/:id/automate — Trigger Automation ─────────────

receivingRouter.post('/exceptions/:id/automate', async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Missing tenant context');

    const result = await processExceptionAutomation(tenantId, req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── POST /exceptions/automate-all — Batch Automation ───────────────

receivingRouter.post('/exceptions/automate-all', async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Missing tenant context');

    const results = await processAllOpenExceptions(tenantId);
    res.json({ results, total: results.length, succeeded: results.filter((r) => r.success).length });
  } catch (err) {
    next(err);
  }
});

// ─── GET /expected — Expected Orders for Receiving ──────────────────

const ExpectedOrdersQuerySchema = z.object({
  facilityId: z.string().uuid().optional(),
  orderType: z.enum(['purchase_order', 'transfer_order', 'work_order']).optional(),
});

receivingRouter.get('/expected', async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Missing tenant context');

    const parsed = ExpectedOrdersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, `Validation error: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const result = await getExpectedOrders({ tenantId, ...parsed.data });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── GET /history — Receiving History with Pagination ────────────────

const HistoryQuerySchema = z.object({
  page: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)),
  pageSize: z.string().optional().transform((v) => (v ? parseInt(v, 10) : undefined)),
  orderType: z.string().optional(),
  status: z.string().optional(),
});

receivingRouter.get('/history', async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Missing tenant context');

    const parsed = HistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, `Validation error: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const result = await getReceivingHistory({ tenantId, ...parsed.data });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── GET /order/:orderId — List Receipts for an Order ────────────────

receivingRouter.get('/order/:orderId', async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Missing tenant context');

    const receipts = await getReceiptsForOrder(tenantId, req.params.orderId);
    res.json(receipts);
  } catch (err) {
    next(err);
  }
});

// ─── GET /:id — Get Receipt Detail ──────────────────────────────────

receivingRouter.get('/:id', async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) throw new AppError(401, 'Missing tenant context');

    const receipt = await getReceipt(tenantId, req.params.id);
    if (!receipt) throw new AppError(404, 'Receipt not found');

    res.json(receipt);
  } catch (err) {
    next(err);
  }
});
