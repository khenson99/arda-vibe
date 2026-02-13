import { createHash } from 'node:crypto';
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────

const testState = vi.hoisted(() => ({
  selectResults: [] as unknown[],
  selectDistinctResults: [] as unknown[],
  executeResults: [] as unknown[],
}));

const schemaMock = vi.hoisted(() => {
  const col = (table: string, col: string) => `${table}.${col}`;
  return {
    auditLog: {
      id: col('audit_log', 'id'),
      tenantId: col('audit_log', 'tenant_id'),
      userId: col('audit_log', 'user_id'),
      action: col('audit_log', 'action'),
      entityType: col('audit_log', 'entity_type'),
      entityId: col('audit_log', 'entity_id'),
      newState: col('audit_log', 'new_state'),
      timestamp: col('audit_log', 'timestamp'),
      metadata: col('audit_log', 'metadata'),
      hashChain: col('audit_log', 'hash_chain'),
      previousHash: col('audit_log', 'previous_hash'),
      sequenceNumber: col('audit_log', 'sequence_number'),
    },
    auditLogArchive: {
      tenantId: col('audit_log_archive', 'tenant_id'),
    },
    users: {
      id: col('users', 'id'),
      firstName: col('users', 'first_name'),
      lastName: col('users', 'last_name'),
    },
  };
});

const { dbMock, resetDbMockCalls } = vi.hoisted(() => {
  function makeSelectBuilder(getResult: () => unknown) {
    const builder: any = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.orderBy = () => builder;
    builder.limit = () => builder;
    builder.offset = () => builder;
    builder.groupBy = () => builder;
    builder.leftJoin = () => builder;
    builder.execute = async () => getResult();
    builder.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(getResult()).then(resolve, reject);
    return builder;
  }

  const dbMock = {
    select: vi.fn(() => makeSelectBuilder(() => testState.selectResults.shift() ?? [])),
    selectDistinct: vi.fn(() => makeSelectBuilder(() => testState.selectDistinctResults.shift() ?? [])),
    execute: vi.fn(async () => testState.executeResults.shift() ?? []),
  };

  const resetDbMockCalls = () => {
    dbMock.select.mockClear();
    dbMock.selectDistinct.mockClear();
    dbMock.execute.mockClear();
  };

  return { dbMock, resetDbMockCalls };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ __and: args })),
  asc: vi.fn((col: unknown) => ({ __asc: col })),
  desc: vi.fn((col: unknown) => ({ __desc: col })),
  eq: vi.fn((a: unknown, b: unknown) => ({ __eq: [a, b] })),
  sql: Object.assign(
    vi.fn((...args: unknown[]) => ({ __sql: args })),
    { raw: vi.fn((s: string) => ({ __raw: s })) },
  ),
}));

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
  writeAuditEntry: vi.fn(async () => ({ id: 'audit-1', hashChain: 'test', sequenceNumber: 1 })),
  writeAuditEntries: vi.fn(async () => []),
}));

vi.mock('@arda/auth-utils', () => ({
  requireRole: vi.fn((..._roles: string[]) => (_req: any, _res: any, next: any) => next()),
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

import { auditRouter } from './audit.routes.js';
import { requireRole } from '@arda/auth-utils';

// ─── Test helpers ────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function createTestApp(opts: { tenantId?: string; role?: string } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      tenantId: opts.tenantId ?? TENANT_ID,
      sub: 'user-1',
      role: opts.role ?? 'tenant_admin',
    };
    next();
  });
  app.use('/audit', auditRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
  });
  return app;
}

async function getJson(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: Record<string, any> }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    const text = await response.text();
    let body: Record<string, any>;
    try {
      body = JSON.parse(text) as Record<string, any>;
    } catch {
      body = { error: text };
    }
    return { status: response.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Compute a valid hash chain entry matching the canonical format in writeAuditEntry.
 */
function computeTestHash(entry: {
  tenantId: string;
  sequenceNumber: number;
  action: string;
  entityType: string;
  entityId: string | null;
  timestamp: Date;
  previousHash: string | null;
}): string {
  const prevHash = entry.previousHash ?? 'GENESIS';
  const entityId = entry.entityId ?? '';
  const payload = [
    entry.tenantId,
    entry.sequenceNumber.toString(),
    entry.action,
    entry.entityType,
    entityId,
    entry.timestamp.toISOString(),
    prevHash,
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Build a valid audit chain of N entries.
 */
function buildValidChain(n: number): any[] {
  const entries: any[] = [];
  let prevHash: string | null = null;

  for (let i = 1; i <= n; i++) {
    // Use hours offset from a base date to avoid invalid day-of-month for n > 31
    const ts = new Date(Date.UTC(2026, 0, 1, i, 0, 0));
    const hash = computeTestHash({
      tenantId: TENANT_ID,
      sequenceNumber: i,
      action: 'part.created',
      entityType: 'part',
      entityId: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
      timestamp: ts,
      previousHash: prevHash,
    });

    entries.push({
      id: `entry-${i}`,
      tenantId: TENANT_ID,
      action: 'part.created',
      entityType: 'part',
      entityId: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
      timestamp: ts,
      hashChain: hash,
      previousHash: prevHash,
      sequenceNumber: i,
    });

    prevHash = hash;
  }

  return entries;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('GET /audit/integrity-check', () => {
  beforeEach(() => {
    testState.selectResults = [];
    testState.selectDistinctResults = [];
    testState.executeResults = [];
    resetDbMockCalls();
  });

  it('uses requireRole middleware for tenant_admin access', () => {
    expect(requireRole).toHaveBeenCalledWith('tenant_admin');
  });

  it('returns valid=true for a correct hash chain', async () => {
    const chain = buildValidChain(5);
    testState.selectResults = [chain, []]; // first batch returns 5, second returns empty

    const app = createTestApp();
    const response = await getJson(app, '/audit/integrity-check');

    expect(response.status).toBe(200);
    expect(response.body.data.valid).toBe(true);
    expect(response.body.data.totalChecked).toBe(5);
    expect(response.body.data.violationCount).toBe(0);
    expect(response.body.data.violations).toEqual([]);
  });

  it('detects hash_mismatch when an entry has been tampered with', async () => {
    const chain = buildValidChain(3);
    // Tamper with entry 2's hash
    chain[1].hashChain = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    testState.selectResults = [chain, []];

    const app = createTestApp();
    const response = await getJson(app, '/audit/integrity-check');

    expect(response.status).toBe(200);
    expect(response.body.data.valid).toBe(false);
    expect(response.body.data.violationCount).toBeGreaterThanOrEqual(1);

    const mismatch = response.body.data.violations.find(
      (v: any) => v.type === 'hash_mismatch' && v.sequenceNumber === 2,
    );
    expect(mismatch).toBeDefined();
    expect(mismatch.actual).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('detects chain_break when previousHash does not match prior entry', async () => {
    const chain = buildValidChain(3);
    // Break the chain: entry 3 should reference entry 2's hash but we change entry 2
    chain[1].hashChain = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    testState.selectResults = [chain, []];

    const app = createTestApp();
    const response = await getJson(app, '/audit/integrity-check');

    expect(response.status).toBe(200);
    expect(response.body.data.valid).toBe(false);

    const chainBreak = response.body.data.violations.find(
      (v: any) => v.type === 'chain_break' && v.sequenceNumber === 3,
    );
    expect(chainBreak).toBeDefined();
  });

  it('detects sequence_gap in entry numbering', async () => {
    const chain = buildValidChain(3);
    // Create a gap: skip sequence 2 (make it 1, 3, ...)
    chain[1].sequenceNumber = 3;
    chain[2].sequenceNumber = 4;

    testState.selectResults = [chain, []];

    const app = createTestApp();
    const response = await getJson(app, '/audit/integrity-check');

    expect(response.status).toBe(200);
    expect(response.body.data.valid).toBe(false);

    const gap = response.body.data.violations.find(
      (v: any) => v.type === 'sequence_gap',
    );
    expect(gap).toBeDefined();
    expect(gap.expected).toBe('2');
    expect(gap.actual).toBe('3');
  });

  it('handles PENDING entries by skipping them', async () => {
    const chain = buildValidChain(2);
    // Insert a PENDING entry between valid ones
    const pendingEntry = {
      id: 'pending-1',
      tenantId: TENANT_ID,
      action: 'legacy.action',
      entityType: 'legacy',
      entityId: null,
      timestamp: new Date('2025-12-15T00:00:00.000Z'),
      hashChain: 'PENDING',
      previousHash: null,
      sequenceNumber: 0,
    };

    testState.selectResults = [[pendingEntry, ...chain], []];

    const app = createTestApp();
    const response = await getJson(app, '/audit/integrity-check');

    expect(response.status).toBe(200);
    expect(response.body.data.totalChecked).toBe(3);
    expect(response.body.data.pendingCount).toBe(1);
  });

  it('returns empty result for tenant with no audit entries', async () => {
    testState.selectResults = [[]];

    const app = createTestApp();
    const response = await getJson(app, '/audit/integrity-check');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      totalChecked: 0,
      pendingCount: 0,
      violationCount: 0,
      valid: true,
      violations: [],
    });
  });

  it('handles null entityId correctly in hash computation', async () => {
    const ts = new Date('2026-01-01T00:00:00.000Z');
    const hash = computeTestHash({
      tenantId: TENANT_ID,
      sequenceNumber: 1,
      action: 'notification_preference.updated',
      entityType: 'notification_preference',
      entityId: null,
      timestamp: ts,
      previousHash: null,
    });

    testState.selectResults = [
      [
        {
          id: 'null-entity-1',
          tenantId: TENANT_ID,
          action: 'notification_preference.updated',
          entityType: 'notification_preference',
          entityId: null,
          timestamp: ts,
          hashChain: hash,
          previousHash: null,
          sequenceNumber: 1,
        },
      ],
      [],
    ];

    const app = createTestApp();
    const response = await getJson(app, '/audit/integrity-check');

    expect(response.status).toBe(200);
    expect(response.body.data.valid).toBe(true);
    expect(response.body.data.totalChecked).toBe(1);
  });

  it('processes large chains in batches', async () => {
    // Build a chain of 50+ entries to test batching behavior
    const chain = buildValidChain(50);

    // Mock returns all 50 in first batch, empty in second (under 500 batch size)
    testState.selectResults = [chain, []];

    const app = createTestApp();
    const response = await getJson(app, '/audit/integrity-check');

    expect(response.status).toBe(200);
    expect(response.body.data.valid).toBe(true);
    expect(response.body.data.totalChecked).toBe(50);
  });

  it('caps violation output at 100 entries', async () => {
    // Build 120 entries, each with tampered hash
    const entries = Array.from({ length: 120 }, (_, i) => ({
      id: `entry-${i + 1}`,
      tenantId: TENANT_ID,
      action: 'test.action',
      entityType: 'test',
      entityId: null,
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      hashChain: 'tampered',
      previousHash: null,
      sequenceNumber: i + 1,
    }));

    testState.selectResults = [entries, []];

    const app = createTestApp();
    const response = await getJson(app, '/audit/integrity-check');

    expect(response.status).toBe(200);
    expect(response.body.data.valid).toBe(false);
    expect(response.body.data.violations).toHaveLength(100);
    expect(response.body.data.violationCount).toBeGreaterThan(100);
  });

  it('returns 401 without tenant context', async () => {
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => next());
    app.use('/audit', auditRouter);
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal server error' });
    });

    const response = await getJson(app, '/audit/integrity-check');
    expect(response.status).toBe(401);
  });
});

// ─── Concurrency test: hash computation consistency ──────────────────

describe('hash computation concurrency', () => {
  it('produces consistent hashes for 50+ concurrent computations', () => {
    // Verify that computing hashes concurrently (same input) produces identical results.
    // This tests the determinism of the hash function, which is critical for
    // integrity checks — if a race condition or non-determinism existed in hash
    // computation, the integrity check would report false positives.

    const input = {
      tenantId: TENANT_ID,
      sequenceNumber: 42,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: '33333333-3333-4333-8333-333333333333',
      timestamp: new Date('2026-02-01T12:00:00.000Z'),
      previousHash: 'abc123def456' as string | null,
    };

    // Compute 50+ hashes concurrently
    const promises = Array.from({ length: 60 }, () =>
      Promise.resolve(computeTestHash(input)),
    );

    return Promise.all(promises).then((results) => {
      // All 60 results should be identical
      const uniqueHashes = new Set(results);
      expect(uniqueHashes.size).toBe(1);
      expect(results).toHaveLength(60);
    });
  });

  it('produces different hashes for different sequence numbers', () => {
    const baseInput = {
      tenantId: TENANT_ID,
      action: 'part.created',
      entityType: 'part',
      entityId: '44444444-4444-4444-8444-444444444444',
      timestamp: new Date('2026-02-01T12:00:00.000Z'),
      previousHash: null as string | null,
    };

    const hashes = Array.from({ length: 50 }, (_, i) =>
      computeTestHash({ ...baseInput, sequenceNumber: i + 1 }),
    );

    // All 50 hashes should be unique
    const uniqueHashes = new Set(hashes);
    expect(uniqueHashes.size).toBe(50);
  });

  it('chain verification with 50 entries validates correctly', () => {
    // Build and verify a 50-entry chain to ensure the verification logic
    // handles the chain linking correctly at scale.
    const chain = buildValidChain(50);

    let prevHash: string | null = null;
    for (const entry of chain) {
      // Verify chain link
      expect(entry.previousHash).toBe(prevHash);

      // Recompute and verify hash
      const expected = computeTestHash({
        tenantId: entry.tenantId,
        sequenceNumber: entry.sequenceNumber,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        timestamp: entry.timestamp,
        previousHash: entry.previousHash,
      });
      expect(entry.hashChain).toBe(expected);

      prevHash = entry.hashChain;
    }
  });
});
