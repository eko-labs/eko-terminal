-- Internal shadow journal, not an availability manifest or a public verdict projection.
-- Original records survive reorgs, only guard_verdict_revisions provides canonical reads.
CREATE TABLE guard_shadow_runs (
 id text PRIMARY KEY CHECK(id ~ '^0x[0-9a-f]{64}$'),
 coin text NOT NULL CHECK(coin ~ '^0x[0-9a-f]{40}$'), block bigint NOT NULL,
 legacy_verdict_id text NOT NULL REFERENCES verdicts(id),
 manifest_id text REFERENCES guard_availability(id), revision_id text REFERENCES guard_verdict_revisions(id),
 status text NOT NULL CHECK(status IN ('evaluated','missing_cursor')),
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL,
 CHECK(status <> 'evaluated' OR data->'assessment'->>'mode' = 'shadow')
);
CREATE INDEX guard_shadow_runs_coin_block ON guard_shadow_runs(coin,block);
CREATE TRIGGER guard_shadow_runs_immutable BEFORE UPDATE OR DELETE ON guard_shadow_runs FOR EACH ROW EXECUTE FUNCTION guard_append_only();
