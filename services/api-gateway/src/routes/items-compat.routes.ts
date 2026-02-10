import { Router } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '@arda/auth-utils';
import { serviceUrls } from '@arda/config';

interface HttpLikeError extends Error {
  status?: number;
}

export const itemsCompatRouter = Router();

const upsertItemSchema = z.object({
  payload: z.object({
    externalGuid: z.string().trim().min(1),
    name: z.string().trim().min(1),
    orderMechanism: z.string().trim().optional().nullable(),
    location: z.string().trim().optional().nullable(),
    minQty: z.coerce.number().optional().nullable(),
    minQtyUnit: z.string().trim().optional().nullable(),
    orderQty: z.coerce.number().optional().nullable(),
    orderQtyUnit: z.string().trim().optional().nullable(),
    primarySupplier: z.string().trim().optional().nullable(),
    primarySupplierLink: z.string().trim().optional().nullable(),
    imageUrl: z.string().trim().optional().nullable(),
    notes: z.string().trim().optional().nullable(),
    glCode: z.string().trim().optional().nullable(),
    itemSubtype: z.string().trim().optional().nullable(),
  }),
});

const querySchema = z.object({
  paginate: z
    .object({
      index: z.coerce.number().int().min(0).default(0),
      size: z.coerce.number().int().min(1).max(500).default(100),
    })
    .optional(),
});

type CatalogPart = {
  id: string;
  partNumber: string;
  name: string;
  type: string;
  uom: string;
  isActive: boolean;
  updatedAt?: string;
  createdAt?: string;
};

function normalizeToken(req: AuthRequest): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    const error = new Error('Unauthorized') as HttpLikeError;
    error.status = 401;
    throw error;
  }
  return header.slice('Bearer '.length).trim();
}

function toCatalogType(orderMechanism?: string | null): string {
  const mechanism = (orderMechanism || '').trim().toLowerCase();
  if (mechanism === 'recurring') return 'component';
  return 'other';
}

function toCatalogUom(minQtyUnit?: string | null, orderQtyUnit?: string | null): string {
  const candidate = (orderQtyUnit || minQtyUnit || 'each').toLowerCase().trim();
  const allowed = new Set([
    'each',
    'box',
    'case',
    'pallet',
    'kg',
    'lb',
    'meter',
    'foot',
    'liter',
    'gallon',
    'roll',
    'sheet',
    'pair',
    'set',
    'other',
  ]);
  return allowed.has(candidate) ? candidate : 'each';
}

function toEpochSeconds(input?: string): number {
  if (!input) return Math.floor(Date.now() / 1000);
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.floor(Date.now() / 1000);
  return Math.floor(parsed / 1000);
}

async function fetchCatalogParts(input: {
  token: string;
  page: number;
  pageSize: number;
  search?: string;
}): Promise<{ data: CatalogPart[]; pagination?: { totalPages?: number } }> {
  const params = new URLSearchParams({
    page: String(input.page),
    pageSize: String(input.pageSize),
    isActive: 'true',
  });
  if (input.search) {
    params.set('search', input.search);
  }

  const response = await fetch(`${serviceUrls.catalog}/parts?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${input.token}`,
    },
  });

  if (!response.ok) {
    const error = new Error(`Catalog request failed (${response.status})`) as HttpLikeError;
    error.status = response.status;
    throw error;
  }

  return (await response.json()) as { data: CatalogPart[]; pagination?: { totalPages?: number } };
}

async function createCatalogPart(input: {
  token: string;
  partNumber: string;
  name: string;
  type: string;
  uom: string;
  imageUrl?: string | null;
}): Promise<CatalogPart> {
  const response = await fetch(`${serviceUrls.catalog}/parts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      partNumber: input.partNumber,
      name: input.name,
      type: input.type,
      uom: input.uom,
      imageUrl: input.imageUrl || undefined,
      isSellable: false,
    }),
  });

  if (!response.ok) {
    const error = new Error(`Catalog create failed (${response.status})`) as HttpLikeError;
    error.status = response.status;
    throw error;
  }

  return (await response.json()) as CatalogPart;
}

async function updateCatalogPart(input: {
  token: string;
  id: string;
  name: string;
  type: string;
  uom: string;
  imageUrl?: string | null;
}): Promise<CatalogPart> {
  const response = await fetch(`${serviceUrls.catalog}/parts/${encodeURIComponent(input.id)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${input.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: input.name,
      type: input.type,
      uom: input.uom,
      imageUrl: input.imageUrl || undefined,
    }),
  });

  if (!response.ok) {
    const error = new Error(`Catalog update failed (${response.status})`) as HttpLikeError;
    error.status = response.status;
    throw error;
  }

  return (await response.json()) as CatalogPart;
}

itemsCompatRouter.put('/item/:entityId', async (req: AuthRequest, res, next) => {
  try {
    const token = normalizeToken(req);
    const input = upsertItemSchema.parse(req.body ?? {});
    const entityIdRaw = req.params.entityId;
    const entityId = (Array.isArray(entityIdRaw) ? entityIdRaw[0] : entityIdRaw || '').trim();
    const partNumber = input.payload.externalGuid.trim() || entityId;

    const existingPage = await fetchCatalogParts({
      token,
      page: 1,
      pageSize: 25,
      search: partNumber,
    });
    const existing = (existingPage.data || []).find(
      (part) => part.partNumber.trim().toLowerCase() === partNumber.toLowerCase(),
    );

    const type = toCatalogType(input.payload.orderMechanism);
    const uom = toCatalogUom(input.payload.minQtyUnit, input.payload.orderQtyUnit);

    const part = existing
      ? await updateCatalogPart({
          token,
          id: existing.id,
          name: input.payload.name,
          type,
          uom,
          imageUrl: input.payload.imageUrl,
        })
      : await createCatalogPart({
          token,
          partNumber,
          name: input.payload.name,
          type,
          uom,
          imageUrl: input.payload.imageUrl,
        });

    res.json({
      accepted: true,
      entityId,
      partId: part.id,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    const status = (error as HttpLikeError)?.status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (error as Error).message });
      return;
    }
    next(error);
  }
});

itemsCompatRouter.post('/item/query', async (req: AuthRequest, res, next) => {
  try {
    const token = normalizeToken(req);
    const input = querySchema.parse(req.body ?? {});
    const index = input.paginate?.index ?? 0;
    const size = input.paginate?.size ?? 100;
    const pageStart = Math.floor(index / 100) + 1;
    const pageSize = Math.min(100, size);

    const records: CatalogPart[] = [];
    let page = pageStart;
    while (records.length < size) {
      const payload = await fetchCatalogParts({
        token,
        page,
        pageSize,
      });
      const rows = payload.data || [];
      if (rows.length === 0) break;
      records.push(...rows);
      const totalPages = payload.pagination?.totalPages ?? page;
      if (page >= totalPages) break;
      page += 1;
    }

    const sliced = records.slice(0, size);
    const results = sliced.map((part) => {
      const recorded = toEpochSeconds(part.updatedAt || part.createdAt);
      return {
        rId: part.id,
        asOf: {
          effective: recorded,
          recorded,
        },
        payload: {
          eId: part.id,
          externalGuid: part.partNumber,
          name: part.name,
          orderMechanism: 'unspecified',
          location: null,
          minQty: 0,
          minQtyUnit: part.uom || 'each',
          orderQty: null,
          orderQtyUnit: part.uom || 'each',
          primarySupplier: null,
          primarySupplierLink: null,
          imageUrl: null,
          notes: null,
          glCode: null,
          itemSubtype: null,
        },
        metadata: {
          tenantId: req.user?.tenantId || null,
        },
        retired: !part.isActive,
      };
    });

    res.json({
      thisPage: '/item/query/1',
      nextPage: '/item/query/1',
      previousPage: null,
      totalCount: results.length,
      results,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    const status = (error as HttpLikeError)?.status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (error as Error).message });
      return;
    }
    next(error);
  }
});
