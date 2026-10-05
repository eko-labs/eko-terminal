CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_name" jsonb NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"metadata_document" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_registration_limits" (
	"subject_hash" text PRIMARY KEY NOT NULL,
	"attempts" timestamp with time zone[] NOT NULL,
	"allowed" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"state" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_requests" ADD CONSTRAINT "oauth_requests_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_clients_last_used_idx" ON "oauth_clients" USING btree ("last_used_at");--> statement-breakpoint
CREATE INDEX "oauth_requests_expiry_idx" ON "oauth_requests" USING btree ("expires_at");