CREATE TABLE IF NOT EXISTS rpc_provider_pause (
  id integer PRIMARY KEY CHECK (id=1), pause jsonb, backoff_ms bigint NOT NULL DEFAULT 10000,
  lease_token text, lease_until bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rpc_paid_refunds (
  request_id text PRIMARY KEY, day date NOT NULL
);
CREATE TABLE IF NOT EXISTS rpc_paid_refused (
  day date NOT NULL, role text NOT NULL, method text NOT NULL, calls bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(day,role,method)
);
