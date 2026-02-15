-- Migration: 0016_email_drafts
-- Adds email_drafts table to the orders schema for the email order workflow.
-- Email drafts persist auto-generated and user-edited email content for order emails.

-- ─── Enum ────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "public"."email_draft_status" AS ENUM ('draft', 'editing', 'ready', 'sending', 'sent', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Table ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "orders"."email_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "order_type" varchar(30) NOT NULL,
  "status" "email_draft_status" NOT NULL DEFAULT 'draft',
  "to_recipients" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "cc_recipients" jsonb DEFAULT '[]'::jsonb,
  "bcc_recipients" jsonb DEFAULT '[]'::jsonb,
  "subject" varchar(500) NOT NULL,
  "html_body" text NOT NULL,
  "text_body" text,
  "generated_html_body" text,
  "gmail_message_id" varchar(255),
  "gmail_thread_id" varchar(255),
  "sent_at" timestamp with time zone,
  "sent_by_user_id" uuid,
  "error_message" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- ─── Indexes ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "email_drafts_tenant_idx"
  ON "orders"."email_drafts" ("tenant_id");

CREATE INDEX IF NOT EXISTS "email_drafts_order_idx"
  ON "orders"."email_drafts" ("tenant_id", "order_id", "order_type");

CREATE INDEX IF NOT EXISTS "email_drafts_status_idx"
  ON "orders"."email_drafts" ("tenant_id", "status");
