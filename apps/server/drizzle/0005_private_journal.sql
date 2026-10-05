CREATE TABLE "ground_truth_shared" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_journal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"preflight_id" uuid,
	"key_version" integer NOT NULL,
	"iv" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"salt_ct" "bytea" NOT NULL,
	"commitment" text NOT NULL,
	"share" boolean DEFAULT false NOT NULL,
	"receipt_item_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_consent" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"opted_in" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_keys" (
	"account_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kek_id" text NOT NULL,
	"wrapped_dek" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destroyed_at" timestamp with time zone,
	CONSTRAINT "user_keys_account_id_version_pk" PRIMARY KEY("account_id","version")
);
--> statement-breakpoint
ALTER TABLE "harness_journal" ADD CONSTRAINT "harness_journal_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_journal" ADD CONSTRAINT "harness_journal_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_consent" ADD CONSTRAINT "journal_consent_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_agent_ts" ON "harness_journal" USING btree ("agent_id","ts","id");