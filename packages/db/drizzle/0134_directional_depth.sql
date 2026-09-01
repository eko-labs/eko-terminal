CREATE TABLE directional_depth_runs (
  id text PRIMARY KEY,
  coin bytea NOT NULL,
  block bigint NOT NULL,
  block_hash bytea NOT NULL,
  method_version text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL
);
CREATE INDEX directional_depth_runs_coin_block ON directional_depth_runs(coin,block,acquired_at DESC);
