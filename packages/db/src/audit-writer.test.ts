import { createHash } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  _computeHash as computeHash,
  _canonicalTimestamp as canonicalTimestamp,
  _tenantLockKeys as tenantLockKeys,
} from './audit-writer.js';

// ─── Test Constants ─────────────────────────────────────────────────

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-000000000002';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ENTITY_ID = '22222222-2222-4222-8222-222222222222';

// UUID with high hex prefix that would overflow signed int8
const TENANT_HIGH_HEX = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

// ─── computeHash Tests ──────────────────────────────────────────────

describe('computeHash', () => {
  const baseTimestamp = new Date('2026-01-15T10:00:00.000Z');

  it('produces a 64-char hex SHA-256 hash', () => {
    const hash = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 1,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses GENESIS sentinel when previousHash is null', () => {
    const hash = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 1,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    // Manual computation using canonical timestamp
    const input = `${TENANT_A}|1|purchase_order.created|purchase_order|${ENTITY_ID}|${baseTimestamp.toISOString()}|GENESIS`;
    const expected = createHash('sha256').update(input).digest('hex');
    expect(hash).toBe(expected);
  });

  it('chains using previous hash when provided', () => {
    const firstHash = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 1,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    const secondHash = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 2,
      action: 'purchase_order.approved',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: new Date('2026-01-15T10:05:00.000Z'),
      previousHash: firstHash,
    });

    expect(secondHash).toHaveLength(64);
    expect(secondHash).not.toBe(firstHash);

    // Verify determinism
    const secondHashAgain = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 2,
      action: 'purchase_order.approved',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: new Date('2026-01-15T10:05:00.000Z'),
      previousHash: firstHash,
    });
    expect(secondHashAgain).toBe(secondHash);
  });

  it('handles null entityId (empty string in hash input)', () => {
    const hash = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 1,
      action: 'user.login',
      entityType: 'session',
      entityId: null,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    const input = `${TENANT_A}|1|user.login|session||${baseTimestamp.toISOString()}|GENESIS`;
    const expected = createHash('sha256').update(input).digest('hex');
    expect(hash).toBe(expected);
  });

  it('handles undefined entityId same as null', () => {
    const hashNull = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 1,
      action: 'user.login',
      entityType: 'session',
      entityId: null,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    const hashUndefined = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 1,
      action: 'user.login',
      entityType: 'session',
      entityId: undefined,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    expect(hashNull).toBe(hashUndefined);
  });

  it('different tenants produce different hashes for same data', () => {
    const hashA = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 1,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    const hashB = computeHash({
      tenantId: TENANT_B,
      sequenceNumber: 1,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    expect(hashA).not.toBe(hashB);
  });

  it('different sequence numbers produce different hashes', () => {
    const hash1 = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 1,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    const hash2 = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 2,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    expect(hash1).not.toBe(hash2);
  });

  it('different timestamps produce different hashes', () => {
    const hash1 = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 1,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    const hash2 = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 1,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: new Date('2026-01-15T10:01:00.000Z'),
      previousHash: null,
    });

    expect(hash1).not.toBe(hash2);
  });

  it('different actions produce different hashes', () => {
    const hash1 = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 1,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    const hash2 = computeHash({
      tenantId: TENANT_A,
      sequenceNumber: 1,
      action: 'purchase_order.approved',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      timestamp: baseTimestamp,
      previousHash: null,
    });

    expect(hash1).not.toBe(hash2);
  });
});

// ─── canonicalTimestamp Tests ────────────────────────────────────────

describe('canonicalTimestamp', () => {
  it('returns ISO 8601 format with milliseconds and Z suffix', () => {
    const ts = new Date('2026-01-15T10:00:00.000Z');
    expect(canonicalTimestamp(ts)).toBe('2026-01-15T10:00:00.000Z');
  });

  it('preserves sub-second precision', () => {
    const ts = new Date('2026-06-01T23:59:59.123Z');
    expect(canonicalTimestamp(ts)).toBe('2026-06-01T23:59:59.123Z');
  });

  it('matches JS Date.toISOString() exactly', () => {
    const ts = new Date('2026-03-15T14:30:00.500Z');
    expect(canonicalTimestamp(ts)).toBe(ts.toISOString());
  });
});

// ─── tenantLockKeys Tests ───────────────────────────────────────────

describe('tenantLockKeys', () => {
  it('returns two 32-bit integers', () => {
    const [hi, lo] = tenantLockKeys(TENANT_A);
    expect(typeof hi).toBe('number');
    expect(typeof lo).toBe('number');
    // Both should be safe 32-bit signed integers
    expect(hi).toBeGreaterThanOrEqual(-2147483648);
    expect(hi).toBeLessThanOrEqual(2147483647);
    expect(lo).toBeGreaterThanOrEqual(-2147483648);
    expect(lo).toBeLessThanOrEqual(2147483647);
  });

  it('handles UUIDs with high hex values without overflow', () => {
    // This UUID would cause BigInt overflow with the old single-bigint approach
    const [hi, lo] = tenantLockKeys(TENANT_HIGH_HEX);
    expect(typeof hi).toBe('number');
    expect(typeof lo).toBe('number');
    expect(Number.isFinite(hi)).toBe(true);
    expect(Number.isFinite(lo)).toBe(true);
    // ffffffff in signed 32-bit = -1
    expect(hi).toBe(-1);
  });

  it('different tenants produce different lock key pairs', () => {
    // Use UUIDs that differ in the first 16 hex characters (after hyphen stripping)
    const keysA = tenantLockKeys('aaaaaaaa-bbbb-0000-0000-000000000000');
    const keysB = tenantLockKeys('cccccccc-dddd-0000-0000-000000000000');
    // At least one component should differ
    expect(keysA[0] !== keysB[0] || keysA[1] !== keysB[1]).toBe(true);
  });

  it('strips hyphens and uses first 16 hex chars', () => {
    // These two UUIDs share the first 16 hex chars (after stripping hyphens)
    const uuid1 = '12345678-abcd-0000-0000-000000000001';
    const uuid2 = '12345678-abcd-0000-9999-999999999999';
    const keys1 = tenantLockKeys(uuid1);
    const keys2 = tenantLockKeys(uuid2);
    expect(keys1).toEqual(keys2);
  });
});

// ─── writeAuditEntry Tests (mocked DB) ──────────────────────────────

describe('writeAuditEntry', () => {
  // The mock now needs a `transaction` method since writeAuditEntry is self-transactional.
  // The transaction mock passes itself as the `tx` argument to the callback.

  const mockExecute = vi.fn();
  const mockSelect = vi.fn();
  const mockInsert = vi.fn();

  // Chain helpers
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  const mockOrderBy = vi.fn();
  const mockLimit = vi.fn();
  const mockValues = vi.fn();
  const mockReturning = vi.fn();

  // Mock that acts as both db and tx — transaction() passes itself
  let mockDbOrTx: any;

  beforeEach(() => {
    vi.resetAllMocks();

    mockDbOrTx = {
      execute: mockExecute,
      select: mockSelect,
      insert: mockInsert,
      transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(mockDbOrTx)),
    };

    // Default chain: select -> from -> where -> orderBy -> limit -> returns empty
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    // Default chain: insert -> values -> returning -> returns inserted
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({ returning: mockReturning });
    mockReturning.mockResolvedValue([{
      id: 'new-audit-id',
      hashChain: 'abc123',
      sequenceNumber: 1,
    }]);
  });

  it('wraps operations in a transaction (self-transactional)', async () => {
    const { writeAuditEntry } = await import('./audit-writer.js');

    await writeAuditEntry(mockDbOrTx, {
      tenantId: TENANT_A,
      userId: USER_ID,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
    });

    // transaction() was called on the db/tx handle
    expect(mockDbOrTx.transaction).toHaveBeenCalledTimes(1);
  });

  it('acquires advisory lock, reads latest, computes hash, and inserts', async () => {
    const { writeAuditEntry } = await import('./audit-writer.js');

    const result = await writeAuditEntry(mockDbOrTx, {
      tenantId: TENANT_A,
      userId: USER_ID,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      newState: { status: 'draft' },
    });

    // 1. Advisory lock acquired (two-int form)
    expect(mockExecute).toHaveBeenCalledTimes(1);

    // 2. Select latest was called
    expect(mockSelect).toHaveBeenCalledTimes(1);

    // 3. Insert was called
    expect(mockInsert).toHaveBeenCalledTimes(1);

    // 4. Returns result
    expect(result).toMatchObject({
      id: 'new-audit-id',
      hashChain: 'abc123',
      sequenceNumber: 1,
    });
  });

  it('uses two-int advisory lock form (no bigint overflow)', async () => {
    const { writeAuditEntry } = await import('./audit-writer.js');

    await writeAuditEntry(mockDbOrTx, {
      tenantId: TENANT_A,
      action: 'test',
      entityType: 'test',
    });

    // Verify the SQL uses pg_advisory_xact_lock(int, int) format
    const lockCall = mockExecute.mock.calls[0][0];
    // sql.raw() stores the raw string — stringify and check for two-int form
    const sqlStr = JSON.stringify(lockCall);
    expect(sqlStr).toMatch(/pg_advisory_xact_lock\(-?\d+,\s*-?\d+\)/);
  });

  it('starts at sequence 1 when no previous entries exist', async () => {
    const { writeAuditEntry } = await import('./audit-writer.js');
    mockLimit.mockResolvedValue([]); // No previous entries

    await writeAuditEntry(mockDbOrTx, {
      tenantId: TENANT_A,
      action: 'user.login',
      entityType: 'session',
    });

    // Check the values passed to insert
    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.sequenceNumber).toBe(1);
    expect(insertValues.previousHash).toBeNull();
  });

  it('increments sequence from latest entry', async () => {
    const { writeAuditEntry } = await import('./audit-writer.js');
    mockLimit.mockResolvedValue([{
      hashChain: 'previous-hash-value',
      sequenceNumber: 42,
    }]);

    await writeAuditEntry(mockDbOrTx, {
      tenantId: TENANT_A,
      action: 'user.login',
      entityType: 'session',
    });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.sequenceNumber).toBe(43);
    expect(insertValues.previousHash).toBe('previous-hash-value');
  });

  it('uses provided timestamp when given', async () => {
    const { writeAuditEntry } = await import('./audit-writer.js');
    const customTs = new Date('2026-06-15T12:00:00.000Z');

    await writeAuditEntry(mockDbOrTx, {
      tenantId: TENANT_A,
      action: 'user.login',
      entityType: 'session',
      timestamp: customTs,
    });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.timestamp).toBe(customTs);
  });

  it('defaults optional fields to null or empty', async () => {
    const { writeAuditEntry } = await import('./audit-writer.js');

    await writeAuditEntry(mockDbOrTx, {
      tenantId: TENANT_A,
      action: 'system.maintenance',
      entityType: 'system',
    });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.userId).toBeNull();
    expect(insertValues.entityId).toBeNull();
    expect(insertValues.previousState).toBeNull();
    expect(insertValues.newState).toBeNull();
    expect(insertValues.metadata).toEqual({});
    expect(insertValues.ipAddress).toBeNull();
    expect(insertValues.userAgent).toBeNull();
  });

  it('passes through all provided fields', async () => {
    const { writeAuditEntry } = await import('./audit-writer.js');

    await writeAuditEntry(mockDbOrTx, {
      tenantId: TENANT_A,
      userId: USER_ID,
      action: 'purchase_order.updated',
      entityType: 'purchase_order',
      entityId: ENTITY_ID,
      previousState: { status: 'draft' },
      newState: { status: 'approved' },
      metadata: { reason: 'manager approval' },
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0',
    });

    const insertValues = mockValues.mock.calls[0][0];
    expect(insertValues.tenantId).toBe(TENANT_A);
    expect(insertValues.userId).toBe(USER_ID);
    expect(insertValues.action).toBe('purchase_order.updated');
    expect(insertValues.entityType).toBe('purchase_order');
    expect(insertValues.entityId).toBe(ENTITY_ID);
    expect(insertValues.previousState).toEqual({ status: 'draft' });
    expect(insertValues.newState).toEqual({ status: 'approved' });
    expect(insertValues.metadata).toEqual({ reason: 'manager approval' });
    expect(insertValues.ipAddress).toBe('192.168.1.1');
    expect(insertValues.userAgent).toBe('Mozilla/5.0');
  });
});

// ─── writeAuditEntries Tests ────────────────────────────────────────

describe('writeAuditEntries', () => {
  const mockExecute = vi.fn();
  const mockSelect = vi.fn();
  const mockInsert = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  const mockOrderBy = vi.fn();
  const mockLimit = vi.fn();
  const mockValues = vi.fn();
  const mockReturning = vi.fn();

  let mockDbOrTx: any;

  beforeEach(() => {
    vi.resetAllMocks();

    mockDbOrTx = {
      execute: mockExecute,
      select: mockSelect,
      insert: mockInsert,
      transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(mockDbOrTx)),
    };

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({ returning: mockReturning });

    let callCount = 0;
    mockReturning.mockImplementation(() => {
      callCount++;
      return Promise.resolve([{
        id: `audit-${callCount}`,
        hashChain: `hash-${callCount}`,
        sequenceNumber: callCount,
      }]);
    });
  });

  it('returns empty array for empty input', async () => {
    const { writeAuditEntries } = await import('./audit-writer.js');

    const results = await writeAuditEntries(mockDbOrTx, TENANT_A, []);

    expect(results).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('wraps batch operations in a transaction', async () => {
    const { writeAuditEntries } = await import('./audit-writer.js');

    await writeAuditEntries(mockDbOrTx, TENANT_A, [
      { action: 'card.triggered', entityType: 'kanban_card', entityId: 'card-1' },
    ]);

    expect(mockDbOrTx.transaction).toHaveBeenCalledTimes(1);
  });

  it('writes multiple entries with sequential sequences', async () => {
    const { writeAuditEntries } = await import('./audit-writer.js');

    const results = await writeAuditEntries(mockDbOrTx, TENANT_A, [
      { action: 'card.triggered', entityType: 'kanban_card', entityId: 'card-1' },
      { action: 'card.triggered', entityType: 'kanban_card', entityId: 'card-2' },
      { action: 'card.triggered', entityType: 'kanban_card', entityId: 'card-3' },
    ]);

    expect(results).toHaveLength(3);
    // Advisory lock acquired once
    expect(mockExecute).toHaveBeenCalledTimes(1);
    // Latest query once
    expect(mockSelect).toHaveBeenCalledTimes(1);
    // Three inserts
    expect(mockInsert).toHaveBeenCalledTimes(3);

    // Verify sequential sequence numbers
    const seqs = mockValues.mock.calls.map((call: any[]) => call[0].sequenceNumber);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('chains hashes sequentially across batch entries', async () => {
    const { writeAuditEntries } = await import('./audit-writer.js');

    await writeAuditEntries(mockDbOrTx, TENANT_A, [
      { action: 'a', entityType: 'x', entityId: 'e1' },
      { action: 'b', entityType: 'x', entityId: 'e2' },
    ]);

    // Second entry should have previousHash from first entry's hash
    const firstInsertHash = mockValues.mock.calls[0][0].hashChain;
    const secondInsertPrev = mockValues.mock.calls[1][0].previousHash;
    expect(secondInsertPrev).toBe(firstInsertHash);
  });
});

// ─── Module Exports ─────────────────────────────────────────────────

describe('module exports', () => {
  it('exports writeAuditEntry function', async () => {
    const mod = await import('./audit-writer.js');
    expect(typeof mod.writeAuditEntry).toBe('function');
  });

  it('exports writeAuditEntries function', async () => {
    const mod = await import('./audit-writer.js');
    expect(typeof mod.writeAuditEntries).toBe('function');
  });

  it('exports _computeHash for testing', async () => {
    const mod = await import('./audit-writer.js');
    expect(typeof mod._computeHash).toBe('function');
  });

  it('exports _canonicalTimestamp for testing', async () => {
    const mod = await import('./audit-writer.js');
    expect(typeof mod._canonicalTimestamp).toBe('function');
  });

  it('exports _tenantLockKeys for testing', async () => {
    const mod = await import('./audit-writer.js');
    expect(typeof mod._tenantLockKeys).toBe('function');
  });
});

// Package-level exports are tested implicitly via the build step
// (importing ./index.js requires DATABASE_URL for client.ts initialization).
