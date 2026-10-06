CREATE TABLE "farcaster_interactions" (
  "bot_fid" integer NOT NULL,
  "cast_hash" text NOT NULL,
  "author_key" text NOT NULL,
  "state" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "farcaster_interactions_bot_fid_cast_hash_pk" PRIMARY KEY("bot_fid","cast_hash")
);
--> statement-breakpoint
CREATE INDEX "farcaster_interactions_rate_idx" ON "farcaster_interactions" USING btree ("bot_fid","author_key","created_at");
--> statement-breakpoint
CREATE TABLE "farcaster_summon_locks" (
  "bot_fid" integer NOT NULL,
  "author_key" text NOT NULL,
  CONSTRAINT "farcaster_summon_locks_bot_fid_author_key_pk" PRIMARY KEY("bot_fid","author_key")
);
