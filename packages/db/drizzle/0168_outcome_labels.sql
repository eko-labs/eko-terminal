-- Separate shadow outcomes. Legacy outcomes and deployer history are untouched.
CREATE TABLE outcome_label_jobs (
 id text PRIMARY KEY, stream_id text NOT NULL, coin bytea NOT NULL,
 source_revision text NOT NULL CHECK(source_revision ~ '^[0-9a-f]{40}$'),
 input jsonb NOT NULL, next_due_sec bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','completed','orphaned')),
 queued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outcome_label_jobs_due ON outcome_label_jobs(next_due_sec,id) WHERE status='queued';
CREATE TABLE outcome_label_revisions (
 id text PRIMARY KEY, job_id text NOT NULL REFERENCES outcome_label_jobs(id),
 stream_id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
 supersedes text REFERENCES outcome_label_revisions(id), data jsonb NOT NULL,
 dependency_ids jsonb NOT NULL, pins jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(stream_id,revision)
);
CREATE INDEX outcome_label_revisions_stream ON outcome_label_revisions(stream_id,revision);
CREATE TABLE outcome_label_events (
 id text PRIMARY KEY, target_id text NOT NULL REFERENCES outcome_label_revisions(id),
 kind text NOT NULL CHECK(kind IN ('orphaned','superseded','dependency_invalidated')),
 replacement_id text REFERENCES outcome_label_revisions(id), cause_id text NOT NULL,
 known_at jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outcome_label_events_target ON outcome_label_events(target_id);
CREATE TRIGGER outcome_label_revisions_immutable BEFORE UPDATE OR DELETE ON outcome_label_revisions FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER outcome_label_events_immutable BEFORE UPDATE OR DELETE ON outcome_label_events FOR EACH ROW EXECUTE FUNCTION guard_append_only();
