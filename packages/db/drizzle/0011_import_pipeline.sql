-- Migration: Add import pipeline tables, enums, indexes, and pg_trgm extension
-- Ticket: MVP-21/T1 (#300)
--
-- Creates catalog.import_jobs, catalog.import_items, catalog.import_matches,
-- catalog.ai_provider_config, and catalog.ai_provider_logs for AI-powered
-- onboarding imports. Enables pg_trgm extension for deduplication performance.
--
-- Rollback:
--   DROP TABLE IF EXISTS "catalog"."ai_provider_logs";
--   DROP TABLE IF EXISTS "catalog"."import_matches";
--   DROP TABLE IF EXISTS "catalog"."import_items";
--   DROP TABLE IF EXISTS "catalog"."ai_provider_config";
--   DROP TABLE IF EXISTS "catalog"."import_jobs";
--   DROP TYPE IF EXISTS "public"."ai_provider_log_status";
--   DROP TYPE IF EXISTS "public"."ai_operation_type";
--   DROP TYPE IF EXISTS "public"."import_item_disposition";
--   DROP TYPE IF EXISTS "public"."import_source_type";
--   DROP TYPE IF EXISTS "public"."import_job_status";
--   DROP EXTENSION IF EXISTS pg_trgm;

-- Enable pg_trgm extension for trigram-based fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- Enums
DO $arda$ BEGIN
  CREATE TYPE "public"."import_job_status" AS ENUM(
    'pending', 'parsing', 'matching', 'review', 'applying',
    'completed', 'failed', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $arda$;
--> statement-breakpoint

DO $arda$ BEGIN
  CREATE TYPE "public"."import_source_type" AS ENUM(
    'csv', 'xlsx', 'google_sheets', 'manual_entry'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $arda$;
--> statement-breakpoint

DO $arda$ BEGIN
  CREATE TYPE "public"."import_item_disposition" AS ENUM(
    'new', 'duplicate', 'update', 'skip', 'error'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $arda$;
--> statement-breakpoint

DO $arda$ BEGIN
  CREATE TYPE "public"."ai_operation_type" AS ENUM(
    'field_mapping', 'deduplication', 'categorization', 'enrichment', 'validation'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $arda$;
--> statement-breakpoint

DO $arda$ BEGIN
  CREATE TYPE "public"."ai_provider_log_status" AS ENUM(
    'pending', 'success', 'error', 'timeout'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $arda$;
--> statement-breakpoint

-- Import Jobs
CREATE TABLE IF NOT EXISTS "catalog"."import_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "status" "import_job_status" DEFAULT 'pending' NOT NULL,
  "source_type" "import_source_type" NOT NULL,
  "file_name" varchar(500) NOT NULL,
  "file_url" text,
  "file_size_bytes" integer,
  "field_mapping" jsonb,
  "total_rows" integer DEFAULT 0 NOT NULL,
  "processed_rows" integer DEFAULT 0 NOT NULL,
  "new_items" integer DEFAULT 0 NOT NULL,
  "duplicate_items" integer DEFAULT 0 NOT NULL,
  "updated_items" integer DEFAULT 0 NOT NULL,
  "skipped_items" integer DEFAULT 0 NOT NULL,
  "error_items" integer DEFAULT 0 NOT NULL,
  "error_log" jsonb,
  "created_by_user_id" uuid NOT NULL,
  "reviewed_by_user_id" uuid,
  "applied_by_user_id" uuid,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Import Items
CREATE TABLE IF NOT EXISTS "catalog"."import_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "import_job_id" uuid NOT NULL,
  "row_number" integer NOT NULL,
  "raw_data" jsonb NOT NULL,
  "normalized_data" jsonb,
  "disposition" "import_item_disposition" DEFAULT 'new' NOT NULL,
  "matched_part_id" uuid,
  "validation_errors" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "import_items_job_fk" FOREIGN KEY ("import_job_id")
    REFERENCES "catalog"."import_jobs"("id") ON DELETE CASCADE,
  CONSTRAINT "import_items_part_fk" FOREIGN KEY ("matched_part_id")
    REFERENCES "catalog"."parts"("id") ON DELETE SET NULL
);
--> statement-breakpoint

-- Import Matches
CREATE TABLE IF NOT EXISTS "catalog"."import_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "import_item_id" uuid NOT NULL,
  "existing_part_id" uuid NOT NULL,
  "match_score" numeric(5, 4) NOT NULL,
  "match_method" varchar(50) NOT NULL,
  "match_details" jsonb,
  "is_accepted" boolean,
  "reviewed_by_user_id" uuid,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "import_matches_item_fk" FOREIGN KEY ("import_item_id")
    REFERENCES "catalog"."import_items"("id") ON DELETE CASCADE,
  CONSTRAINT "import_matches_part_fk" FOREIGN KEY ("existing_part_id")
    REFERENCES "catalog"."parts"("id") ON DELETE CASCADE
);
--> statement-breakpoint

-- AI Provider Config
CREATE TABLE IF NOT EXISTS "catalog"."ai_provider_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "provider_name" varchar(100) NOT NULL,
  "operation_type" "ai_operation_type" NOT NULL,
  "model_name" varchar(100) NOT NULL,
  "api_key_encrypted" text,
  "config" jsonb DEFAULT '{}'::jsonb,
  "is_enabled" boolean DEFAULT true NOT NULL,
  "max_requests_per_minute" integer DEFAULT 60,
  "max_tokens_per_request" integer DEFAULT 4096,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- AI Provider Logs
CREATE TABLE IF NOT EXISTS "catalog"."ai_provider_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "import_job_id" uuid,
  "operation_type" "ai_operation_type" NOT NULL,
  "provider_name" varchar(100) NOT NULL,
  "model_name" varchar(100) NOT NULL,
  "status" "ai_provider_log_status" DEFAULT 'pending' NOT NULL,
  "input_tokens" integer,
  "output_tokens" integer,
  "latency_ms" integer,
  "request_payload" jsonb,
  "response_payload" jsonb,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_provider_logs_job_fk" FOREIGN KEY ("import_job_id")
    REFERENCES "catalog"."import_jobs"("id") ON DELETE SET NULL
);
--> statement-breakpoint

-- Indexes: Import Jobs
CREATE INDEX IF NOT EXISTS "import_jobs_tenant_idx"
  ON "catalog"."import_jobs" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_jobs_tenant_status_idx"
  ON "catalog"."import_jobs" ("tenant_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_jobs_created_by_idx"
  ON "catalog"."import_jobs" ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_jobs_created_at_idx"
  ON "catalog"."import_jobs" ("tenant_id", "created_at");
--> statement-breakpoint

-- Indexes: Import Items
CREATE INDEX IF NOT EXISTS "import_items_tenant_idx"
  ON "catalog"."import_items" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_items_job_idx"
  ON "catalog"."import_items" ("import_job_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_items_job_disposition_idx"
  ON "catalog"."import_items" ("import_job_id", "disposition");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_items_matched_part_idx"
  ON "catalog"."import_items" ("matched_part_id");
--> statement-breakpoint

-- Indexes: Import Matches
CREATE INDEX IF NOT EXISTS "import_matches_tenant_idx"
  ON "catalog"."import_matches" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_matches_item_idx"
  ON "catalog"."import_matches" ("import_item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_matches_existing_part_idx"
  ON "catalog"."import_matches" ("existing_part_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_matches_score_idx"
  ON "catalog"."import_matches" ("import_item_id", "match_score");
--> statement-breakpoint

-- Indexes: AI Provider Config
CREATE INDEX IF NOT EXISTS "ai_provider_config_tenant_idx"
  ON "catalog"."ai_provider_config" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_config_tenant_op_idx"
  ON "catalog"."ai_provider_config" ("tenant_id", "operation_type");
--> statement-breakpoint

-- Indexes: AI Provider Logs
CREATE INDEX IF NOT EXISTS "ai_provider_logs_tenant_idx"
  ON "catalog"."ai_provider_logs" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_provider_logs_job_idx"
  ON "catalog"."ai_provider_logs" ("import_job_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_provider_logs_tenant_op_idx"
  ON "catalog"."ai_provider_logs" ("tenant_id", "operation_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_provider_logs_created_at_idx"
  ON "catalog"."ai_provider_logs" ("tenant_id", "created_at");
--> statement-breakpoint

-- Trigram Indexes for Deduplication Performance
-- These GIN indexes use pg_trgm to accelerate fuzzy text matching
-- during the import deduplication phase (FR-22 through FR-26).
CREATE INDEX IF NOT EXISTS "parts_name_trgm_idx"
  ON "catalog"."parts" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parts_part_number_trgm_idx"
  ON "catalog"."parts" USING gin ("part_number" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parts_manufacturer_pn_trgm_idx"
  ON "catalog"."parts" USING gin ("manufacturer_part_number" gin_trgm_ops)
  WHERE "manufacturer_part_number" IS NOT NULL;
