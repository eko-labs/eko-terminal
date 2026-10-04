CREATE TABLE "trading_allowlist" (
	"wallet" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"cap_usd" double precision NOT NULL,
	"added_by" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text DEFAULT '' NOT NULL
);
