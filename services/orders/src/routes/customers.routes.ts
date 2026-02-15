import { Router } from 'express';
import { z } from 'zod';
import { eq, and, ilike, or, sql } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import { requireRole, type AuthRequest, type AuditContext } from '@arda/auth-utils';

import { AppError } from '../middleware/error-handler.js';

const { customers, customerContacts, customerAddresses } = schema;

function getRequestAuditContext(req: AuthRequest): AuditContext {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded)
    ? forwarded[0]
    : forwarded?.split(',')[0]?.trim();
  const rawIp = forwardedIp || req.socket.remoteAddress || undefined;
  const userAgentHeader = req.headers['user-agent'];
  const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
  return {
    userId: req.user?.sub,
    ipAddress: rawIp?.slice(0, 45),
    userAgent,
  };
}

/** Escape LIKE/ILIKE metacharacters so user input is treated literally. */
function escapeLike(str: string): string {
  return str.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ─── Validation Schemas ─────────────────────────────────────────────

const customerStatusValues = ['active', 'inactive', 'prospect', 'suspended'] as const;

const createCustomerSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().max(50).optional(),
  status: z.enum(customerStatusValues).default('active'),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().max(2048).optional(),
  paymentTerms: z.string().max(100).optional(),
  creditLimit: z.string().optional(),
  taxId: z.string().max(50).optional(),
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateCustomerSchema = createCustomerSchema.partial();

const listCustomersQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
  search: z.string().optional(),
  status: z.enum(customerStatusValues).optional(),
});

const createContactSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(100).optional(),
  isPrimary: z.boolean().default(false),
});

const updateContactSchema = createContactSchema.partial();

const createAddressSchema = z.object({
  label: z.string().max(100).default('main'),
  addressLine1: z.string().min(1).max(255),
  addressLine2: z.string().max(255).optional(),
  city: z.string().min(1).max(100),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(100).default('US'),
  isDefault: z.boolean().default(false),
});

const updateAddressSchema = createAddressSchema.partial();

// ─── RBAC Definitions ───────────────────────────────────────────────
// Readers: salesperson, ecommerce_director, tenant_admin (tenant_admin is always allowed by requireRole)
// Writers: salesperson, tenant_admin
const canRead = requireRole('salesperson', 'ecommerce_director');
const canWrite = requireRole('salesperson');

export const customersRouter = Router();

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Returns the tenant-scoped where clause, with optional salesperson scoping.
 * Salespersons see only customers they created; other roles see all tenant customers.
 */
function tenantScope(req: AuthRequest) {
  const tenantId = req.user!.tenantId;
  const conditions = [eq(customers.tenantId, tenantId)];
  if (req.user!.role === 'salesperson') {
    conditions.push(eq(customers.createdByUserId, req.user!.sub));
  }
  return conditions;
}

async function findCustomerOrThrow(customerId: string, req: AuthRequest) {
  const conditions = [
    eq(customers.id, customerId),
    ...tenantScope(req),
  ];
  const customer = await db.query.customers.findFirst({
    where: and(...conditions),
  });
  if (!customer) {
    throw new AppError(404, 'Customer not found');
  }
  return customer;
}

// ═════════════════════════════════════════════════════════════════════
//  Customer CRUD
// ═════════════════════════════════════════════════════════════════════

// ─── GET /customers ─────────────────────────────────────────────────
customersRouter.get('/', canRead, async (req: AuthRequest, res, next) => {
  try {
    const query = listCustomersQuerySchema.parse(req.query);
    const offset = (query.page - 1) * query.pageSize;

    const conditions = tenantScope(req);

    if (query.search) {
      const escaped = escapeLike(query.search);
      conditions.push(
        or(
          ilike(customers.name, `%${escaped}%`),
          ilike(customers.code, `%${escaped}%`),
          // Search by contact name or email via subquery
          sql`${customers.id} IN (
            SELECT ${customerContacts.customerId}
            FROM ${customerContacts}
            WHERE ${customerContacts.tenantId} = ${req.user!.tenantId}
              AND (
                ${ilike(customerContacts.firstName, `%${escaped}%`)}
                OR ${ilike(customerContacts.lastName, `%${escaped}%`)}
                OR ${ilike(customerContacts.email, `%${escaped}%`)}
              )
          )`
        )!
      );
    }

    if (query.status) {
      conditions.push(eq(customers.status, query.status));
    }

    const whereClause = and(...conditions);

    const [data, countResult] = await Promise.all([
      db.select()
        .from(customers)
        .where(whereClause)
        .limit(query.pageSize)
        .offset(offset)
        .orderBy(customers.name),
      db.select({ count: sql<number>`count(*)` })
        .from(customers)
        .where(whereClause),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    res.json({
      data,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid query parameters', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── GET /customers/:id ─────────────────────────────────────────────
customersRouter.get('/:id', canRead, async (req: AuthRequest, res, next) => {
  try {
    const conditions = [
      eq(customers.id, req.params.id as string),
      ...tenantScope(req),
    ];
    const customer = await db.query.customers.findFirst({
      where: and(...conditions),
      with: {
        contacts: true,
        addresses: true,
      },
    });

    if (!customer) {
      throw new AppError(404, 'Customer not found');
    }

    res.json(customer);
  } catch (err) {
    next(err);
  }
});

// ─── POST /customers ────────────────────────────────────────────────
customersRouter.post('/', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const input = createCustomerSchema.parse(req.body);
    const tenantId = req.user!.tenantId;
    const auditContext = getRequestAuditContext(req);

    // Check for duplicate code within tenant
    if (input.code) {
      const existing = await db.query.customers.findFirst({
        where: and(eq(customers.tenantId, tenantId), eq(customers.code, input.code)),
      });
      if (existing) {
        throw new AppError(409, `Customer code "${input.code}" already exists`);
      }
    }

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(customers)
        .values({
          ...input,
          tenantId,
          createdByUserId: req.user!.sub,
        })
        .returning();

      await writeAuditEntry(tx, {
        tenantId,
        userId: auditContext.userId,
        action: 'customer.created',
        entityType: 'customer',
        entityId: row.id,
        newState: {
          name: row.name,
          code: row.code,
          status: row.status,
          email: row.email,
        },
        metadata: { source: 'customers.create' },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.status(201).json(created);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── PATCH /customers/:id ───────────────────────────────────────────
customersRouter.patch('/:id', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const input = updateCustomerSchema.parse(req.body);
    const auditContext = getRequestAuditContext(req);
    const existing = await findCustomerOrThrow(req.params.id as string, req);

    // If changing code, check for duplicates
    if (input.code && input.code !== existing.code) {
      const duplicate = await db.query.customers.findFirst({
        where: and(eq(customers.tenantId, req.user!.tenantId), eq(customers.code, input.code)),
      });
      if (duplicate) {
        throw new AppError(409, `Customer code "${input.code}" already exists`);
      }
    }

    // Build field-level snapshots for changed fields only
    const changedFields = Object.keys(input) as (keyof typeof input)[];
    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};
    for (const key of changedFields) {
      previousState[key] = (existing as Record<string, unknown>)[key];
      newState[key] = input[key];
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(customers)
        .set({ ...input, updatedAt: new Date() })
        .where(and(
          eq(customers.id, req.params.id as string),
          eq(customers.tenantId, req.user!.tenantId),
        ))
        .returning();

      await writeAuditEntry(tx, {
        tenantId: req.user!.tenantId,
        userId: auditContext.userId,
        action: 'customer.updated',
        entityType: 'customer',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'customers.update', customerName: row.name },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════
//  Customer Contacts (nested under /customers/:customerId/contacts)
// ═════════════════════════════════════════════════════════════════════

// ─── POST /customers/:customerId/contacts ───────────────────────────
customersRouter.post('/:customerId/contacts', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const input = createContactSchema.parse(req.body);
    const auditContext = getRequestAuditContext(req);
    await findCustomerOrThrow(req.params.customerId as string, req);

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(customerContacts)
        .values({
          ...input,
          tenantId: req.user!.tenantId,
          customerId: req.params.customerId as string,
        })
        .returning();

      await writeAuditEntry(tx, {
        tenantId: req.user!.tenantId,
        userId: auditContext.userId,
        action: 'customer_contact.created',
        entityType: 'customer_contact',
        entityId: row.id,
        newState: {
          customerId: row.customerId,
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.email,
          isPrimary: row.isPrimary,
        },
        metadata: { source: 'customers.contacts.create' },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.status(201).json(created);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── PATCH /customers/:customerId/contacts/:contactId ───────────────
customersRouter.patch('/:customerId/contacts/:contactId', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const input = updateContactSchema.parse(req.body);
    const auditContext = getRequestAuditContext(req);
    await findCustomerOrThrow(req.params.customerId as string, req);

    const existing = await db.query.customerContacts.findFirst({
      where: and(
        eq(customerContacts.id, req.params.contactId as string),
        eq(customerContacts.customerId, req.params.customerId as string),
        eq(customerContacts.tenantId, req.user!.tenantId),
      ),
    });
    if (!existing) {
      throw new AppError(404, 'Contact not found');
    }

    const changedFields = Object.keys(input) as (keyof typeof input)[];
    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};
    for (const key of changedFields) {
      previousState[key] = (existing as Record<string, unknown>)[key];
      newState[key] = input[key];
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(customerContacts)
        .set({ ...input, updatedAt: new Date() })
        .where(and(
          eq(customerContacts.id, req.params.contactId as string),
          eq(customerContacts.tenantId, req.user!.tenantId),
        ))
        .returning();

      await writeAuditEntry(tx, {
        tenantId: req.user!.tenantId,
        userId: auditContext.userId,
        action: 'customer_contact.updated',
        entityType: 'customer_contact',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'customers.contacts.update', customerId: row.customerId },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════
//  Customer Addresses (nested under /customers/:customerId/addresses)
// ═════════════════════════════════════════════════════════════════════

// ─── POST /customers/:customerId/addresses ──────────────────────────
customersRouter.post('/:customerId/addresses', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const input = createAddressSchema.parse(req.body);
    const auditContext = getRequestAuditContext(req);
    await findCustomerOrThrow(req.params.customerId as string, req);

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(customerAddresses)
        .values({
          ...input,
          tenantId: req.user!.tenantId,
          customerId: req.params.customerId as string,
        })
        .returning();

      await writeAuditEntry(tx, {
        tenantId: req.user!.tenantId,
        userId: auditContext.userId,
        action: 'customer_address.created',
        entityType: 'customer_address',
        entityId: row.id,
        newState: {
          customerId: row.customerId,
          label: row.label,
          city: row.city,
          state: row.state,
          country: row.country,
          isDefault: row.isDefault,
        },
        metadata: { source: 'customers.addresses.create' },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.status(201).json(created);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});

// ─── PATCH /customers/:customerId/addresses/:addressId ──────────────
customersRouter.patch('/:customerId/addresses/:addressId', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const input = updateAddressSchema.parse(req.body);
    const auditContext = getRequestAuditContext(req);
    await findCustomerOrThrow(req.params.customerId as string, req);

    const existing = await db.query.customerAddresses.findFirst({
      where: and(
        eq(customerAddresses.id, req.params.addressId as string),
        eq(customerAddresses.customerId, req.params.customerId as string),
        eq(customerAddresses.tenantId, req.user!.tenantId),
      ),
    });
    if (!existing) {
      throw new AppError(404, 'Address not found');
    }

    const changedFields = Object.keys(input) as (keyof typeof input)[];
    const previousState: Record<string, unknown> = {};
    const newState: Record<string, unknown> = {};
    for (const key of changedFields) {
      previousState[key] = (existing as Record<string, unknown>)[key];
      newState[key] = input[key];
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(customerAddresses)
        .set({ ...input, updatedAt: new Date() })
        .where(and(
          eq(customerAddresses.id, req.params.addressId as string),
          eq(customerAddresses.tenantId, req.user!.tenantId),
        ))
        .returning();

      await writeAuditEntry(tx, {
        tenantId: req.user!.tenantId,
        userId: auditContext.userId,
        action: 'customer_address.updated',
        entityType: 'customer_address',
        entityId: row.id,
        previousState,
        newState,
        metadata: { source: 'customers.addresses.update', customerId: row.customerId },
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
      });

      return row;
    });

    res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors });
      return;
    }
    next(err);
  }
});
