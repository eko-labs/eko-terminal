-- Independently versioned Signal shadow history. Never a public rank or policy input.
CREATE TABLE signal_shadow_runs (
 id text PRIMARY KEY CHECK(id ~ '^0x[0-9a-f]{64}$'),
 coin text NOT NULL CHECK(coin ~ '^0x[0-9a-f]{40}$'),
 block bigint NOT NULL, snapshot_sec bigint NOT NULL,
 adapter_version text NOT NULL CHECK(adapter_version = '2.0.0'),
 adapter_code_hash text NOT NULL CHECK(adapter_code_hash ~ '^0x[0-9a-f]{64}$'),
 replay_mode text NOT NULL CHECK(replay_mode IN ('production','retrospective')),
 manifest_id text NOT NULL REFERENCES guard_availability(id),
 guard_revision_id text NOT NULL REFERENCES guard_verdict_revisions(id),
 guard_receipt_id text NOT NULL,
 source_revision text NOT NULL CHECK(source_revision ~ '^0x[0-9a-f]{64}$'),
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL,
 CHECK(data->'signal'->>'schemaVersion' = 'signal-2'),
 CHECK(data->'signal'->>'guardReceiptId' = guard_receipt_id),
 CHECK(data->'signal'->>'asOfBlock' = block::text),
 CHECK(data->>'mode' = 'shadow')
);
CREATE INDEX signal_shadow_runs_refresh ON signal_shadow_runs(coin,replay_mode,adapter_code_hash,snapshot_sec DESC);
CREATE TRIGGER signal_shadow_runs_immutable BEFORE UPDATE OR DELETE ON signal_shadow_runs FOR EACH ROW EXECUTE FUNCTION guard_append_only();
