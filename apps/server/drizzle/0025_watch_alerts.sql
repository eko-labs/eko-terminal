CREATE TABLE "alert_consumer_cursors" (
	"account_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_consumer_cursors_account_id_consumer_pk" PRIMARY KEY("account_id","consumer"),
	CONSTRAINT "alert_consumer_cursors_consumer" CHECK ("alert_consumer_cursors"."consumer"='telegram')
);
--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"account_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"source_key" text NOT NULL,
	"data" jsonb NOT NULL,
	"watch_kind" text NOT NULL,
	"watch_target" text NOT NULL,
	"telegram_status" text NOT NULL,
	"telegram_attempts" integer DEFAULT 0 NOT NULL,
	"telegram_next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"telegram_lease_until" timestamp with time zone,
	"telegram_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_deliveries_account_id_seq_pk" PRIMARY KEY("account_id","seq"),
	CONSTRAINT "alert_deliveries_telegram_status" CHECK ("alert_deliveries"."telegram_status" IN ('pending','sent','disabled'))
);
--> statement-breakpoint
CREATE TABLE "alert_settings" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_sources" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_sources_source_key_unique" UNIQUE("source_key"),
	CONSTRAINT "alert_sources_kind" CHECK ("alert_sources"."source_kind" IN ('feed','correction'))
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"after_source" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watches_account_id_kind_target_pk" PRIMARY KEY("account_id","kind","target"),
	CONSTRAINT "watches_kind" CHECK ("watches"."kind" IN ('coin','wallet')),
	CONSTRAINT "watches_target_address" CHECK ("watches"."target" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
ALTER TABLE "alert_consumer_cursors" ADD CONSTRAINT "alert_consumer_cursors_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_source_key_alert_sources_source_key_fk" FOREIGN KEY ("source_key") REFERENCES "public"."alert_sources"("source_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_settings" ADD CONSTRAINT "alert_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_deliveries_account_source" ON "alert_deliveries" USING btree ("account_id","source_key");--> statement-breakpoint
CREATE INDEX "alert_deliveries_telegram" ON "alert_deliveries" USING btree ("telegram_next_at") WHERE "alert_deliveries"."telegram_status"='pending';--> statement-breakpoint
CREATE INDEX "alert_sources_pending" ON "alert_sources" USING btree ("next_attempt_at","seq") WHERE "alert_sources"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "watches_target" ON "watches" USING btree ("kind","target");