CREATE TABLE IF NOT EXISTS rpc_code_cache (
  address bytea PRIMARY KEY, code bytea NOT NULL, observed_block bigint NOT NULL, block_hash bytea NOT NULL
);
-- Only launches whose mint and complete Transfer stream were acquired by live ingest can use absolute balances.
CREATE TABLE token_balance_origins (
  token bytea PRIMARY KEY, block bigint NOT NULL, block_hash bytea NOT NULL
);

CREATE TABLE IF NOT EXISTS rpc_paid_daily (
  day date PRIMARY KEY, total bigint NOT NULL, non_indexer bigint NOT NULL
);
