import { Router } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '@arda/auth-utils';
import { serviceUrls } from '@arda/config';
import { db, schema } from '@arda/db';
import { and, asc, eq, sql } from 'drizzle-orm';

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
  metadata: z
    .object({
      provisionDefaults: z.coerce.boolean().optional(),
    })
    .optional(),
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
  description?: string | null;
  specifications?: Record<string, string> | null;
  imageUrl?: string | null;
  updatedAt?: string;
  createdAt?: string;
};

const ITEM_NOTES_SPEC_KEY = '__ardaItemNotesHtml';

function requireTenantId(req: AuthRequest): string {
  const tenantId = req.user?.tenantId?.trim();
  if (!tenantId) {
    const error = new Error('Unauthorized') as HttpLikeError;
    error.status = 401;
    throw error;
  }
  return tenantId;
}

function normalizeOptionalString(input?: string | null): string | null {
  const normalized = input?.trim();
  return normalized ? normalized : null;
}

function sanitizeSpecifications(input?: Record<string, string> | null): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      next[key] = value;
    }
  }
  return next;
}

function mergeNotesIntoSpecifications(
  existing: Record<string, string> | null | undefined,
  notes: string | null | undefined
): Record<string, string> {
  const next = sanitizeSpecifications(existing);
  const normalizedNotes = normalizeOptionalString(notes);
  if (normalizedNotes) {
    next[ITEM_NOTES_SPEC_KEY] = normalizedNotes;
  } else {
    delete next[ITEM_NOTES_SPEC_KEY];
  }
  return next;
}

function resolveItemNotes(part: CatalogPart): string | null {
  const specs = sanitizeSpecifications(part.specifications);
  return normalizeOptionalString(specs[ITEM_NOTES_SPEC_KEY]) ?? normalizeOptionalString(part.description);
}

function toPositiveInt(input?: number | null, fallback = 1): number {
  if (!Number.isFinite(input)) return fallback;
  return Math.max(1, Math.trunc(input as number));
}

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
  description?: string | null;
  specifications?: Record<string, string>;
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
      description: input.description || undefined,
      specifications: input.specifications ?? undefined,
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
  description?: string | null;
  specifications?: Record<string, string>;
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
      description: input.description || undefined,
      specifications: input.specifications ?? undefined,
    }),
  });

  if (!response.ok) {
    const error = new Error(`Catalog update failed (${response.status})`) as HttpLikeError;
    error.status = response.status;
    throw error;
  }

  return (await response.json()) as CatalogPart;
}

async function getOrCreateDefaultFacilityId(tenantId: string): Promise<string> {
  const existing = await db.query.facilities.findFirst({
    where: and(eq(schema.facilities.tenantId, tenantId), eq(schema.facilities.isActive, true)),
    orderBy: asc(schema.facilities.createdAt),
  });
  if (existing) return existing.id;

  try {
    const [created] = await db
      .insert(schema.facilities)
      .values({
        tenantId,
        name: 'Default Facility',
        code: 'DEFAULT',
        type: 'warehouse',
      })
      .returning({ id: schema.facilities.id });
    if (created) return created.id;
  } catch {
    // Another request may have created the default facility concurrently.
  }

  const fallback = await db.query.facilities.findFirst({
    where: and(
      eq(schema.facilities.tenantId, tenantId),
      eq(schema.facilities.code, 'DEFAULT')
    ),
  });
  if (fallback) return fallback.id;

  const error = new Error('Unable to provision a default facility for this tenant') as HttpLikeError;
  error.status = 500;
  throw error;
}

async function getOrCreateDefaultSupplierId(
  tenantId: string,
  preferredName?: string | null
): Promise<string> {
  const normalizedPreferredName = normalizeOptionalString(preferredName);
  if (normalizedPreferredName) {
    const exactNameMatch = await db.query.suppliers.findFirst({
      where: and(
        eq(schema.suppliers.tenantId, tenantId),
        eq(schema.suppliers.isActive, true),
        sql`lower(${schema.suppliers.name}) = lower(${normalizedPreferredName})`
      ),
      orderBy: asc(schema.suppliers.createdAt),
    });
    if (exactNameMatch) return exactNameMatch.id;
  }

  const existing = await db.query.suppliers.findFirst({
    where: and(eq(schema.suppliers.tenantId, tenantId), eq(schema.suppliers.isActive, true)),
    orderBy: asc(schema.suppliers.createdAt),
  });
  if (existing) return existing.id;

  try {
    const [created] = await db
      .insert(schema.suppliers)
      .values({
        tenantId,
        name: normalizedPreferredName ?? 'Default Supplier',
        code: 'DEFAULT',
      })
      .returning({ id: schema.suppliers.id });
    if (created) return created.id;
  } catch {
    // Another request may have created the default supplier concurrently.
  }

  const fallback = await db.query.suppliers.findFirst({
    where: and(
      eq(schema.suppliers.tenantId, tenantId),
      eq(schema.suppliers.code, 'DEFAULT')
    ),
  });
  if (fallback) return fallback.id;

  const error = new Error('Unable to provision a default supplier for this tenant') as HttpLikeError;
  error.status = 500;
  throw error;
}

function isUniqueViolationError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

function isServiceUnavailableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

async function createDefaultLoopWithCardLocally(input: {
  tenantId: string;
  partId: string;
  facilityId: string;
  primarySupplierId: string;
  minQuantity: number;
  orderQuantity: number;
  changedByUserId?: string | null;
}): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      const [loop] = await tx
        .insert(schema.kanbanLoops)
        .values({
          tenantId: input.tenantId,
          partId: input.partId,
          facilityId: input.facilityId,
          loopType: 'procurement',
          cardMode: 'single',
          numberOfCards: 1,
          minQuantity: input.minQuantity,
          orderQuantity: input.orderQuantity,
          primarySupplierId: input.primarySupplierId,
          notes: 'Auto-created from item upsert (gateway fallback)',
        })
        .returning({ id: schema.kanbanLoops.id });

      if (!loop) {
        throw new Error('Loop creation fallback did not return a loop id');
      }

      await tx.insert(schema.kanbanCards).values({
        tenantId: input.tenantId,
        loopId: loop.id,
        cardNumber: 1,
        currentStage: 'created',
        currentStageEnteredAt: new Date(),
      });

      await tx.insert(schema.kanbanParameterHistory).values({
        tenantId: input.tenantId,
        loopId: loop.id,
        changeType: 'manual',
        newMinQuantity: input.minQuantity,
        newOrderQuantity: input.orderQuantity,
        newNumberOfCards: 1,
        reason: 'Initial loop creation (gateway fallback)',
        changedByUserId: input.changedByUserId ?? null,
      });
    });

    return true;
  } catch (error) {
    if (isUniqueViolationError(error)) {
      return false;
    }
    throw error;
  }
}

async function parseErrorMessageFromResponse(response: Response): Promise<string> {
  const bodyText = await response.text();
  let message = bodyText?.trim() || `Loop create failed (${response.status})`;
  if (bodyText?.trim()) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        message = parsed.error.trim();
      } else if (typeof parsed.message === 'string' && parsed.message.trim()) {
        message = parsed.message.trim();
      }
    } catch {
      // Preserve raw text when upstream does not return JSON.
    }
  }
  return message;
}

async function ensureDefaultLoopWithCard(input: {
  token: string;
  tenantId: string;
  partId: string;
  minQty?: number | null;
  orderQty?: number | null;
  preferredSupplierName?: string | null;
  changedByUserId?: string | null;
}): Promise<boolean> {
  const existingLoop = await db.query.kanbanLoops.findFirst({
    where: and(
      eq(schema.kanbanLoops.tenantId, input.tenantId),
      eq(schema.kanbanLoops.partId, input.partId),
      eq(schema.kanbanLoops.isActive, true)
    ),
  });
  if (existingLoop) return false;

  const [facilityId, primarySupplierId] = await Promise.all([
    getOrCreateDefaultFacilityId(input.tenantId),
    getOrCreateDefaultSupplierId(input.tenantId, input.preferredSupplierName),
  ]);

  const minQuantity = toPositiveInt(input.minQty, 1);
  const orderQuantity = toPositiveInt(input.orderQty, minQuantity);

  let response: Response;
  try {
    response = await fetch(`${serviceUrls.kanban}/loops`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        partId: input.partId,
        facilityId,
        loopType: 'procurement',
        cardMode: 'single',
        numberOfCards: 1,
        minQuantity,
        orderQuantity,
        primarySupplierId,
        notes: 'Auto-created from item upsert',
      }),
    });
  } catch {
    return createDefaultLoopWithCardLocally({
      tenantId: input.tenantId,
      partId: input.partId,
      facilityId,
      primarySupplierId,
      minQuantity,
      orderQuantity,
      changedByUserId: input.changedByUserId,
    });
  }

  if (response.ok) return true;
  if (response.status === 409) return false;
  if (isServiceUnavailableStatus(response.status)) {
    return createDefaultLoopWithCardLocally({
      tenantId: input.tenantId,
      partId: input.partId,
      facilityId,
      primarySupplierId,
      minQuantity,
      orderQuantity,
      changedByUserId: input.changedByUserId,
    });
  }

  const message = await parseErrorMessageFromResponse(response);
  const error = new Error(message) as HttpLikeError;
  error.status = response.status;
  throw error;
}

itemsCompatRouter.put('/item/:entityId', async (req: AuthRequest, res, next) => {
  try {
    const token = normalizeToken(req);
    const tenantId = requireTenantId(req);
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
    const hasNotesPatch = Object.prototype.hasOwnProperty.call(input.payload, 'notes');
    const specifications = hasNotesPatch
      ? mergeNotesIntoSpecifications(existing?.specifications, input.payload.notes)
      : sanitizeSpecifications(existing?.specifications);

    const isNewPart = !existing;

    const part = existing
      ? await updateCatalogPart({
          token,
          id: existing.id,
          name: input.payload.name,
          type,
          uom,
          imageUrl: input.payload.imageUrl,
          description: existing.description ?? null,
          specifications,
        })
      : await createCatalogPart({
          token,
          partNumber,
          name: input.payload.name,
          type,
          uom,
          imageUrl: input.payload.imageUrl,
          description: null,
          specifications,
        });

    let cardEnsured = false;
    // Auto-bootstrap loops/cards when creating a new part, or when explicitly requested
    // by UI flows that need to provision a first card for an existing item.
    const shouldProvisionDefaults =
      isNewPart || input.metadata?.provisionDefaults === true;
    if (shouldProvisionDefaults) {
      try {
        cardEnsured = await ensureDefaultLoopWithCard({
          token,
          tenantId,
          partId: part.id,
          minQty: input.payload.minQty,
          orderQty: input.payload.orderQty,
          preferredSupplierName: input.payload.primarySupplier,
          changedByUserId: req.user?.sub ?? null,
        });
      } catch (loopError) {
        // Item creation should still succeed even when loop bootstrap is unavailable.
        console.warn('Failed to auto-provision default loop/card during item upsert', {
          entityId,
          partId: part.id,
          error: loopError instanceof Error ? loopError.message : String(loopError),
        });
      }
    }

    res.json({
      accepted: true,
      entityId,
      partId: part.id,
      cardEnsured,
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
          imageUrl: part.imageUrl ?? null,
          notes: resolveItemNotes(part),
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
