-- Migration: Create archive-partitioned audit table and tenant retention settings
-- Ticket: MVP-18/T2 (#251)
--
-- Strategy (3-phase, safe for production):
--   Phase 1: Create audit.audit_log_archive as a range-partitioned table on "timestamp"
--   Phase 2: Attach monthly partitions (current + next 11 months, plus prior 12 months)
--   Phase 3: Create indexes on partitioned table
--
-- Rollback:
--   DROP TABLE IF EXISTS audit.audit_log_archive CASCADE;
--
-- Note on partitioning: PostgreSQL range-partitioned tables use the partition key
-- in row routing. Each monthly partition covers [month_start, next_month_start).
-- Drizzle doesn't model partitioning natively; all DDL lives here.

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 1: Create the partitioned archive table
-- Full schema parity with audit.audit_log (including hash-chain columns).
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "audit"."audit_log_archive" (
  "id"               uuid        NOT NULL,
  "tenant_id"        uuid        NOT NULL,
  "user_id"          uuid,
  "action"           varchar(100) NOT NULL,
  "entity_type"      varchar(100) NOT NULL,
  "entity_id"        uuid,
  "previous_state"   jsonb,
  "new_state"        jsonb,
  "metadata"         jsonb        DEFAULT '{}'::jsonb,
  "ip_address"       varchar(45),
  "user_agent"       text,
  "timestamp"        timestamptz  NOT NULL,
  "hash_chain"       varchar(64)  NOT NULL,
  "previous_hash"    varchar(64),
  "sequence_number"  bigint       NOT NULL,
  PRIMARY KEY ("id", "timestamp")
) PARTITION BY RANGE ("timestamp");

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 2: Attach monthly partitions
-- Create 24 months of partitions: 12 months back + current + 11 months forward.
-- This covers a full trailing year of archived data and a year ahead for
-- future inserts. New partitions can be added later via cron / maintenance job.
--
-- Naming convention: audit_log_archive_YYYY_MM
-- Range: [YYYY-MM-01, YYYY-(MM+1)-01)
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  start_date date;
  end_date   date;
  part_name  text;
  i          int;
BEGIN
  -- Generate 24 monthly partitions: 12 months back from today + 12 months forward
  FOR i IN -12..11 LOOP
    start_date := date_trunc('month', CURRENT_DATE + (i || ' months')::interval)::date;
    end_date   := (start_date + interval '1 month')::date;
    part_name  := 'audit_log_archive_' || to_char(start_date, 'YYYY_MM');

    -- Only create if the partition does not already exist
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'audit'
        AND c.relname = part_name
    ) THEN
      EXECUTE format(
        'CREATE TABLE "audit".%I PARTITION OF "audit"."audit_log_archive"
         FOR VALUES FROM (%L) TO (%L)',
        part_name, start_date, end_date
      );
    END IF;
  END LOOP;
END
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 3: Create indexes on the partitioned table
-- PostgreSQL automatically propagates indexes to child partitions.
-- ═══════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS "archive_tenant_time_idx"
  ON "audit"."audit_log_archive" ("tenant_id", "timestamp");

CREATE INDEX IF NOT EXISTS "archive_tenant_seq_idx"
  ON "audit"."audit_log_archive" ("tenant_id", "sequence_number");
