import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ─── Helpers ────────────────────────────────────────────────────────────

/** Replicates the SQL hash computation for verification. */
function computeAuditHash(row: {
  tenantId: string;
  sequenceNumber: number;
  action: string;
  entityType: string;
  entityId: string | null;
  timestamp: string;
  previousHash: string | null;
}): string {
  const prevHash = row.previousHash ?? 'GENESIS';
  const input = [
    row.tenantId,
    row.sequenceNumber.toString(),
    row.action,
    row.entityType,
    row.entityId ?? '',
    row.timestamp,
    prevHash,
  ].join('|');
  return createHash('sha256').update(input).digest('hex');
}

const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../../drizzle/0008_audit_hash_chain.sql'),
  'utf-8'
);

// ─── Tests ──────────────────────────────────────────────────────────────

describe('0008_audit_hash_chain migration', () => {
  describe('idempotency guards', () => {
    it('uses IF NOT EXISTS for column additions', () => {
      expect(MIGRATION_SQL).toContain('ADD COLUMN IF NOT EXISTS "hash_chain"');
      expect(MIGRATION_SQL).toContain('ADD COLUMN IF NOT EXISTS "previous_hash"');
      expect(MIGRATION_SQL).toContain('ADD COLUMN IF NOT EXISTS "sequence_number"');
    });

    it('backfill targets only NULL rows', () => {
      expect(MIGRATION_SQL).toContain('WHERE "sequence_number" IS NULL');
      expect(MIGRATION_SQL).toContain('WHERE "hash_chain" IS NULL');
    });

    it('uses IF NOT EXISTS for index creation', () => {
      expect(MIGRATION_SQL).toContain(
        'CREATE INDEX IF NOT EXISTS "audit_tenant_seq_idx"'
      );
      expect(MIGRATION_SQL).toContain(
        'CREATE UNIQUE INDEX IF NOT EXISTS "audit_hash_idx"'
      );
    });
  });

  describe('migration structure', () => {
    it('adds columns before backfill', () => {
      const addColumnsPos = MIGRATION_SQL.indexOf('ADD COLUMN IF NOT EXISTS');
      const backfillPos = MIGRATION_SQL.indexOf('ROW_NUMBER() OVER');
      expect(addColumnsPos).toBeLessThan(backfillPos);
    });

    it('backfills before enforcing NOT NULL', () => {
      const backfillPos = MIGRATION_SQL.indexOf('ROW_NUMBER() OVER');
      const notNullPos = MIGRATION_SQL.indexOf('ALTER COLUMN "hash_chain" SET NOT NULL');
      expect(backfillPos).toBeLessThan(notNullPos);
    });

    it('creates indexes after NOT NULL enforcement', () => {
      const notNullPos = MIGRATION_SQL.indexOf('ALTER COLUMN "hash_chain" SET NOT NULL');
      const indexPos = MIGRATION_SQL.indexOf('CREATE INDEX IF NOT EXISTS "audit_tenant_seq_idx"');
      expect(notNullPos).toBeLessThan(indexPos);
    });

    it('uses deterministic tie-breaker ordering (timestamp, id)', () => {
      // The ORDER BY in the backfill CTE should use timestamp ASC, id ASC
      expect(MIGRATION_SQL).toContain('ORDER BY "timestamp" ASC, id ASC');
    });

    it('creates the tenant_seq index with DESC ordering', () => {
      expect(MIGRATION_SQL).toContain('"sequence_number" DESC');
    });
  });

  describe('hash computation', () => {
    const TENANT_A = '00000000-0000-0000-0000-000000000001';
    const ENTITY_1 = '11111111-1111-4111-8111-111111111111';
    const TIMESTAMP_1 = '2026-01-15 10:00:00+00';
    const TIMESTAMP_2 = '2026-01-15 10:05:00+00';

    it('produces a deterministic 64-char hex string', () => {
      const hash = computeAuditHash({
        tenantId: TENANT_A,
        sequenceNumber: 1,
        action: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: ENTITY_1,
        timestamp: TIMESTAMP_1,
        previousHash: null,
      });

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('first row uses GENESIS sentinel when previousHash is null', () => {
      const hash = computeAuditHash({
        tenantId: TENANT_A,
        sequenceNumber: 1,
        action: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: ENTITY_1,
        timestamp: TIMESTAMP_1,
        previousHash: null,
      });

      // Manually compute expected
      const input = `${TENANT_A}|1|purchase_order.created|purchase_order|${ENTITY_1}|${TIMESTAMP_1}|GENESIS`;
      const expected = createHash('sha256').update(input).digest('hex');
      expect(hash).toBe(expected);
    });

    it('chains subsequent rows using previous hash', () => {
      const firstHash = computeAuditHash({
        tenantId: TENANT_A,
        sequenceNumber: 1,
        action: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: ENTITY_1,
        timestamp: TIMESTAMP_1,
        previousHash: null,
      });

      const secondHash = computeAuditHash({
        tenantId: TENANT_A,
        sequenceNumber: 2,
        action: 'purchase_order.approved',
        entityType: 'purchase_order',
        entityId: ENTITY_1,
        timestamp: TIMESTAMP_2,
        previousHash: firstHash,
      });

      expect(secondHash).toHaveLength(64);
      expect(secondHash).not.toBe(firstHash);

      // Verify determinism: same inputs produce same hash
      const secondHashAgain = computeAuditHash({
        tenantId: TENANT_A,
        sequenceNumber: 2,
        action: 'purchase_order.approved',
        entityType: 'purchase_order',
        entityId: ENTITY_1,
        timestamp: TIMESTAMP_2,
        previousHash: firstHash,
      });
      expect(secondHashAgain).toBe(secondHash);
    });

    it('handles null entityId gracefully', () => {
      const hash = computeAuditHash({
        tenantId: TENANT_A,
        sequenceNumber: 1,
        action: 'user.login',
        entityType: 'session',
        entityId: null,
        timestamp: TIMESTAMP_1,
        previousHash: null,
      });

      const input = `${TENANT_A}|1|user.login|session||${TIMESTAMP_1}|GENESIS`;
      const expected = createHash('sha256').update(input).digest('hex');
      expect(hash).toBe(expected);
    });

    it('different tenants produce different chains even with same data', () => {
      const TENANT_B = '00000000-0000-0000-0000-000000000002';

      const hashA = computeAuditHash({
        tenantId: TENANT_A,
        sequenceNumber: 1,
        action: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: ENTITY_1,
        timestamp: TIMESTAMP_1,
        previousHash: null,
      });

      const hashB = computeAuditHash({
        tenantId: TENANT_B,
        sequenceNumber: 1,
        action: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: ENTITY_1,
        timestamp: TIMESTAMP_1,
        previousHash: null,
      });

      expect(hashA).not.toBe(hashB);
    });
  });

  describe('schema exports', () => {
    it('exports new columns from the audit schema', async () => {
      const { auditLog } = await import('../schema/audit.js');

      // Verify the new columns exist on the table definition
      expect(auditLog.hashChain).toBeDefined();
      expect(auditLog.previousHash).toBeDefined();
      expect(auditLog.sequenceNumber).toBeDefined();
    });
  });
});
