-- Migration: 0014_user_oauth_tokens
-- Purpose: Create user_oauth_tokens table for storing encrypted OAuth tokens
--          used by service integrations (Gmail, etc.) — separate from login OAuth.
-- Rollback: DROP TABLE IF EXISTS auth.user_oauth_tokens; DROP TYPE IF EXISTS oauth_token_provider;

-- ─── Step 1: Create enum ────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE oauth_token_provider AS ENUM ('google');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ─── Step 2: Create table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth.user_oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
  provider oauth_token_provider NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expiry TIMESTAMPTZ,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  email VARCHAR(255),
  is_valid BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Step 3: Create indexes ─────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS user_oauth_tokens_user_provider_idx
  ON auth.user_oauth_tokens (user_id, provider);

CREATE INDEX IF NOT EXISTS user_oauth_tokens_tenant_idx
  ON auth.user_oauth_tokens (tenant_id);
