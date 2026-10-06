CREATE TABLE "linked_identities" (
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linked_identities_account_id_provider_pk" PRIMARY KEY("account_id","provider"),
	CONSTRAINT "linked_identities_provider" CHECK ("linked_identities"."provider" IN ('telegram','x','farcaster'))
);
--> statement-breakpoint
CREATE TABLE "telegram_link_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "linked_identities" ADD CONSTRAINT "linked_identities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "telegram_link_codes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linked_identities_external_uq" ON "linked_identities" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_link_codes_account_uq" ON "telegram_link_codes" USING btree ("account_id");