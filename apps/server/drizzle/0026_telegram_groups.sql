CREATE TABLE "bot_interactions" (
	"platform" text NOT NULL,
	"update_id" bigint NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_interactions_platform_update_id_pk" PRIMARY KEY("platform","update_id")
);
--> statement-breakpoint
CREATE TABLE "caller_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_key" text NOT NULL,
	"caller_key" text NOT NULL,
	"coin" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caller_grades" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "caller_grades" ADD CONSTRAINT "caller_grades_call_id_caller_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."caller_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "caller_calls_group_coin" ON "caller_calls" USING btree ("group_key","coin");
--> statement-breakpoint
CREATE FUNCTION telegram_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Telegram caller records are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER caller_calls_immutable BEFORE UPDATE OR DELETE ON caller_calls
FOR EACH ROW EXECUTE FUNCTION telegram_record_immutable();
--> statement-breakpoint
CREATE TRIGGER caller_grades_immutable BEFORE UPDATE OR DELETE ON caller_grades
FOR EACH ROW EXECUTE FUNCTION telegram_record_immutable();
