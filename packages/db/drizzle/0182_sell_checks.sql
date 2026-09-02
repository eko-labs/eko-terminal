-- Live sell checks (BACKEND 6.2, eth_call probe). Engines write the readings, the API reads them and records quote refusals.
-- One current reading per coin: the read model joins it, and its changes mark the coin dirty for live pushes.
-- checked_at/block describe the reading, and attempted_at/attempt_status the last try, which can be a provider
-- failure that keeps the earlier reading of the same route.
CREATE TABLE sell_check_latest (
 coin bytea PRIMARY KEY,
 block bigint NOT NULL,
 checked_at timestamptz NOT NULL,
 activity_at timestamptz,
 venue text,
 route_id text,
 status text NOT NULL CHECK (status IN ('sellable','refused','buy_failed','unavailable','unsupported')),
 exit_cost_100_pct double precision,
 exit_cost_1k_pct double precision,
 method_version text NOT NULL,
 data jsonb NOT NULL,
 attempted_at timestamptz NOT NULL,
 attempt_status text NOT NULL CHECK (attempt_status IN ('sellable','refused','buy_failed','unavailable','unsupported'))
);
CREATE INDEX sell_check_latest_attempted ON sell_check_latest(attempted_at);
-- Every check, kept 30 days as evidence and for the daily request cap.
CREATE TABLE sell_check_runs (
 id bigserial PRIMARY KEY,
 coin bytea NOT NULL,
 block bigint NOT NULL,
 checked_at timestamptz NOT NULL,
 status text NOT NULL,
 requests integer NOT NULL CHECK (requests >= 0),
 data jsonb NOT NULL
);
CREATE INDEX sell_check_runs_checked ON sell_check_runs(checked_at);
CREATE INDEX sell_check_runs_coin ON sell_check_runs(coin,id DESC);
-- Buy quotes the guard refused because the sell check failed at the quoted size. No account, wallet or session is kept.
CREATE TABLE sell_check_refusals (
 id bigserial PRIMARY KEY,
 coin bytea NOT NULL,
 refused_at timestamptz NOT NULL,
 block bigint NOT NULL,
 data jsonb NOT NULL
);
CREATE INDEX sell_check_refusals_time ON sell_check_refusals(refused_at);
CREATE TRIGGER read_sell_check_insert AFTER INSERT ON sell_check_latest REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_sell_check_update AFTER UPDATE ON sell_check_latest REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty()
