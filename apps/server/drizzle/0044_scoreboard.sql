-- Public, redacted append-only projections. Original source receipts stay untouched.
CREATE TABLE scoreboard_records (
 seq bigserial PRIMARY KEY,
 source_key text NOT NULL CONSTRAINT scoreboard_records_source_key_unique UNIQUE,
 category text NOT NULL CHECK(category IN ('row','coverage','outcome')),
 data jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX scoreboard_records_category_seq ON scoreboard_records(category,seq);
--> statement-breakpoint
CREATE FUNCTION scoreboard_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Scoreboard records are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER scoreboard_records_immutable BEFORE UPDATE OR DELETE ON scoreboard_records FOR EACH ROW EXECUTE FUNCTION scoreboard_append_only();
