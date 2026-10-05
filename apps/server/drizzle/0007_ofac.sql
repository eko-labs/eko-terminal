CREATE TABLE "ofac_refresh" (
	"id" integer PRIMARY KEY NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"failed" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ofac_sdn" (
	"version" bigserial PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"record_count" integer NOT NULL,
	"addresses" text[] NOT NULL
);
