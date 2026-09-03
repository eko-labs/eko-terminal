-- When a card was written. Day counts on the Radar header used the run's block time (sec), which is the plan's pinned
-- head block, so a long catch-up round that started yesterday showed "Scanned today: 0" all day. Existing rows stay
-- NULL and keep counting by block time
ALTER TABLE engine_runs ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE engine_runs ALTER COLUMN created_at SET DEFAULT now();
CREATE INDEX IF NOT EXISTS engine_runs_created_at ON engine_runs(created_at, coin) WHERE created_at IS NOT NULL
