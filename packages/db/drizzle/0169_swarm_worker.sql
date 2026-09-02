-- Queue is mutable. Evidence and budget reservations are append-only.
CREATE TABLE swarm_jobs (id text PRIMARY KEY, cache_key text NOT NULL, coin text NOT NULL, input jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','running','done','failed')), queued_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz, finished_at timestamptz, result jsonb);
CREATE INDEX swarm_jobs_pending ON swarm_jobs(state,queued_at,id);
CREATE TABLE persona_sets (version text PRIMARY KEY, hash text NOT NULL, data jsonb NOT NULL);
CREATE TABLE swarm_budget_reservations (id text PRIMARY KEY, job_id text NOT NULL REFERENCES swarm_jobs(id), coin text NOT NULL,
 started_at bigint NOT NULL, max_cost_usd numeric NOT NULL CHECK(max_cost_usd>0));
CREATE INDEX swarm_budget_day ON swarm_budget_reservations(started_at,coin);
CREATE TABLE persona_votes (id text PRIMARY KEY, job_id text NOT NULL REFERENCES swarm_jobs(id), sample_index integer NOT NULL,
 model text NOT NULL, provider text NOT NULL, as_of_block bigint NOT NULL, snapshot_hash text NOT NULL, data jsonb NOT NULL,
 UNIQUE(job_id,sample_index));
CREATE TABLE swarm_cache (cache_key text NOT NULL, source_job text NOT NULL REFERENCES swarm_jobs(id), data jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(cache_key,source_job));
CREATE TABLE forecasts (id text PRIMARY KEY, job_id text NOT NULL UNIQUE REFERENCES swarm_jobs(id), coin text NOT NULL,
 as_of_block bigint NOT NULL, recorded_at timestamptz NOT NULL, data jsonb NOT NULL,
 receipt_id text NOT NULL UNIQUE REFERENCES receipt_publications(id));
CREATE TRIGGER persona_sets_immutable BEFORE UPDATE OR DELETE ON persona_sets FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER swarm_budget_immutable BEFORE UPDATE OR DELETE ON swarm_budget_reservations FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER persona_votes_immutable BEFORE UPDATE OR DELETE ON persona_votes FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER swarm_cache_immutable BEFORE UPDATE OR DELETE ON swarm_cache FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER forecasts_immutable BEFORE UPDATE OR DELETE ON forecasts FOR EACH ROW EXECUTE FUNCTION guard_append_only();
