CREATE TABLE "trade_guard_misses" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"incident_id" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "tx_hash" text;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "filled_in" text;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "filled_out" text;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "post_fill_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "trade_guard_misses" ADD CONSTRAINT "trade_guard_misses_order_id_trade_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."trade_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_guard_misses" ADD CONSTRAINT "trade_guard_misses_incident_id_audit_log_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."audit_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trade_orders_tx_hash" ON "trade_orders" USING btree ("tx_hash");