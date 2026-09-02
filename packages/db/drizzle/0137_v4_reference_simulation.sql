-- Normalizer-only evidence. Quote/probe acquisition never grants executable status.
CREATE TABLE v4_reference_runs (
  id text PRIMARY KEY,
  coin bytea NOT NULL,
  block bigint NOT NULL,
  block_hash bytea NOT NULL,
  pool_id bytea NOT NULL,
  size_usd integer NOT NULL CHECK (size_usd IN (100,1000,10000)),
  route_id text NOT NULL,
  method_version text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL,
  trace_digest text NOT NULL,
  trace jsonb,
  trace_expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  CHECK (data->'route'->>'executable' = 'false')
);
CREATE INDEX v4_reference_coin_block ON v4_reference_runs(coin,block,block_hash,acquired_at DESC);
CREATE INDEX v4_reference_trace_expiry ON v4_reference_runs(trace_expires_at) WHERE trace IS NOT NULL;
