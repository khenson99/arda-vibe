-- Migration: Add SQL defaults to hash-chain columns for backward compatibility
-- Ticket: MVP-18/T3 (#252)
--
-- Context: The hash_chain and sequence_number columns were added as NOT NULL
-- in migration 0008 (with backfill). However, existing code across the orders
-- service inserts audit rows without providing these values. Until all callsites
-- are migrated to use writeAuditEntry() (tickets T4-T7), we need SQL defaults
-- so inserts don't fail.
--
-- The default 'PENDING' for hash_chain and 0 for sequence_number are sentinel
-- values indicating the row was written by legacy code. writeAuditEntry() will
-- always compute and supply real values, overriding these defaults.
--
-- Rollback:
--   ALTER TABLE "audit"."audit_log"
--     ALTER COLUMN "hash_chain" DROP DEFAULT,
--     ALTER COLUMN "sequence_number" DROP DEFAULT;

ALTER TABLE "audit"."audit_log"
  ALTER COLUMN "hash_chain" SET DEFAULT 'PENDING',
  ALTER COLUMN "sequence_number" SET DEFAULT 0;
