-- Minute counters retain attempts that engine_runs upserts and failure snapshots cannot reconstruct.
CREATE TABLE engine_evaluation_counts (
 minute timestamptz NOT NULL, path text NOT NULL, outcome text NOT NULL,
 reason text NOT NULL, first_rating boolean NOT NULL, count bigint NOT NULL,
 -- Coin-scoped completion buckets avoid a global counter lock across concurrent rating transactions.
 coin bytea NOT NULL DEFAULT ''::bytea,
 PRIMARY KEY(minute,path,outcome,reason,first_rating,coin)
);
-- First-plan evidence distinguishes an unplanned coin from a load/write stalled after planning.
CREATE TABLE engine_first_scan_plans (
 coin bytea PRIMARY KEY, planned_at timestamptz NOT NULL DEFAULT now(),
 block bigint NOT NULL, path text NOT NULL, started_at timestamptz, sources_ready_at timestamptz
);
