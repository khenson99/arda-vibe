-- ─── Analytics Schema ──────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS "analytics";
--> statement-breakpoint
-- ─── KPI Snapshots Table ───────────────────────────────────────────
CREATE TABLE "analytics"."kpi_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"facility_id" uuid,
	"kpi_name" varchar(100) NOT NULL,
	"value" numeric(12, 4) NOT NULL,
	"unit" varchar(50),
	"time_granularity" varchar(20) NOT NULL,
	"snapshot_start" timestamp with time zone NOT NULL,
	"snapshot_end" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- ─── Indexes ───────────────────────────────────────────────────────
CREATE INDEX "kpi_snapshots_tenant_idx" ON "analytics"."kpi_snapshots" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "kpi_snapshots_facility_idx" ON "analytics"."kpi_snapshots" USING btree ("facility_id");
--> statement-breakpoint
CREATE INDEX "kpi_snapshots_kpi_idx" ON "analytics"."kpi_snapshots" USING btree ("tenant_id","kpi_name");
--> statement-breakpoint
CREATE INDEX "kpi_snapshots_time_idx" ON "analytics"."kpi_snapshots" USING btree ("snapshot_start","snapshot_end");
--> statement-breakpoint
CREATE INDEX "kpi_snapshots_composite_idx" ON "analytics"."kpi_snapshots" USING btree ("tenant_id","facility_id","kpi_name","time_granularity","snapshot_start");
