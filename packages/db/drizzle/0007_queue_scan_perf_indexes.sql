-- Issue #91: Optimize queue and scan data paths for p95 latency targets
-- Hand-written migration for composite indexes and JSONB expression index

-- Kanban cards: composite index for order-queue hot path
-- Covers WHERE tenant_id = ? AND current_stage = 'triggered' AND is_active = true
CREATE INDEX CONCURRENTLY IF NOT EXISTS "kanban_cards_queue_idx"
  ON "kanban"."kanban_cards" ("tenant_id", "current_stage", "is_active");

-- Card stage transitions: composite index for risk-scan aggregation
-- Covers WHERE tenant_id = ? AND loop_id IN (...) AND to_stage = 'triggered'
-- AND transitioned_at >= ?
CREATE INDEX CONCURRENTLY IF NOT EXISTS "card_transitions_risk_scan_idx"
  ON "kanban"."card_stage_transitions" ("tenant_id", "loop_id", "to_stage", "transitioned_at");

-- Purchase order lines: composite index for draft-PO correlated sub-query
-- Covers WHERE tenant_id = ? AND kanban_card_id = ?
CREATE INDEX CONCURRENTLY IF NOT EXISTS "po_lines_card_tenant_idx"
  ON "orders"."purchase_order_lines" ("tenant_id", "kanban_card_id");

-- JSONB expression index on kanban cards metadata->>'riskLevel'
-- Cannot be expressed in Drizzle ORM; must be raw SQL
-- Supports filtered queries on risk metadata without full-table scans
CREATE INDEX CONCURRENTLY IF NOT EXISTS "kanban_cards_risk_level_idx"
  ON "kanban"."kanban_cards" (("metadata" ->> 'riskLevel'))
  WHERE "metadata" ->> 'riskLevel' IS NOT NULL;
