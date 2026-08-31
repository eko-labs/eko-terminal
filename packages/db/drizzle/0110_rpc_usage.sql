CREATE TABLE IF NOT EXISTS rpc_usage (
  day date NOT NULL,
  provider text NOT NULL CHECK (provider IN ('paid','public')),
  method text NOT NULL,
  calls bigint NOT NULL DEFAULT 0,
  units double precision NOT NULL DEFAULT 0,
  PRIMARY KEY(day,provider,method)
);
