-- Migration: 0015_my_business_elements
-- Description: Add process shop element tables for My Business configuration (#438)
-- Ticket: #438
-- Tables: departments, item_types, item_subtypes, use_cases
-- Also adds color_hex to facilities and storage_locations for color-coding (#439)

-- ─── Departments ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS catalog.departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name varchar(255) NOT NULL,
  code varchar(50) NOT NULL,
  description text,
  color_hex varchar(7),
  sort_order integer DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS departments_tenant_idx ON catalog.departments (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS departments_tenant_code_idx ON catalog.departments (tenant_id, code);

-- ─── Item Types ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS catalog.item_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name varchar(255) NOT NULL,
  code varchar(50) NOT NULL,
  description text,
  color_hex varchar(7),
  sort_order integer DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS item_types_tenant_idx ON catalog.item_types (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS item_types_tenant_code_idx ON catalog.item_types (tenant_id, code);

-- ─── Item Subtypes ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS catalog.item_subtypes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  item_type_id uuid NOT NULL REFERENCES catalog.item_types(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  code varchar(50) NOT NULL,
  description text,
  color_hex varchar(7),
  sort_order integer DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS item_subtypes_tenant_idx ON catalog.item_subtypes (tenant_id);
CREATE INDEX IF NOT EXISTS item_subtypes_type_idx ON catalog.item_subtypes (item_type_id);
CREATE UNIQUE INDEX IF NOT EXISTS item_subtypes_tenant_type_code_idx ON catalog.item_subtypes (tenant_id, item_type_id, code);

-- ─── Use Cases ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS catalog.use_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name varchar(255) NOT NULL,
  code varchar(50) NOT NULL,
  description text,
  color_hex varchar(7),
  sort_order integer DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS use_cases_tenant_idx ON catalog.use_cases (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS use_cases_tenant_code_idx ON catalog.use_cases (tenant_id, code);

-- ─── Add color_hex to existing tables for color-coding support (#439) ────

ALTER TABLE locations.facilities
  ADD COLUMN IF NOT EXISTS color_hex varchar(7);

ALTER TABLE locations.storage_locations
  ADD COLUMN IF NOT EXISTS color_hex varchar(7);
