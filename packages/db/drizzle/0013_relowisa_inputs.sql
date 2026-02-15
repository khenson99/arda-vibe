-- Migration: 0013_relowisa_inputs
-- Description: Add wipLimit to kanban_loops, extend parameter history
--   and recommendations with all ReLoWiSa fields
-- Rollback: ALTER TABLE kanban.kanban_loops DROP COLUMN IF EXISTS wip_limit;
--   ALTER TABLE kanban.kanban_parameter_history DROP COLUMN IF EXISTS previous_wip_limit;
--   ALTER TABLE kanban.kanban_parameter_history DROP COLUMN IF EXISTS new_wip_limit;
--   ALTER TABLE kanban.kanban_parameter_history DROP COLUMN IF EXISTS previous_safety_stock_days;
--   ALTER TABLE kanban.kanban_parameter_history DROP COLUMN IF EXISTS new_safety_stock_days;
--   ALTER TABLE kanban.kanban_parameter_history DROP COLUMN IF EXISTS previous_lead_time_days;
--   ALTER TABLE kanban.kanban_parameter_history DROP COLUMN IF EXISTS new_lead_time_days;
--   ALTER TABLE kanban.relowisa_recommendations DROP COLUMN IF EXISTS recommended_wip_limit;

-- 1. Add wip_limit to kanban_loops (nullable — not all loops need a WIP limit)
ALTER TABLE kanban.kanban_loops ADD COLUMN IF NOT EXISTS wip_limit integer;--> statement-breakpoint

-- 2. Extend kanban_parameter_history with ReLoWiSa tracking fields
ALTER TABLE kanban.kanban_parameter_history ADD COLUMN IF NOT EXISTS previous_wip_limit integer;--> statement-breakpoint
ALTER TABLE kanban.kanban_parameter_history ADD COLUMN IF NOT EXISTS new_wip_limit integer;--> statement-breakpoint
ALTER TABLE kanban.kanban_parameter_history ADD COLUMN IF NOT EXISTS previous_safety_stock_days numeric(5,1);--> statement-breakpoint
ALTER TABLE kanban.kanban_parameter_history ADD COLUMN IF NOT EXISTS new_safety_stock_days numeric(5,1);--> statement-breakpoint
ALTER TABLE kanban.kanban_parameter_history ADD COLUMN IF NOT EXISTS previous_lead_time_days integer;--> statement-breakpoint
ALTER TABLE kanban.kanban_parameter_history ADD COLUMN IF NOT EXISTS new_lead_time_days integer;--> statement-breakpoint

-- 3. Extend relowisa_recommendations with wip_limit recommendation
ALTER TABLE kanban.relowisa_recommendations ADD COLUMN IF NOT EXISTS recommended_wip_limit integer;
