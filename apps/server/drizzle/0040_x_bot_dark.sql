CREATE TABLE "x_bot_state" (
  "id" integer PRIMARY KEY NOT NULL,
  "data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_bot_usage" (
  "bucket" text PRIMARY KEY NOT NULL,
  "spend" integer NOT NULL,
  "reads" integer NOT NULL,
  "replies" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_summons" (
  "tweet_id" bigint PRIMARY KEY NOT NULL,
  "user_key" text NOT NULL,
  "reserved_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "x_summons_user_time" ON "x_summons" USING btree ("user_key","reserved_at");
--> statement-breakpoint
CREATE TABLE "burn_posts" (
  "platform" text NOT NULL,
  "burn_tx" text NOT NULL,
  "state" text NOT NULL,
  CONSTRAINT "burn_posts_platform_burn_tx_pk" PRIMARY KEY("platform","burn_tx")
);
