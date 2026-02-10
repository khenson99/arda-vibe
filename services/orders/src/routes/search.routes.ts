/**
 * Order Search Routes
 *
 * Provides a full-text search endpoint for orders, backed by the
 * @arda/search package. All queries are tenant-isolated.
 *
 * Routes:
 *   GET /search/orders?q=...&status=...&page=...&limit=...&dateFrom=...&dateTo=...
 */

import { Router } from 'express';
import type { AuthRequest } from '@arda/auth-utils';
import { createSearchClient } from '@arda/search';
import { config } from '@arda/config';
import { OrderSearchService } from '../services/search.service.js';

export const searchRouter = Router();

// ─── Service Instance ────────────────────────────────────────────────
const searchClient = createSearchClient(config.ELASTICSEARCH_URL);
const orderSearchService = new OrderSearchService(searchClient);

// ─── Helpers ─────────────────────────────────────────────────────────

/** Parse and clamp pagination params with sensible defaults. */
function parsePagination(query: Record<string, unknown>): { page: number; limit: number } {
  let page = Number(query.page) || 1;
  let limit = Number(query.limit) || 20;

  if (page < 1) page = 1;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;

  return { page, limit };
}

/** Validate an ISO 8601 date string (YYYY-MM-DD or full ISO). */
function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

// ─── GET /search/orders ──────────────────────────────────────────────
searchRouter.get('/orders', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);

    const filters: Record<string, string | undefined> = {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      priority: typeof req.query.priority === 'string' ? req.query.priority : undefined,
      supplierId: typeof req.query.supplierId === 'string' ? req.query.supplierId : undefined,
      customerId: typeof req.query.customerId === 'string' ? req.query.customerId : undefined,
      riskLevel: typeof req.query.riskLevel === 'string' ? req.query.riskLevel : undefined,
    };

    // Date range filters (validate before passing)
    if (isValidDateString(req.query.dateFrom)) {
      filters.dateFrom = req.query.dateFrom as string;
    }
    if (isValidDateString(req.query.dateTo)) {
      filters.dateTo = req.query.dateTo as string;
    }

    // Remove undefined keys
    const cleanFilters = Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const result = await orderSearchService.searchOrders(tenantId, q, cleanFilters, { page, limit });

    res.json(result);
  } catch (err) {
    next(err);
  }
});
