CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sent', 'delivered', 'failed', 'bounced');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'receiving_completed';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'production_hold';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'automation_escalated';--> statement-breakpoint
CREATE TABLE "auth"."api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"key_hash" varchar(255) NOT NULL,
	"key_prefix" varchar(32) NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "locations"."inventory_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"qty_on_hand" integer DEFAULT 0 NOT NULL,
	"qty_reserved" integer DEFAULT 0 NOT NULL,
	"qty_in_transit" integer DEFAULT 0 NOT NULL,
	"reorder_point" integer DEFAULT 0 NOT NULL,
	"reorder_qty" integer DEFAULT 0 NOT NULL,
	"last_counted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders"."lead_time_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_facility_id" uuid NOT NULL,
	"destination_facility_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"transfer_order_id" uuid,
	"shipped_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"lead_time_days" numeric(6, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications"."notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"provider" varchar(50),
	"provider_message_id" varchar(255),
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications"."tenant_default_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notification_type" "notification_type" NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders"."purchase_order_lines" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "orders"."purchase_order_lines" ADD COLUMN "order_method" varchar(30);--> statement-breakpoint
ALTER TABLE "orders"."purchase_order_lines" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "orders"."purchase_orders" ADD COLUMN "payment_terms" text;--> statement-breakpoint
ALTER TABLE "orders"."purchase_orders" ADD COLUMN "shipping_terms" text;--> statement-breakpoint
ALTER TABLE "orders"."transfer_orders" ADD COLUMN "priority_score" numeric(8, 4) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "orders"."transfer_orders" ADD COLUMN "approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "orders"."transfer_orders" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth"."api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "auth"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations"."inventory_ledger" ADD CONSTRAINT "inventory_ledger_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "locations"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders"."lead_time_history" ADD CONSTRAINT "lead_time_history_transfer_order_id_transfer_orders_id_fk" FOREIGN KEY ("transfer_order_id") REFERENCES "orders"."transfer_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "auth"."api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "api_keys_created_by_idx" ON "auth"."api_keys" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "api_keys_active_idx" ON "auth"."api_keys" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "api_keys_prefix_idx" ON "auth"."api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "inv_ledger_tenant_facility_part_idx" ON "locations"."inventory_ledger" USING btree ("tenant_id","facility_id","part_id");--> statement-breakpoint
CREATE INDEX "inv_ledger_tenant_idx" ON "locations"."inventory_ledger" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "inv_ledger_facility_idx" ON "locations"."inventory_ledger" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "inv_ledger_part_idx" ON "locations"."inventory_ledger" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX "lt_hist_tenant_idx" ON "orders"."lead_time_history" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "lt_hist_route_idx" ON "orders"."lead_time_history" USING btree ("tenant_id","source_facility_id","destination_facility_id");--> statement-breakpoint
CREATE INDEX "lt_hist_part_idx" ON "orders"."lead_time_history" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX "lt_hist_to_idx" ON "orders"."lead_time_history" USING btree ("transfer_order_id");--> statement-breakpoint
CREATE INDEX "notif_deliveries_tenant_idx" ON "notifications"."notification_deliveries" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "notif_deliveries_user_status_idx" ON "notifications"."notification_deliveries" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "notif_deliveries_notification_idx" ON "notifications"."notification_deliveries" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "notif_deliveries_status_created_idx" ON "notifications"."notification_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "tenant_default_prefs_tenant_idx" ON "notifications"."tenant_default_preferences" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_default_prefs_type_idx" ON "notifications"."tenant_default_preferences" USING btree ("notification_type");--> statement-breakpoint
CREATE INDEX "to_priority_idx" ON "orders"."transfer_orders" USING btree ("tenant_id","priority_score");