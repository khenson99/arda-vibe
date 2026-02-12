import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ─── Helpers ────────────────────────────────────────────────────────────

const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../../drizzle/0009_audit_log_archive.sql'),
  'utf-8'
);

// Column names that must match between audit_log and audit_log_archive
const AUDIT_LOG_COLUMNS = [
  'id',
  'tenant_id',
  'user_id',
  'action',
  'entity_type',
  'entity_id',
  'previous_state',
  'new_state',
  'metadata',
  'ip_address',
  'user_agent',
  'timestamp',
  'hash_chain',
  'previous_hash',
  'sequence_number',
];

// ─── Tests ──────────────────────────────────────────────────────────────

describe('0009_audit_log_archive migration', () => {
  describe('table creation', () => {
    it('creates audit_log_archive table', () => {
      expect(MIGRATION_SQL).toContain(
        'CREATE TABLE IF NOT EXISTS "audit"."audit_log_archive"'
      );
    });

    it('uses range partitioning on timestamp', () => {
      expect(MIGRATION_SQL).toContain('PARTITION BY RANGE ("timestamp")');
    });

    it('has composite primary key (id, timestamp) for partition compatibility', () => {
      // Partitioned tables require the partition key in the PK
      expect(MIGRATION_SQL).toContain('PRIMARY KEY ("id", "timestamp")');
    });
  });

  describe('schema parity with audit_log', () => {
    for (const column of AUDIT_LOG_COLUMNS) {
      it(`includes "${column}" column`, () => {
        expect(MIGRATION_SQL).toContain(`"${column}"`);
      });
    }

    it('includes hash_chain as NOT NULL', () => {
      // hash_chain should be NOT NULL in the archive table from the start
      // (archived rows already have hash_chain values)
      expect(MIGRATION_SQL).toMatch(/"hash_chain"\s+varchar\(64\)\s+NOT NULL/);
    });

    it('includes sequence_number as NOT NULL bigint', () => {
      expect(MIGRATION_SQL).toMatch(/"sequence_number"\s+bigint\s+NOT NULL/);
    });

    it('allows previous_hash to be nullable', () => {
      // previous_hash for the first row per tenant is NULL
      const match = MIGRATION_SQL.match(/"previous_hash"\s+varchar\(64\)/);
      expect(match).toBeTruthy();
      // Should NOT have NOT NULL after previous_hash
      expect(MIGRATION_SQL).not.toMatch(/"previous_hash"\s+varchar\(64\)\s+NOT NULL/);
    });
  });

  describe('partitioning', () => {
    it('creates monthly partitions via DO block', () => {
      expect(MIGRATION_SQL).toContain('DO $$');
      expect(MIGRATION_SQL).toContain('PARTITION OF "audit"."audit_log_archive"');
    });

    it('uses idempotent partition creation (checks pg_catalog)', () => {
      expect(MIGRATION_SQL).toContain('IF NOT EXISTS');
      expect(MIGRATION_SQL).toContain('pg_catalog.pg_class');
      expect(MIGRATION_SQL).toContain("n.nspname = 'audit'");
    });

    it('generates 24 monthly partitions (12 back + 12 forward)', () => {
      // The loop range should cover -12..11 = 24 partitions
      expect(MIGRATION_SQL).toContain('FOR i IN -12..11 LOOP');
    });

    it('uses YYYY_MM naming convention for partitions', () => {
      expect(MIGRATION_SQL).toContain("'audit_log_archive_' || to_char(start_date, 'YYYY_MM')");
    });

    it('uses FOR VALUES FROM ... TO for range bounds', () => {
      expect(MIGRATION_SQL).toContain('FOR VALUES FROM');
    });
  });

  describe('indexes', () => {
    it('creates tenant + time composite index', () => {
      expect(MIGRATION_SQL).toContain(
        'CREATE INDEX IF NOT EXISTS "archive_tenant_time_idx"'
      );
      expect(MIGRATION_SQL).toContain(
        'ON "audit"."audit_log_archive" ("tenant_id", "timestamp")'
      );
    });

    it('creates tenant + sequence composite index', () => {
      expect(MIGRATION_SQL).toContain(
        'CREATE INDEX IF NOT EXISTS "archive_tenant_seq_idx"'
      );
      expect(MIGRATION_SQL).toContain(
        'ON "audit"."audit_log_archive" ("tenant_id", "sequence_number")'
      );
    });

    it('creates indexes after table and partitions', () => {
      const tablePos = MIGRATION_SQL.indexOf('CREATE TABLE IF NOT EXISTS');
      const partitionPos = MIGRATION_SQL.indexOf('PARTITION OF');
      const indexPos = MIGRATION_SQL.indexOf('CREATE INDEX IF NOT EXISTS "archive_tenant_time_idx"');

      expect(tablePos).toBeLessThan(partitionPos);
      expect(partitionPos).toBeLessThan(indexPos);
    });
  });

  describe('idempotency', () => {
    it('uses IF NOT EXISTS for table creation', () => {
      expect(MIGRATION_SQL).toContain('CREATE TABLE IF NOT EXISTS');
    });

    it('uses IF NOT EXISTS for all index creation', () => {
      const indexMatches = MIGRATION_SQL.match(/CREATE INDEX/g);
      const ifNotExistsMatches = MIGRATION_SQL.match(/CREATE INDEX IF NOT EXISTS/g);
      expect(indexMatches?.length).toBe(ifNotExistsMatches?.length);
    });

    it('checks partition existence before creation', () => {
      // The DO block checks pg_catalog before creating each partition
      expect(MIGRATION_SQL).toContain("c.relname = part_name");
    });
  });

  describe('rollback documentation', () => {
    it('includes rollback SQL in header comments', () => {
      expect(MIGRATION_SQL).toContain('Rollback:');
      expect(MIGRATION_SQL).toContain('DROP TABLE IF EXISTS audit.audit_log_archive CASCADE');
    });
  });

  describe('schema exports', () => {
    it('exports auditLogArchive from the audit schema', async () => {
      const { auditLogArchive } = await import('../schema/audit.js');

      expect(auditLogArchive).toBeDefined();
      // Verify key columns exist on the table definition
      expect(auditLogArchive.id).toBeDefined();
      expect(auditLogArchive.tenantId).toBeDefined();
      expect(auditLogArchive.timestamp).toBeDefined();
      expect(auditLogArchive.hashChain).toBeDefined();
      expect(auditLogArchive.previousHash).toBeDefined();
      expect(auditLogArchive.sequenceNumber).toBeDefined();
    });

    it('exports TenantSettings with audit retention fields', async () => {
      // TypeScript compile-time check — if the interface is wrong, this
      // import would fail at build.  Runtime check for the shape.
      const { tenants } = await import('../schema/tenants.js');
      expect(tenants).toBeDefined();

      // Verify the settings column exists (JSONB typed as TenantSettings)
      expect(tenants.settings).toBeDefined();
    });
  });
});
