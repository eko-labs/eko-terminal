CREATE TABLE "preflights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"client_order_ref" text NOT NULL,
	"order_hash" text NOT NULL,
	"instrument" text NOT NULL,
	"side" text NOT NULL,
	"notional_usd" double precision,
	"qty" double precision,
	"decision" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"policy_version" integer NOT NULL,
	"approval_id" uuid,
	"journal_id" uuid NOT NULL,
	"result" jsonb NOT NULL,
	"latency_ms" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preflights_side_check" CHECK ("preflights"."side" IN ('buy','sell')),
	CONSTRAINT "preflights_decision_check" CHECK ("preflights"."decision" IN ('allow','deny','needs_approval'))
);
--> statement-breakpoint
ALTER TABLE "preflights" ADD CONSTRAINT "preflights_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "preflights_agent_ref" ON "preflights" USING btree ("agent_id","client_order_ref");
