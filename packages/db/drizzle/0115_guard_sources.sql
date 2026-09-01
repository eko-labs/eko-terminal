-- Guard 2.0 §§2.1,7.2–7.3. Additive only. Writer ownership in GUARD_STORAGE_WRITERS.
-- statement-breakpoint
CREATE TABLE guard_availability(id text PRIMARY KEY,chain_id bigint NOT NULL,source_id text NOT NULL,source_revision text NOT NULL,replay_mode text NOT NULL CHECK(replay_mode IN ('production','retrospective')),acquisition_sequence numeric(78,0) NOT NULL,known_position numeric[] NOT NULL,watermark_position numeric[] NOT NULL,data jsonb NOT NULL,acquired_at timestamptz NOT NULL,UNIQUE(chain_id,source_id,source_revision,replay_mode,acquisition_sequence));
-- statement-breakpoint
CREATE FUNCTION guard_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Guard records are append-only'; END $$;
-- statement-breakpoint
CREATE TABLE guard_chain_evidence(id text PRIMARY KEY CHECK(id ~ '^0x[0-9a-f]{64}$'), source_key text NOT NULL UNIQUE,
 chain_id bigint NOT NULL CHECK(chain_id > 0), coin text NOT NULL CHECK(coin ~ '^0x[0-9a-f]{40}$'),
 manifest_id text NOT NULL REFERENCES guard_availability(id), source_revision text NOT NULL,
 state_position numeric[] NOT NULL CHECK(array_length(state_position,1)=4), state_hash text NOT NULL,
 known_position numeric[] NOT NULL CHECK(array_length(known_position,1)=4), known_hash text NOT NULL,
 acquisition_sequence numeric(78,0) NOT NULL CHECK(acquisition_sequence >= 0),
 dependency_ids text[] NOT NULL, payload_hash text NOT NULL, object_ref text NOT NULL,
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL, content bytea NOT NULL);
-- statement-breakpoint
CREATE INDEX guard_chain_evidence_known ON guard_chain_evidence(chain_id,coin,known_position,acquisition_sequence);
-- statement-breakpoint
CREATE INDEX guard_chain_evidence_dependencies ON guard_chain_evidence USING gin(dependency_ids);
-- statement-breakpoint
CREATE TABLE guard_roles(id text PRIMARY KEY CHECK(id ~ '^0x[0-9a-f]{64}$'), source_key text NOT NULL UNIQUE,
 chain_id bigint NOT NULL CHECK(chain_id > 0), coin text NOT NULL CHECK(coin ~ '^0x[0-9a-f]{40}$'),
 manifest_id text NOT NULL REFERENCES guard_availability(id), source_revision text NOT NULL,
 state_position numeric[] NOT NULL CHECK(array_length(state_position,1)=4), state_hash text NOT NULL,
 known_position numeric[] NOT NULL CHECK(array_length(known_position,1)=4), known_hash text NOT NULL,
 acquisition_sequence numeric(78,0) NOT NULL CHECK(acquisition_sequence >= 0),
 dependency_ids text[] NOT NULL, payload_hash text NOT NULL, object_ref text NOT NULL,
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL, content bytea NOT NULL);
-- statement-breakpoint
CREATE INDEX guard_roles_known ON guard_roles(chain_id,coin,known_position,acquisition_sequence);
-- statement-breakpoint
CREATE INDEX guard_roles_dependencies ON guard_roles USING gin(dependency_ids);
-- statement-breakpoint
CREATE TABLE guard_source_coverage(id text PRIMARY KEY CHECK(id ~ '^0x[0-9a-f]{64}$'), source_key text NOT NULL UNIQUE,
 chain_id bigint NOT NULL CHECK(chain_id > 0), coin text NOT NULL CHECK(coin ~ '^0x[0-9a-f]{40}$'),
 manifest_id text NOT NULL REFERENCES guard_availability(id), source_revision text NOT NULL,
 state_position numeric[] NOT NULL CHECK(array_length(state_position,1)=4), state_hash text NOT NULL,
 known_position numeric[] NOT NULL CHECK(array_length(known_position,1)=4), known_hash text NOT NULL,
 acquisition_sequence numeric(78,0) NOT NULL CHECK(acquisition_sequence >= 0),
 dependency_ids text[] NOT NULL, payload_hash text NOT NULL, object_ref text NOT NULL,
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL);
-- statement-breakpoint
CREATE INDEX guard_source_coverage_known ON guard_source_coverage(chain_id,coin,known_position,acquisition_sequence);
-- statement-breakpoint
CREATE INDEX guard_source_coverage_dependencies ON guard_source_coverage USING gin(dependency_ids);
-- statement-breakpoint
CREATE TABLE guard_source_events(id text PRIMARY KEY, target_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('superseded','orphaned','dependency_invalidated')),
 replacement_id text, cause_id text NOT NULL, known_position numeric[] NOT NULL, acquisition_sequence numeric(78,0) NOT NULL,
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL,
 UNIQUE(target_id,kind,cause_id), CHECK((kind='superseded')=(replacement_id IS NOT NULL)));
-- statement-breakpoint
CREATE INDEX guard_source_events_target ON guard_source_events(target_id,known_position,acquisition_sequence);
-- statement-breakpoint
CREATE TRIGGER guard_chain_evidence_immutable BEFORE UPDATE OR DELETE ON guard_chain_evidence FOR EACH ROW EXECUTE FUNCTION guard_append_only();
-- statement-breakpoint
CREATE TRIGGER guard_roles_immutable BEFORE UPDATE OR DELETE ON guard_roles FOR EACH ROW EXECUTE FUNCTION guard_append_only();
-- statement-breakpoint
CREATE TRIGGER guard_source_coverage_immutable BEFORE UPDATE OR DELETE ON guard_source_coverage FOR EACH ROW EXECUTE FUNCTION guard_append_only();
-- statement-breakpoint
CREATE TRIGGER guard_source_events_immutable BEFORE UPDATE OR DELETE ON guard_source_events FOR EACH ROW EXECUTE FUNCTION guard_append_only();
-- statement-breakpoint
CREATE TRIGGER guard_availability_immutable BEFORE UPDATE OR DELETE ON guard_availability FOR EACH ROW EXECUTE FUNCTION guard_append_only();
