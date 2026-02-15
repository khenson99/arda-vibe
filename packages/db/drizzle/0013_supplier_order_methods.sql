-- Migration: 0013_supplier_order_methods
-- Description: Add order_methods JSONB column to suppliers table for dedicated vendor management tab
-- Ticket: #424
-- Rollback: ALTER TABLE catalog.suppliers DROP COLUMN IF EXISTS order_methods;

ALTER TABLE catalog.suppliers
  ADD COLUMN IF NOT EXISTS order_methods jsonb DEFAULT '[]'::jsonb;
