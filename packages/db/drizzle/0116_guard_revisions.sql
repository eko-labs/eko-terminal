-- Guard 2.0 §§2.1,7.2–7.3. Additive only. Writer ownership in GUARD_STORAGE_WRITERS.
-- statement-breakpoint
CREATE TABLE guard_measurement_evidence(id text PRIMARY KEY CHECK(id ~ '^0x[0-9a-f]{64}$'), source_key text NOT NULL UNIQUE,
 chain_id bigint NOT NULL CHECK(chain_id > 0), coin text NOT NULL CHECK(coin ~ '^0x[0-9a-f]{40}$'),
 manifest_id text NOT NULL REFERENCES guard_availability(id), source_revision text NOT NULL,
 state_position numeric[] NOT NULL CHECK(array_length(state_position,1)=4), state_hash text NOT NULL,
 known_position numeric[] NOT NULL CHECK(array_length(known_position,1)=4), known_hash text NOT NULL,
 acquisition_sequence numeric(78,0) NOT NULL CHECK(acquisition_sequence >= 0),
 dependency_ids text[] NOT NULL, payload_hash text NOT NULL, object_ref text NOT NULL,
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL, content bytea NOT NULL);
-- statement-breakpoint
CREATE INDEX guard_measurement_evidence_known ON guard_measurement_evidence(chain_id,coin,known_position,acquisition_sequence);
-- statement-breakpoint
CREATE INDEX guard_measurement_evidence_dependencies ON guard_measurement_evidence USING gin(dependency_ids);
-- statement-breakpoint
CREATE TABLE guard_check_coverage(id text PRIMARY KEY CHECK(id ~ '^0x[0-9a-f]{64}$'), source_key text NOT NULL UNIQUE,
 chain_id bigint NOT NULL CHECK(chain_id > 0), coin text NOT NULL CHECK(coin ~ '^0x[0-9a-f]{40}$'),
 manifest_id text NOT NULL REFERENCES guard_availability(id), source_revision text NOT NULL,
 state_position numeric[] NOT NULL CHECK(array_length(state_position,1)=4), state_hash text NOT NULL,
 known_position numeric[] NOT NULL CHECK(array_length(known_position,1)=4), known_hash text NOT NULL,
 acquisition_sequence numeric(78,0) NOT NULL CHECK(acquisition_sequence >= 0),
 dependency_ids text[] NOT NULL, payload_hash text NOT NULL, object_ref text NOT NULL,
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL);
-- statement-breakpoint
CREATE INDEX guard_check_coverage_known ON guard_check_coverage(chain_id,coin,known_position,acquisition_sequence);
-- statement-breakpoint
CREATE INDEX guard_check_coverage_dependencies ON guard_check_coverage USING gin(dependency_ids);
-- statement-breakpoint
CREATE TABLE guard_verdict_revisions(id text PRIMARY KEY CHECK(id ~ '^0x[0-9a-f]{64}$'), source_key text NOT NULL UNIQUE,
 chain_id bigint NOT NULL CHECK(chain_id > 0), coin text NOT NULL CHECK(coin ~ '^0x[0-9a-f]{40}$'),
 manifest_id text NOT NULL REFERENCES guard_availability(id), source_revision text NOT NULL,
 state_position numeric[] NOT NULL CHECK(array_length(state_position,1)=4), state_hash text NOT NULL,
 known_position numeric[] NOT NULL CHECK(array_length(known_position,1)=4), known_hash text NOT NULL,
 acquisition_sequence numeric(78,0) NOT NULL CHECK(acquisition_sequence >= 0),
 dependency_ids text[] NOT NULL, payload_hash text NOT NULL, object_ref text NOT NULL,
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL, semantic_hash text NOT NULL, receipt_id text NOT NULL UNIQUE, supersedes text REFERENCES guard_verdict_revisions(id));
-- statement-breakpoint
CREATE INDEX guard_verdict_revisions_known ON guard_verdict_revisions(chain_id,coin,known_position,acquisition_sequence);
-- statement-breakpoint
CREATE INDEX guard_verdict_revisions_dependencies ON guard_verdict_revisions USING gin(dependency_ids);
-- statement-breakpoint
CREATE TABLE guard_measurement_events(id text PRIMARY KEY, target_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('superseded','orphaned','dependency_invalidated')),
 replacement_id text, cause_id text NOT NULL, known_position numeric[] NOT NULL, acquisition_sequence numeric(78,0) NOT NULL,
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL,
 UNIQUE(target_id,kind,cause_id), CHECK((kind='superseded')=(replacement_id IS NOT NULL)));
-- statement-breakpoint
CREATE INDEX guard_measurement_events_target ON guard_measurement_events(target_id,known_position,acquisition_sequence);
-- statement-breakpoint
CREATE TABLE guard_verdict_events(id text PRIMARY KEY, target_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('superseded','orphaned','dependency_invalidated')),
 replacement_id text, cause_id text NOT NULL, known_position numeric[] NOT NULL, acquisition_sequence numeric(78,0) NOT NULL,
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL,
 UNIQUE(target_id,kind,cause_id), CHECK((kind='superseded')=(replacement_id IS NOT NULL)));
-- statement-breakpoint
CREATE INDEX guard_verdict_events_target ON guard_verdict_events(target_id,known_position,acquisition_sequence);
-- statement-breakpoint
CREATE TABLE guard_verdict_runs(run_id text PRIMARY KEY,revision_id text NOT NULL REFERENCES guard_verdict_revisions(id),recorded_at timestamptz NOT NULL);
-- statement-breakpoint
CREATE TRIGGER guard_measurement_evidence_immutable BEFORE UPDATE OR DELETE ON guard_measurement_evidence FOR EACH ROW EXECUTE FUNCTION guard_append_only();
-- statement-breakpoint
CREATE TRIGGER guard_check_coverage_immutable BEFORE UPDATE OR DELETE ON guard_check_coverage FOR EACH ROW EXECUTE FUNCTION guard_append_only();
-- statement-breakpoint
CREATE TRIGGER guard_verdict_revisions_immutable BEFORE UPDATE OR DELETE ON guard_verdict_revisions FOR EACH ROW EXECUTE FUNCTION guard_append_only();
-- statement-breakpoint
CREATE TRIGGER guard_measurement_events_immutable BEFORE UPDATE OR DELETE ON guard_measurement_events FOR EACH ROW EXECUTE FUNCTION guard_append_only();
-- statement-breakpoint
CREATE TRIGGER guard_verdict_events_immutable BEFORE UPDATE OR DELETE ON guard_verdict_events FOR EACH ROW EXECUTE FUNCTION guard_append_only();
-- statement-breakpoint
CREATE TRIGGER guard_verdict_runs_immutable BEFORE UPDATE OR DELETE ON guard_verdict_runs FOR EACH ROW EXECUTE FUNCTION guard_append_only();
