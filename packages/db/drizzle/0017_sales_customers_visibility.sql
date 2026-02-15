-- Migration: 0017_sales_customers_visibility
-- Adds customer, sales order, demand signal, and product visibility tables
-- for the distributor persona workflows (MVP-13).
-- Rollback: DROP tables in reverse order, then DROP enums.

-- ─── Enums ──────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "public"."customer_status" AS ENUM ('active', 'inactive', 'prospect', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."so_status" AS ENUM ('draft', 'confirmed', 'processing', 'partially_shipped', 'shipped', 'delivered', 'invoiced', 'closed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."demand_signal_type" AS ENUM ('sales_order', 'forecast', 'reorder_point', 'safety_stock', 'seasonal', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."visibility_state" AS ENUM ('visible', 'hidden', 'coming_soon', 'discontinued');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Customers ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "orders"."customers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "code" varchar(50),
  "status" "customer_status" NOT NULL DEFAULT 'active',
  "email" varchar(255),
  "phone" varchar(50),
  "website" text,
  "payment_terms" varchar(100),
  "credit_limit" numeric(12, 2),
  "tax_id" varchar(50),
  "notes" text,
  "metadata" jsonb,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "customers_tenant_code_idx"
  ON "orders"."customers" ("tenant_id", "code");
CREATE INDEX IF NOT EXISTS "customers_tenant_idx"
  ON "orders"."customers" ("tenant_id");
CREATE INDEX IF NOT EXISTS "customers_tenant_status_idx"
  ON "orders"."customers" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "customers_tenant_name_idx"
  ON "orders"."customers" ("tenant_id", "name");

-- ─── Customer Contacts ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "orders"."customer_contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "orders"."customers" ("id") ON DELETE CASCADE,
  "first_name" varchar(100) NOT NULL,
  "last_name" varchar(100) NOT NULL,
  "email" varchar(255),
  "phone" varchar(50),
  "title" varchar(100),
  "is_primary" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "customer_contacts_tenant_idx"
  ON "orders"."customer_contacts" ("tenant_id");
CREATE INDEX IF NOT EXISTS "customer_contacts_customer_idx"
  ON "orders"."customer_contacts" ("customer_id");
CREATE INDEX IF NOT EXISTS "customer_contacts_email_idx"
  ON "orders"."customer_contacts" ("tenant_id", "email");

-- ─── Customer Addresses ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "orders"."customer_addresses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "orders"."customers" ("id") ON DELETE CASCADE,
  "label" varchar(100) NOT NULL DEFAULT 'main',
  "address_line_1" varchar(255) NOT NULL,
  "address_line_2" varchar(255),
  "city" varchar(100) NOT NULL,
  "state" varchar(100),
  "postal_code" varchar(20),
  "country" varchar(100) NOT NULL DEFAULT 'US',
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "customer_addresses_tenant_idx"
  ON "orders"."customer_addresses" ("tenant_id");
CREATE INDEX IF NOT EXISTS "customer_addresses_customer_idx"
  ON "orders"."customer_addresses" ("customer_id");

-- ─── Sales Orders ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "orders"."sales_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "so_number" varchar(50) NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "orders"."customers" ("id"),
  "facility_id" uuid NOT NULL,
  "status" "so_status" NOT NULL DEFAULT 'draft',
  "order_date" timestamp with time zone,
  "requested_ship_date" timestamp with time zone,
  "promised_ship_date" timestamp with time zone,
  "actual_ship_date" timestamp with time zone,
  "shipping_address_id" uuid REFERENCES "orders"."customer_addresses" ("id"),
  "billing_address_id" uuid REFERENCES "orders"."customer_addresses" ("id"),
  "subtotal" numeric(12, 2) DEFAULT '0',
  "tax_amount" numeric(12, 2) DEFAULT '0',
  "shipping_amount" numeric(12, 2) DEFAULT '0',
  "discount_amount" numeric(12, 2) DEFAULT '0',
  "total_amount" numeric(12, 2) DEFAULT '0',
  "currency" varchar(3) DEFAULT 'USD',
  "payment_terms" text,
  "shipping_method" varchar(100),
  "tracking_number" varchar(255),
  "notes" text,
  "internal_notes" text,
  "cancelled_at" timestamp with time zone,
  "cancel_reason" text,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "so_tenant_number_idx"
  ON "orders"."sales_orders" ("tenant_id", "so_number");
CREATE INDEX IF NOT EXISTS "so_tenant_idx"
  ON "orders"."sales_orders" ("tenant_id");
CREATE INDEX IF NOT EXISTS "so_customer_idx"
  ON "orders"."sales_orders" ("customer_id");
CREATE INDEX IF NOT EXISTS "so_status_idx"
  ON "orders"."sales_orders" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "so_facility_idx"
  ON "orders"."sales_orders" ("facility_id");
CREATE INDEX IF NOT EXISTS "so_order_date_idx"
  ON "orders"."sales_orders" ("tenant_id", "order_date");

-- ─── Sales Order Lines ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "orders"."sales_order_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "sales_order_id" uuid NOT NULL REFERENCES "orders"."sales_orders" ("id") ON DELETE CASCADE,
  "part_id" uuid NOT NULL,
  "line_number" integer NOT NULL,
  "quantity_ordered" integer NOT NULL,
  "quantity_allocated" integer NOT NULL DEFAULT 0,
  "quantity_shipped" integer NOT NULL DEFAULT 0,
  "unit_price" numeric(12, 4) NOT NULL,
  "discount_percent" numeric(5, 2) DEFAULT '0',
  "line_total" numeric(12, 2) NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "so_lines_tenant_idx"
  ON "orders"."sales_order_lines" ("tenant_id");
CREATE INDEX IF NOT EXISTS "so_lines_so_idx"
  ON "orders"."sales_order_lines" ("sales_order_id");
CREATE INDEX IF NOT EXISTS "so_lines_part_idx"
  ON "orders"."sales_order_lines" ("part_id");
CREATE UNIQUE INDEX IF NOT EXISTS "so_lines_order_line_idx"
  ON "orders"."sales_order_lines" ("sales_order_id", "line_number");

-- ─── Demand Signals ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "orders"."demand_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "part_id" uuid NOT NULL,
  "facility_id" uuid NOT NULL,
  "signal_type" "demand_signal_type" NOT NULL,
  "quantity_demanded" integer NOT NULL,
  "quantity_fulfilled" integer NOT NULL DEFAULT 0,
  "sales_order_id" uuid REFERENCES "orders"."sales_orders" ("id") ON DELETE SET NULL,
  "sales_order_line_id" uuid REFERENCES "orders"."sales_order_lines" ("id") ON DELETE SET NULL,
  "demand_date" timestamp with time zone NOT NULL,
  "fulfilled_at" timestamp with time zone,
  "triggered_kanban_card_id" uuid,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "demand_signals_tenant_idx"
  ON "orders"."demand_signals" ("tenant_id");
CREATE INDEX IF NOT EXISTS "demand_signals_part_idx"
  ON "orders"."demand_signals" ("tenant_id", "part_id");
CREATE INDEX IF NOT EXISTS "demand_signals_facility_idx"
  ON "orders"."demand_signals" ("tenant_id", "facility_id");
CREATE INDEX IF NOT EXISTS "demand_signals_type_idx"
  ON "orders"."demand_signals" ("tenant_id", "signal_type");
CREATE INDEX IF NOT EXISTS "demand_signals_so_idx"
  ON "orders"."demand_signals" ("sales_order_id");
CREATE INDEX IF NOT EXISTS "demand_signals_date_idx"
  ON "orders"."demand_signals" ("tenant_id", "demand_date");

-- ─── Product Visibility ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "catalog"."product_visibility" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "part_id" uuid NOT NULL REFERENCES "catalog"."parts" ("id") ON DELETE CASCADE,
  "visibility_state" "visibility_state" NOT NULL DEFAULT 'hidden',
  "display_name" varchar(255),
  "short_description" text,
  "long_description" text,
  "display_price" numeric(12, 4),
  "display_order" integer DEFAULT 0,
  "published_at" timestamp with time zone,
  "unpublished_at" timestamp with time zone,
  "metadata" jsonb,
  "updated_by_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_visibility_tenant_part_idx"
  ON "catalog"."product_visibility" ("tenant_id", "part_id");
CREATE INDEX IF NOT EXISTS "product_visibility_tenant_idx"
  ON "catalog"."product_visibility" ("tenant_id");
CREATE INDEX IF NOT EXISTS "product_visibility_state_idx"
  ON "catalog"."product_visibility" ("tenant_id", "visibility_state");
CREATE INDEX IF NOT EXISTS "product_visibility_display_order_idx"
  ON "catalog"."product_visibility" ("tenant_id", "display_order");
