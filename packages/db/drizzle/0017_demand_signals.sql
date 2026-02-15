-- Migration: 0017_demand_signals
-- Adds orders.demand_signals for director demand analytics and demand signal CRUD flows.

-- ─── Enum ────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "public"."demand_signal_type" AS ENUM (
    'sales_order',
    'forecast',
    'reorder_point',
    'safety_stock',
    'seasonal',
    'manual'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Table ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "orders"."demand_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "part_id" uuid NOT NULL,
  "facility_id" uuid NOT NULL,
  "signal_type" "public"."demand_signal_type" NOT NULL,
  "quantity_demanded" integer NOT NULL,
  "quantity_fulfilled" integer NOT NULL DEFAULT 0,
  "sales_order_id" uuid,
  "sales_order_line_id" uuid,
  "demand_date" timestamp with time zone NOT NULL,
  "fulfilled_at" timestamp with time zone,
  "triggered_kanban_card_id" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- ─── Indexes ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "demand_signals_tenant_idx"
  ON "orders"."demand_signals" ("tenant_id");

CREATE INDEX IF NOT EXISTS "demand_signals_tenant_date_idx"
  ON "orders"."demand_signals" ("tenant_id", "demand_date");

CREATE INDEX IF NOT EXISTS "demand_signals_tenant_signal_type_date_idx"
  ON "orders"."demand_signals" ("tenant_id", "signal_type", "demand_date");

CREATE INDEX IF NOT EXISTS "demand_signals_tenant_part_date_idx"
  ON "orders"."demand_signals" ("tenant_id", "part_id", "demand_date");

CREATE INDEX IF NOT EXISTS "demand_signals_tenant_facility_date_idx"
  ON "orders"."demand_signals" ("tenant_id", "facility_id", "demand_date");
