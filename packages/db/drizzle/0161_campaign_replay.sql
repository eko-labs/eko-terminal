CREATE TABLE campaign_replay_jobs (
  id text PRIMARY KEY,
  coin bytea NOT NULL,
  source_revision text NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','completed','orphaned')),
  result jsonb,
  queued_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status = 'completed') = (result IS NOT NULL))
);
CREATE INDEX campaign_replay_jobs_pending ON campaign_replay_jobs(queued_at,id) WHERE status='queued';
