-- Migration: Add hash-chain integrity columns to audit.audit_log
-- Ticket: MVP-18/T1 (#250)
--
-- Strategy (3-phase, safe for production):
--   Phase 1: Add columns as NULLABLE (no lock contention)
--   Phase 2: Backfill existing rows with sequence numbers and hash chains
--   Phase 3: Enforce NOT NULL + add indexes
--
-- Rollback: ALTER TABLE audit.audit_log
--   DROP COLUMN IF EXISTS hash_chain,
--   DROP COLUMN IF EXISTS previous_hash,
--   DROP COLUMN IF EXISTS sequence_number;
--   DROP INDEX IF EXISTS audit.audit_tenant_seq_idx;
--   DROP INDEX IF EXISTS audit.audit_hash_idx;

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 1: Add columns (nullable, no default — avoids table rewrite)
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE "audit"."audit_log"
  ADD COLUMN IF NOT EXISTS "hash_chain" varchar(64),
  ADD COLUMN IF NOT EXISTS "previous_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "sequence_number" bigint;

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 2a: Backfill sequence_number per tenant
-- Deterministic ordering: (timestamp ASC, id ASC) as tie-breaker
-- ═══════════════════════════════════════════════════════════════════════

WITH numbered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id
      ORDER BY "timestamp" ASC, id ASC
    ) AS seq
  FROM "audit"."audit_log"
  WHERE "sequence_number" IS NULL
)
UPDATE "audit"."audit_log" AS al
SET "sequence_number" = numbered.seq
FROM numbered
WHERE al.id = numbered.id;

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 2b: Backfill hash_chain per tenant
-- SHA-256 hash of (tenant_id || sequence_number || action || entity_type
--   || entity_id || timestamp || previous_hash)
-- First row per tenant has previous_hash = NULL, uses 'GENESIS' sentinel.
--
-- IMPORTANT: Timestamp serialization uses ISO 8601 format matching JS
-- Date.toISOString() output: "YYYY-MM-DD\"T\"HH24:MI:SS.MSZ"
-- This ensures backfilled hashes are verifiable against runtime-computed hashes.
-- ═══════════════════════════════════════════════════════════════════════

-- Use a recursive CTE to chain hashes sequentially per tenant.
-- For each row, the hash depends on the previous row's hash.

WITH RECURSIVE tenant_ids AS (
  SELECT DISTINCT tenant_id FROM "audit"."audit_log"
  WHERE "hash_chain" IS NULL
),
ordered_rows AS (
  SELECT
    al.id,
    al.tenant_id,
    al.sequence_number,
    al.action,
    al.entity_type,
    al.entity_id,
    -- Convert timestamp to ISO 8601 format matching JS toISOString():
    -- "2026-01-15T10:00:00.000Z"
    to_char(al."timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts_iso,
    ROW_NUMBER() OVER (
      PARTITION BY al.tenant_id
      ORDER BY al.sequence_number ASC
    ) AS rn
  FROM "audit"."audit_log" al
  WHERE al."hash_chain" IS NULL
),
chained AS (
  -- Base case: first row per tenant (rn = 1)
  SELECT
    o.id,
    o.tenant_id,
    o.sequence_number,
    o.rn,
    CAST(NULL AS varchar(64)) AS prev_hash,
    encode(
      sha256(
        (o.tenant_id::text
          || '|' || o.sequence_number::text
          || '|' || o.action
          || '|' || o.entity_type
          || '|' || COALESCE(o.entity_id::text, '')
          || '|' || o.ts_iso
          || '|' || 'GENESIS'
        )::bytea
      ),
      'hex'
    ) AS hash_val
  FROM ordered_rows o
  WHERE o.rn = 1

  UNION ALL

  -- Recursive case: each subsequent row chains from the previous hash
  SELECT
    o.id,
    o.tenant_id,
    o.sequence_number,
    o.rn,
    c.hash_val AS prev_hash,
    encode(
      sha256(
        (o.tenant_id::text
          || '|' || o.sequence_number::text
          || '|' || o.action
          || '|' || o.entity_type
          || '|' || COALESCE(o.entity_id::text, '')
          || '|' || o.ts_iso
          || '|' || c.hash_val
        )::bytea
      ),
      'hex'
    ) AS hash_val
  FROM ordered_rows o
  JOIN chained c
    ON c.tenant_id = o.tenant_id
    AND c.rn = o.rn - 1
)
UPDATE "audit"."audit_log" AS al
SET
  "hash_chain" = chained.hash_val,
  "previous_hash" = chained.prev_hash
FROM chained
WHERE al.id = chained.id;

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 3: Enforce constraints and add indexes
-- ═══════════════════════════════════════════════════════════════════════

-- Enforce NOT NULL now that all rows are backfilled
ALTER TABLE "audit"."audit_log"
  ALTER COLUMN "hash_chain" SET NOT NULL,
  ALTER COLUMN "sequence_number" SET NOT NULL;

-- Index for efficient per-tenant sequence lookups (DESC for "latest first")
CREATE INDEX IF NOT EXISTS "audit_tenant_seq_idx"
  ON "audit"."audit_log" ("tenant_id", "sequence_number" DESC);

-- Unique index on hash_chain for integrity verification
CREATE UNIQUE INDEX IF NOT EXISTS "audit_hash_idx"
  ON "audit"."audit_log" ("hash_chain");
