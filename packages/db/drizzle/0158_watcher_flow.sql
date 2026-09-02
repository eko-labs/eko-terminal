CREATE TABLE flow_windows (
 coin bytea NOT NULL, window_kind text NOT NULL CHECK(window_kind IN ('5m','1h','24h')),
 block bigint NOT NULL, block_hash bytea NOT NULL, as_of timestamptz NOT NULL,
 model_version text NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(coin,window_kind)
);
CREATE TABLE flow_events (
 id text PRIMARY KEY, coin bytea NOT NULL, tx_hash bytea NOT NULL, log_index integer NOT NULL,
 block bigint NOT NULL, block_hash bytea NOT NULL, ts timestamptz NOT NULL,
 model_version text NOT NULL, data jsonb NOT NULL, UNIQUE(tx_hash,log_index)
);
CREATE INDEX flow_events_coin_time ON flow_events(coin,ts,id);
CREATE INDEX flow_events_block ON flow_events(block);
CREATE TABLE IF NOT EXISTS eval_gates (
 id text PRIMARY KEY, metric text NOT NULL CHECK(metric='likely_agent_precision'),
 model_version text NOT NULL, value double precision NOT NULL CHECK(value BETWEEN 0 AND 1),
 wilson_lower double precision NOT NULL CHECK(wilson_lower BETWEEN 0 AND 1),
 recall double precision NOT NULL CHECK(recall BETWEEN 0 AND 1), evaluated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS eval_gates_model_latest ON eval_gates(model_version,evaluated_at DESC,id DESC);
CREATE TABLE census_snapshots (
 model_version text PRIMARY KEY, block bigint NOT NULL, block_hash bytea NOT NULL,
 as_of timestamptz NOT NULL, data jsonb NOT NULL
);
CREATE TABLE flow_dirty (coin bytea PRIMARY KEY, revision bigserial NOT NULL, from_sec double precision NOT NULL DEFAULT 0);
CREATE TABLE watcher_flow_model (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), model_version text NOT NULL);
