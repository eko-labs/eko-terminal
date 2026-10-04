CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'guest' NOT NULL,
	"wallet_address" text,
	"display_name" text,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"action" text NOT NULL,
	"data" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_installs" (
	"account_id" uuid NOT NULL,
	"bot_id" text NOT NULL,
	"version" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled_on_chart" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_installs_account_id_bot_id_pk" PRIMARY KEY("account_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "bot_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" text NOT NULL,
	"version" text NOT NULL,
	"kind" text NOT NULL,
	"strategy_id" text NOT NULL,
	"strategy_version" text NOT NULL,
	"params" jsonb NOT NULL,
	"provider" text,
	"model" text,
	"prompt_style" text,
	"ensemble" jsonb,
	"markets" jsonb NOT NULL,
	"timeframes" jsonb NOT NULL,
	"data_inputs" jsonb NOT NULL,
	"evaluation" jsonb NOT NULL,
	"changelog" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"review_notes" text,
	"validation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" text PRIMARY KEY NOT NULL,
	"creator_account_id" uuid,
	"creator_name" text NOT NULL,
	"official" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"tagline" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"identity" jsonb NOT NULL,
	"status" text NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"forked_from" text,
	"latest_version" text,
	"installs" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"source" text NOT NULL,
	"market" text NOT NULL,
	"timeframe" text NOT NULL,
	"time" bigint NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" double precision NOT NULL,
	"ingested_at" bigint NOT NULL,
	CONSTRAINT "candles_source_market_timeframe_time_pk" PRIMARY KEY("source","market","timeframe","time")
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"price" double precision NOT NULL,
	"base_qty" double precision NOT NULL,
	"quote_qty" double precision NOT NULL,
	"fee" double precision NOT NULL,
	"fee_asset" text NOT NULL,
	"tx_hash" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"bot_version" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"market" text NOT NULL,
	"timeframe" text NOT NULL,
	"started_at" bigint NOT NULL,
	"latency_ms" integer,
	"outcome" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"est_cost_usd" double precision,
	"error" text,
	"input_hash" text,
	"signal_id" text
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"order_id" uuid,
	"signal_id" text,
	"market" text,
	"body" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "latency_samples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"metric" text NOT NULL,
	"value_ms" double precision NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"signal_id" text,
	"bot_id" text,
	"network" text NOT NULL,
	"venue" text NOT NULL,
	"wallet_address" text,
	"asset_in" text NOT NULL,
	"asset_out" text NOT NULL,
	"amount_in" double precision NOT NULL,
	"expected_out" double precision NOT NULL,
	"min_out" double precision NOT NULL,
	"quote_price" double precision NOT NULL,
	"reference_price" double precision,
	"slippage_bps" integer NOT NULL,
	"quote" jsonb NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"tx_hash" text,
	"approval_tx_hash" text,
	"fill_price" double precision,
	"filled_in" double precision,
	"filled_out" double precision,
	"fee_paid" double precision,
	"fee_asset" text,
	"gas_used" text,
	"error_code" text,
	"error_message" text,
	"latency" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_balances" (
	"account_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"amount" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_balances_account_id_asset_pk" PRIMARY KEY("account_id","asset")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"account_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"market" text NOT NULL,
	"quantity" double precision NOT NULL,
	"avg_cost" double precision NOT NULL,
	"cost_basis" double precision NOT NULL,
	"realized_pnl" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_account_id_mode_market_pk" PRIMARY KEY("account_id","mode","market")
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "signal_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"signal_id" text NOT NULL,
	"type" text NOT NULL,
	"at" bigint NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_rejections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"market" text NOT NULL,
	"timeframe" text NOT NULL,
	"code" text NOT NULL,
	"reason" text NOT NULL,
	"raw" jsonb,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"bot_version" text NOT NULL,
	"bot_name" text NOT NULL,
	"strategy_id" text NOT NULL,
	"strategy_version" text NOT NULL,
	"market" text NOT NULL,
	"network" text NOT NULL,
	"venue" text NOT NULL,
	"timeframe" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"generated_at" bigint NOT NULL,
	"source_data_at" bigint NOT NULL,
	"bar_time" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"reference_price" double precision NOT NULL,
	"metrics" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"invalidation" jsonb NOT NULL,
	"conviction" double precision,
	"provider" text NOT NULL,
	"model" text,
	"inference_ms" integer,
	"revision" integer DEFAULT 0 NOT NULL,
	"data_source" text NOT NULL,
	"simulated_data" boolean NOT NULL,
	"input_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "siwe_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "strategy_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" text NOT NULL,
	"bot_version" text NOT NULL,
	"kind" text NOT NULL,
	"market" text NOT NULL,
	"timeframe" text NOT NULL,
	"period_start" bigint NOT NULL,
	"period_end" bigint NOT NULL,
	"split_time" bigint,
	"sample_size" integer NOT NULL,
	"params" jsonb NOT NULL,
	"assumptions" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"equity" jsonb NOT NULL,
	"data_source" text NOT NULL,
	"simulated_data" boolean NOT NULL,
	"methodology" text NOT NULL,
	"limitations" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_layouts" (
	"account_id" uuid NOT NULL,
	"name" text DEFAULT 'default' NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_layouts_account_id_name_pk" PRIMARY KEY("account_id","name")
);
--> statement-breakpoint
ALTER TABLE "bot_installs" ADD CONSTRAINT "bot_installs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_installs" ADD CONSTRAINT "bot_installs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_versions" ADD CONSTRAINT "bot_versions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_creator_account_id_accounts_id_fk" FOREIGN KEY ("creator_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_balances" ADD CONSTRAINT "paper_balances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "siwe_nonces" ADD CONSTRAINT "siwe_nonces_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_layouts" ADD CONSTRAINT "workspace_layouts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_wallet_uq" ON "accounts" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "audit_account_idx" ON "audit_log" USING btree ("account_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_versions_uq" ON "bot_versions" USING btree ("bot_id","version");--> statement-breakpoint
CREATE INDEX "bots_status_idx" ON "bots" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fills_account_idx" ON "fills" USING btree ("account_id","mode","at");--> statement-breakpoint
CREATE INDEX "inference_runs_bot_idx" ON "inference_runs" USING btree ("bot_id","started_at");--> statement-breakpoint
CREATE INDEX "inference_runs_started_idx" ON "inference_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "journal_account_idx" ON "journal_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "latency_metric_idx" ON "latency_samples" USING btree ("metric","at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idem_uq" ON "orders" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tx_uq" ON "orders" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "orders_account_idx" ON "orders" USING btree ("account_id","mode","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "signal_events_signal_idx" ON "signal_events" USING btree ("signal_id","id");--> statement-breakpoint
CREATE INDEX "signal_rejections_bot_idx" ON "signal_rejections" USING btree ("bot_id","at");--> statement-breakpoint
CREATE INDEX "signals_market_idx" ON "signals" USING btree ("market","generated_at");--> statement-breakpoint
CREATE INDEX "signals_bot_idx" ON "signals" USING btree ("bot_id","generated_at");--> statement-breakpoint
CREATE INDEX "signals_status_idx" ON "signals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "signals_bot_bar_uq" ON "signals" USING btree ("bot_id","market","timeframe","bar_time","action");--> statement-breakpoint
CREATE INDEX "strategy_eval_bot_idx" ON "strategy_evaluations" USING btree ("bot_id","kind","created_at");