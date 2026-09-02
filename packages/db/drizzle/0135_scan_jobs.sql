CREATE TABLE scan_jobs (
  id text PRIMARY KEY,
  query text NOT NULL,
  coin bytea,
  phase text NOT NULL CHECK (phase IN ('queued','acquiring','evaluating','running','waiting','done')),
  status text NOT NULL CHECK (status IN ('pending','ready','not_found','ambiguous')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  first_pending_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  lease_id text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE UNIQUE INDEX scan_jobs_target ON scan_jobs(coin) WHERE coin IS NOT NULL;
CREATE INDEX scan_jobs_queue ON scan_jobs(phase,created_at);
CREATE TABLE scan_timings (
  coin bytea PRIMARY KEY,
  discovery_block bigint NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  engine_started_at timestamptz,
  first_verdict_at timestamptz,
  critical_complete_at timestamptz,
  verdict_id text
);
-- statement-breakpoint
CREATE FUNCTION record_scan_discovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='tokens' THEN
    IF NEW.curve IS NOT NULL THEN
      INSERT INTO scan_timings(coin,discovery_block) VALUES(NEW.address,NEW.first_block) ON CONFLICT DO NOTHING;
    END IF;
  ELSE
    IF NEW.creation_verified THEN
      INSERT INTO scan_timings(coin,discovery_block) SELECT coin,NEW.created_block FROM (VALUES(NEW.currency0),(NEW.currency1)) AS currencies(coin) WHERE coin<>decode(repeat('00',20),'hex') ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- statement-breakpoint
CREATE TRIGGER scan_launch_discovery AFTER INSERT OR UPDATE OF curve ON tokens FOR EACH ROW EXECUTE FUNCTION record_scan_discovery();
CREATE TRIGGER scan_pair_discovery AFTER INSERT OR UPDATE OF creation_verified ON pools FOR EACH ROW EXECUTE FUNCTION record_scan_discovery();
