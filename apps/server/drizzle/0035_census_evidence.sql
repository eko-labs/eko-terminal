-- API migrations run before engine migrations on fresh databases. Retain task 102's
-- base table shape so either role can create it first without losing existing rows.
CREATE TABLE IF NOT EXISTS eval_gates (
 id text PRIMARY KEY, metric text NOT NULL CHECK(metric='likely_agent_precision'),
 model_version text NOT NULL, value double precision NOT NULL CHECK(value BETWEEN 0 AND 1),
 wilson_lower double precision NOT NULL CHECK(wilson_lower BETWEEN 0 AND 1),
 recall double precision NOT NULL CHECK(recall BETWEEN 0 AND 1), evaluated_at timestamptz NOT NULL
);
--> statement-breakpoint
ALTER TABLE eval_gates ADD COLUMN expires_at timestamptz,
 ADD COLUMN model_hash text CHECK(model_hash ~ '^[a-f0-9]{64}$'),
 ADD COLUMN dataset_hash text CHECK(dataset_hash ~ '^[a-f0-9]{64}$'),
 ADD COLUMN evidence jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS eval_gates_model_latest ON eval_gates(model_version,evaluated_at DESC,id DESC);
