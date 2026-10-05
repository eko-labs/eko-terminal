CREATE TABLE "points_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"category" text NOT NULL,
	"source_id" text NOT NULL,
	"points" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"earning_day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversal_of" uuid
);
--> statement-breakpoint
CREATE TABLE "points_scan_creators" (
	"scan_id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_scan_creators" ADD CONSTRAINT "points_scan_creators_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "points_ledger_source" ON "points_ledger" USING btree ("category","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "points_ledger_reversal" ON "points_ledger" USING btree ("reversal_of") WHERE "points_ledger"."reversal_of" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "points_ledger_daily" ON "points_ledger" USING btree ("account_id","category","earning_day");
--> statement-breakpoint
ALTER TABLE points_ledger ADD CONSTRAINT points_ledger_reversal_of_points_ledger_id_fk FOREIGN KEY (reversal_of) REFERENCES points_ledger(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE points_ledger ADD CONSTRAINT points_ledger_shape CHECK (
  category IN ('guarded_volume','shared_journal','opened_scan','ghost_tip') AND
  length(source_id) BETWEEN 1 AND 256 AND
  ((reversal_of IS NULL AND points > 0) OR (reversal_of IS NOT NULL AND points < 0))
);
--> statement-breakpoint
ALTER TABLE referrals ADD CONSTRAINT referrals_no_self CHECK (referrer_account_id <> referred_account_id);
--> statement-breakpoint
CREATE FUNCTION points_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'points_ledger is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER points_ledger_no_rewrite BEFORE UPDATE OR DELETE OR TRUNCATE ON points_ledger
FOR EACH STATEMENT EXECUTE FUNCTION points_ledger_immutable();
--> statement-breakpoint
CREATE FUNCTION points_ledger_validate_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reversal_of IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM points_ledger WHERE id=NEW.reversal_of AND reversal_of IS NULL
      AND account_id=NEW.account_id AND category=NEW.category AND points=-NEW.points AND earning_day=NEW.earning_day
  ) THEN
    RAISE EXCEPTION 'points reversal must negate an original credit';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER points_ledger_reversal_check BEFORE INSERT ON points_ledger
FOR EACH ROW EXECUTE FUNCTION points_ledger_validate_reversal();
