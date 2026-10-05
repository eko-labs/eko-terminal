CREATE TABLE "mcp_rate_limits" (
	"subject_hash" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mcp_rate_limits_window_idx" ON "mcp_rate_limits" USING btree ("window_start");