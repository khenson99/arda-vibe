/**
 * Catalog Search Routes
 *
 * Provides full-text search endpoints for parts and suppliers,
 * backed by the @arda/search package. All queries are tenant-isolated.
 *
 * Routes:
 *   GET /search/parts?q=...&page=...&limit=...&category=...&supplier=...
 *   GET /search/suppliers?q=...&page=...&limit=...
 */

import { Router } from 'express';
import type { AuthRequest } from '@arda/auth-utils';
import { createSearchClient } from '@arda/search';
import { config } from '@arda/config';
import { SearchService } from '../services/search.service.js';

export const searchRouter = Router();

// ─── Service Instance ────────────────────────────────────────────────
const searchClient = createSearchClient(config.ELASTICSEARCH_URL);
const searchService = new SearchService(searchClient);

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

// ─── GET /search/parts ───────────────────────────────────────────────
searchRouter.get('/parts', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);

    const filters: Record<string, string | undefined> = {
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      supplierId: typeof req.query.supplier === 'string' ? req.query.supplier : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      manufacturer: typeof req.query.manufacturer === 'string' ? req.query.manufacturer : undefined,
    };

    // Remove undefined keys
    const cleanFilters = Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const result = await searchService.searchParts(tenantId, q, cleanFilters, { page, limit });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── GET /search/suppliers ───────────────────────────────────────────
searchRouter.get('/suppliers', async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);

    const filters: Record<string, string | undefined> = {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      category: typeof req.query.category === 'string' ? req.query.category : undefined,
      city: typeof req.query.city === 'string' ? req.query.city : undefined,
      country: typeof req.query.country === 'string' ? req.query.country : undefined,
    };

    const cleanFilters = Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const result = await searchService.searchSuppliers(tenantId, q, cleanFilters, { page, limit });

    res.json(result);
  } catch (err) {
    next(err);
  }
});
