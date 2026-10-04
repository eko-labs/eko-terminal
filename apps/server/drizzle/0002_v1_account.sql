CREATE TABLE "referral_codes" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	CONSTRAINT "referral_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"referred_account_id" uuid PRIMARY KEY NOT NULL,
	"referrer_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "siwe_nonces" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "siwe_nonces" ADD COLUMN "session_hash" text;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_account_id_accounts_id_fk" FOREIGN KEY ("referred_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_account_id_accounts_id_fk" FOREIGN KEY ("referrer_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;