-- Migration: Add digest_run_markers table for tracking per-user digest email sends
-- Part of: [MVP-17/T7] Notification digest scheduler
-- Idempotent: ✅
-- Rollback: DROP TABLE IF EXISTS notifications.digest_run_markers;

-- ─── Create digest_run_markers table ──────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications.digest_run_markers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  last_run_at TIMESTAMPTZ NOT NULL,
  notification_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS digest_markers_user_idx
  ON notifications.digest_run_markers(user_id);

CREATE INDEX IF NOT EXISTS digest_markers_tenant_idx
  ON notifications.digest_run_markers(tenant_id);

CREATE INDEX IF NOT EXISTS digest_markers_last_run_idx
  ON notifications.digest_run_markers(last_run_at);

-- ─── Unique constraint ────────────────────────────────────────────────
-- Each user can only have one digest marker

CREATE UNIQUE INDEX IF NOT EXISTS digest_markers_user_unique_idx
  ON notifications.digest_run_markers(user_id);
