import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_SQL = readFileSync(
  resolve(__dirname, '../../drizzle/0011_import_pipeline.sql'),
  'utf-8'
);

// ─── Tests ──────────────────────────────────────────────────────────────

describe('0011_import_pipeline migration', () => {
  describe('pg_trgm extension', () => {
    it('enables pg_trgm with IF NOT EXISTS guard', () => {
      expect(MIGRATION_SQL).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    });
  });

  describe('idempotency guards', () => {
    it('uses IF NOT EXISTS for all table creations', () => {
      const tables = [
        'import_jobs',
        'import_items',
        'import_matches',
        'ai_provider_config',
        'ai_provider_logs',
      ];
      for (const table of tables) {
        expect(MIGRATION_SQL).toContain(
          `CREATE TABLE IF NOT EXISTS "catalog"."${table}"`
        );
      }
    });

    it('uses IF NOT EXISTS for all index creations', () => {
      const indexes = [
        'import_jobs_tenant_idx',
        'import_jobs_tenant_status_idx',
        'import_jobs_created_by_idx',
        'import_jobs_created_at_idx',
        'import_items_tenant_idx',
        'import_items_job_idx',
        'import_items_job_disposition_idx',
        'import_items_matched_part_idx',
        'import_matches_tenant_idx',
        'import_matches_item_idx',
        'import_matches_existing_part_idx',
        'import_matches_score_idx',
        'ai_provider_config_tenant_idx',
        'ai_provider_config_tenant_op_idx',
        'ai_provider_logs_tenant_idx',
        'ai_provider_logs_job_idx',
        'ai_provider_logs_tenant_op_idx',
        'ai_provider_logs_created_at_idx',
        'parts_name_trgm_idx',
        'parts_part_number_trgm_idx',
        'parts_manufacturer_pn_trgm_idx',
      ];
      for (const idx of indexes) {
        expect(MIGRATION_SQL).toContain(`IF NOT EXISTS "${idx}"`);
      }
    });

    it('uses DO $$ BEGIN / EXCEPTION for enum creation idempotency', () => {
      const enums = [
        'import_job_status',
        'import_source_type',
        'import_item_disposition',
        'ai_operation_type',
        'ai_provider_log_status',
      ];
      for (const enumName of enums) {
        expect(MIGRATION_SQL).toContain(`CREATE TYPE "public"."${enumName}"`);
        // Check for idempotency guard
        expect(MIGRATION_SQL).toContain('EXCEPTION WHEN duplicate_object THEN NULL');
      }
    });
  });

  describe('table structure', () => {
    it('import_jobs has tenant_id column', () => {
      expect(MIGRATION_SQL).toMatch(
        /CREATE TABLE IF NOT EXISTS "catalog"\."import_jobs"[\s\S]*?"tenant_id" uuid NOT NULL/
      );
    });

    it('import_items has foreign key to import_jobs', () => {
      expect(MIGRATION_SQL).toContain(
        'REFERENCES "catalog"."import_jobs"("id") ON DELETE CASCADE'
      );
    });

    it('import_items has foreign key to parts with SET NULL', () => {
      expect(MIGRATION_SQL).toContain(
        'REFERENCES "catalog"."parts"("id") ON DELETE SET NULL'
      );
    });

    it('import_matches has foreign key to import_items', () => {
      expect(MIGRATION_SQL).toContain(
        'REFERENCES "catalog"."import_items"("id") ON DELETE CASCADE'
      );
    });

    it('import_matches has foreign key to parts with CASCADE', () => {
      expect(MIGRATION_SQL).toMatch(
        /import_matches_part_fk.*REFERENCES "catalog"\."parts"\("id"\) ON DELETE CASCADE/s
      );
    });

    it('ai_provider_logs has optional foreign key to import_jobs', () => {
      expect(MIGRATION_SQL).toMatch(
        /ai_provider_logs_job_fk.*REFERENCES "catalog"\."import_jobs"\("id"\) ON DELETE SET NULL/s
      );
    });

    it('import_jobs has all status counter columns with defaults', () => {
      const counters = [
        'total_rows',
        'processed_rows',
        'new_items',
        'duplicate_items',
        'updated_items',
        'skipped_items',
        'error_items',
      ];
      for (const col of counters) {
        expect(MIGRATION_SQL).toMatch(
          new RegExp(`"${col}" integer DEFAULT 0 NOT NULL`)
        );
      }
    });

    it('ai_provider_config has unique constraint on tenant + operation_type', () => {
      expect(MIGRATION_SQL).toContain(
        'CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_config_tenant_op_idx"'
      );
    });
  });

  describe('trigram indexes', () => {
    it('creates GIN trigram index on parts.name', () => {
      expect(MIGRATION_SQL).toContain(
        '"parts_name_trgm_idx"'
      );
      expect(MIGRATION_SQL).toContain('USING gin ("name" gin_trgm_ops)');
    });

    it('creates GIN trigram index on parts.part_number', () => {
      expect(MIGRATION_SQL).toContain(
        '"parts_part_number_trgm_idx"'
      );
      expect(MIGRATION_SQL).toContain('USING gin ("part_number" gin_trgm_ops)');
    });

    it('creates partial GIN trigram index on parts.manufacturer_part_number', () => {
      expect(MIGRATION_SQL).toContain(
        '"parts_manufacturer_pn_trgm_idx"'
      );
      expect(MIGRATION_SQL).toContain(
        'USING gin ("manufacturer_part_number" gin_trgm_ops)'
      );
      expect(MIGRATION_SQL).toContain(
        'WHERE "manufacturer_part_number" IS NOT NULL'
      );
    });
  });

  describe('tenant scoping', () => {
    it('all new tables have tenant_id NOT NULL', () => {
      const tables = [
        'import_jobs',
        'import_items',
        'import_matches',
        'ai_provider_config',
        'ai_provider_logs',
      ];
      for (const table of tables) {
        // Extract the CREATE TABLE block for this table
        const tableRegex = new RegExp(
          `CREATE TABLE IF NOT EXISTS "catalog"\\."${table}"[\\s\\S]*?\\);`,
          'm'
        );
        const match = MIGRATION_SQL.match(tableRegex);
        expect(match).not.toBeNull();
        expect(match![0]).toContain('"tenant_id" uuid NOT NULL');
      }
    });

    it('all new tables have a tenant_id index', () => {
      const prefixes = [
        'import_jobs',
        'import_items',
        'import_matches',
        'ai_provider_config',
        'ai_provider_logs',
      ];
      for (const prefix of prefixes) {
        expect(MIGRATION_SQL).toContain(`"${prefix}_tenant_idx"`);
      }
    });
  });

  describe('migration ordering', () => {
    it('creates extension before tables', () => {
      const extPos = MIGRATION_SQL.indexOf('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      const tablePos = MIGRATION_SQL.indexOf('CREATE TABLE IF NOT EXISTS');
      expect(extPos).toBeLessThan(tablePos);
    });

    it('creates enums before tables', () => {
      const enumPos = MIGRATION_SQL.indexOf('CREATE TYPE "public"."import_job_status"');
      const tablePos = MIGRATION_SQL.indexOf('CREATE TABLE IF NOT EXISTS "catalog"."import_jobs"');
      expect(enumPos).toBeLessThan(tablePos);
    });

    it('creates import_jobs before import_items (dependency order)', () => {
      const jobsPos = MIGRATION_SQL.indexOf(
        'CREATE TABLE IF NOT EXISTS "catalog"."import_jobs"'
      );
      const itemsPos = MIGRATION_SQL.indexOf(
        'CREATE TABLE IF NOT EXISTS "catalog"."import_items"'
      );
      expect(jobsPos).toBeLessThan(itemsPos);
    });

    it('creates import_items before import_matches (dependency order)', () => {
      const itemsPos = MIGRATION_SQL.indexOf(
        'CREATE TABLE IF NOT EXISTS "catalog"."import_items"'
      );
      const matchesPos = MIGRATION_SQL.indexOf(
        'CREATE TABLE IF NOT EXISTS "catalog"."import_matches"'
      );
      expect(itemsPos).toBeLessThan(matchesPos);
    });

    it('creates trigram indexes after tables', () => {
      const lastTablePos = MIGRATION_SQL.indexOf(
        'CREATE TABLE IF NOT EXISTS "catalog"."ai_provider_logs"'
      );
      const trigramPos = MIGRATION_SQL.indexOf('"parts_name_trgm_idx"');
      expect(lastTablePos).toBeLessThan(trigramPos);
    });
  });
});

describe('import pipeline schema exports', () => {
  it('exports import_jobs table from catalog schema', async () => {
    const { importJobs } = await import('../schema/catalog.js');
    expect(importJobs).toBeDefined();
    expect(importJobs.tenantId).toBeDefined();
    expect(importJobs.status).toBeDefined();
    expect(importJobs.sourceType).toBeDefined();
    expect(importJobs.fileName).toBeDefined();
    expect(importJobs.totalRows).toBeDefined();
    expect(importJobs.processedRows).toBeDefined();
    expect(importJobs.newItems).toBeDefined();
    expect(importJobs.duplicateItems).toBeDefined();
    expect(importJobs.updatedItems).toBeDefined();
    expect(importJobs.skippedItems).toBeDefined();
    expect(importJobs.errorItems).toBeDefined();
    expect(importJobs.createdByUserId).toBeDefined();
    expect(importJobs.reviewedByUserId).toBeDefined();
    expect(importJobs.appliedByUserId).toBeDefined();
  });

  it('exports import_items table from catalog schema', async () => {
    const { importItems } = await import('../schema/catalog.js');
    expect(importItems).toBeDefined();
    expect(importItems.tenantId).toBeDefined();
    expect(importItems.importJobId).toBeDefined();
    expect(importItems.rowNumber).toBeDefined();
    expect(importItems.rawData).toBeDefined();
    expect(importItems.normalizedData).toBeDefined();
    expect(importItems.disposition).toBeDefined();
    expect(importItems.matchedPartId).toBeDefined();
    expect(importItems.validationErrors).toBeDefined();
  });

  it('exports import_matches table from catalog schema', async () => {
    const { importMatches } = await import('../schema/catalog.js');
    expect(importMatches).toBeDefined();
    expect(importMatches.tenantId).toBeDefined();
    expect(importMatches.importItemId).toBeDefined();
    expect(importMatches.existingPartId).toBeDefined();
    expect(importMatches.matchScore).toBeDefined();
    expect(importMatches.matchMethod).toBeDefined();
    expect(importMatches.isAccepted).toBeDefined();
  });

  it('exports ai_provider_config table from catalog schema', async () => {
    const { aiProviderConfig } = await import('../schema/catalog.js');
    expect(aiProviderConfig).toBeDefined();
    expect(aiProviderConfig.tenantId).toBeDefined();
    expect(aiProviderConfig.providerName).toBeDefined();
    expect(aiProviderConfig.operationType).toBeDefined();
    expect(aiProviderConfig.modelName).toBeDefined();
    expect(aiProviderConfig.isEnabled).toBeDefined();
    expect(aiProviderConfig.maxRequestsPerMinute).toBeDefined();
    expect(aiProviderConfig.maxTokensPerRequest).toBeDefined();
  });

  it('exports ai_provider_logs table from catalog schema', async () => {
    const { aiProviderLogs } = await import('../schema/catalog.js');
    expect(aiProviderLogs).toBeDefined();
    expect(aiProviderLogs.tenantId).toBeDefined();
    expect(aiProviderLogs.importJobId).toBeDefined();
    expect(aiProviderLogs.operationType).toBeDefined();
    expect(aiProviderLogs.status).toBeDefined();
    expect(aiProviderLogs.inputTokens).toBeDefined();
    expect(aiProviderLogs.outputTokens).toBeDefined();
    expect(aiProviderLogs.latencyMs).toBeDefined();
  });

  it('exports all import pipeline enums', async () => {
    const {
      importJobStatusEnum,
      importSourceTypeEnum,
      importItemDispositionEnum,
      aiOperationTypeEnum,
      aiProviderLogStatusEnum,
    } = await import('../schema/catalog.js');

    expect(importJobStatusEnum).toBeDefined();
    expect(importSourceTypeEnum).toBeDefined();
    expect(importItemDispositionEnum).toBeDefined();
    expect(aiOperationTypeEnum).toBeDefined();
    expect(aiProviderLogStatusEnum).toBeDefined();
  });

  it('exports import pipeline relations', async () => {
    const {
      importJobsRelations,
      importItemsRelations,
      importMatchesRelations,
      aiProviderLogsRelations,
    } = await import('../schema/catalog.js');

    expect(importJobsRelations).toBeDefined();
    expect(importItemsRelations).toBeDefined();
    expect(importMatchesRelations).toBeDefined();
    expect(aiProviderLogsRelations).toBeDefined();
  });

  it('preserves existing catalog exports', async () => {
    const {
      parts,
      suppliers,
      supplierParts,
      bomItems,
      partCategories,
      catalogSchema,
      partTypeEnum,
      uomEnum,
    } = await import('../schema/catalog.js');

    expect(parts).toBeDefined();
    expect(suppliers).toBeDefined();
    expect(supplierParts).toBeDefined();
    expect(bomItems).toBeDefined();
    expect(partCategories).toBeDefined();
    expect(catalogSchema).toBeDefined();
    expect(partTypeEnum).toBeDefined();
    expect(uomEnum).toBeDefined();
  });
});
