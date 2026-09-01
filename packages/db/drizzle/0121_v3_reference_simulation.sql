CREATE TABLE sim_runs (
  id text PRIMARY KEY,
  coin bytea NOT NULL,
  block bigint NOT NULL,
  block_hash bytea NOT NULL,
  size_usd integer NOT NULL CHECK (size_usd IN (100,1000,10000)),
  route_id text NOT NULL,
  method_version text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL,
  trace_digest text NOT NULL,
  trace jsonb,
  trace_expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
);
CREATE INDEX sim_runs_coin_block ON sim_runs(coin,block,acquired_at DESC);
CREATE INDEX sim_runs_trace_expiry ON sim_runs(trace_expires_at) WHERE trace IS NOT NULL;
