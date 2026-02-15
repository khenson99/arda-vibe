-- Migration: 0014_order_issues_resolutions
-- Description: Add order issues, resolution steps, and order notes tables
--              for rich order detail views and resolution workflows
-- Rollback: DROP TABLE IF EXISTS orders.order_notes CASCADE;
--           DROP TABLE IF EXISTS orders.order_issue_resolution_steps CASCADE;
--           DROP TABLE IF EXISTS orders.order_issues CASCADE;
--           DROP TYPE IF EXISTS order_issue_category;
--           DROP TYPE IF EXISTS order_issue_priority;
--           DROP TYPE IF EXISTS order_issue_status;
--           DROP TYPE IF EXISTS resolution_action_type;

-- ─── Enums ──────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "public"."order_issue_category" AS ENUM (
    'wrong_items',
    'wrong_quantity',
    'damaged',
    'late_delivery',
    'quality_defect',
    'pricing_discrepancy',
    'missing_documentation',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."order_issue_priority" AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."order_issue_status" AS ENUM (
    'open',
    'in_progress',
    'waiting_vendor',
    'resolved',
    'closed',
    'escalated'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."resolution_action_type" AS ENUM (
    'contact_vendor',
    'return_initiated',
    'credit_requested',
    'credit_received',
    'replacement_ordered',
    'reorder',
    'accept_as_is',
    'escalated',
    'note_added',
    'status_changed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Order Issues ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "orders"."order_issues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "order_type" varchar(30) NOT NULL,
  "category" "public"."order_issue_category" NOT NULL,
  "priority" "public"."order_issue_priority" NOT NULL DEFAULT 'medium',
  "status" "public"."order_issue_status" NOT NULL DEFAULT 'open',
  "title" varchar(255) NOT NULL,
  "description" text,
  "reported_by_user_id" uuid,
  "assigned_to_user_id" uuid,
  "resolved_by_user_id" uuid,
  "resolved_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "related_receipt_id" uuid,
  "related_exception_id" uuid,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "order_issue_tenant_idx" ON "orders"."order_issues" ("tenant_id");
CREATE INDEX IF NOT EXISTS "order_issue_order_idx" ON "orders"."order_issues" ("order_id");
CREATE INDEX IF NOT EXISTS "order_issue_status_idx" ON "orders"."order_issues" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "order_issue_category_idx" ON "orders"."order_issues" ("tenant_id", "category");
CREATE INDEX IF NOT EXISTS "order_issue_priority_idx" ON "orders"."order_issues" ("tenant_id", "priority");
CREATE INDEX IF NOT EXISTS "order_issue_assigned_idx" ON "orders"."order_issues" ("assigned_to_user_id");

-- ─── Order Issue Resolution Steps ───────────────────────────────────

CREATE TABLE IF NOT EXISTS "orders"."order_issue_resolution_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL REFERENCES "orders"."order_issues"("id") ON DELETE CASCADE,
  "action_type" "public"."resolution_action_type" NOT NULL,
  "description" text,
  "performed_by_user_id" uuid,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "issue_step_tenant_idx" ON "orders"."order_issue_resolution_steps" ("tenant_id");
CREATE INDEX IF NOT EXISTS "issue_step_issue_idx" ON "orders"."order_issue_resolution_steps" ("issue_id");
CREATE INDEX IF NOT EXISTS "issue_step_type_idx" ON "orders"."order_issue_resolution_steps" ("action_type");

-- ─── Order Notes ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "orders"."order_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "order_type" varchar(30) NOT NULL,
  "content" text NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "order_note_tenant_idx" ON "orders"."order_notes" ("tenant_id");
CREATE INDEX IF NOT EXISTS "order_note_order_idx" ON "orders"."order_notes" ("order_id");
