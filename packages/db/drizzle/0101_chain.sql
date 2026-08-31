CREATE TABLE chain_blocks (number bigint PRIMARY KEY, block bigint NOT NULL, hash bytea NOT NULL, parent_hash bytea NOT NULL, ts timestamptz NOT NULL, CHECK(number = block));
CREATE TABLE ingest_cursors (stream text PRIMARY KEY, block bigint NOT NULL, hash bytea);
CREATE TABLE ingest_ranges (
  stream text NOT NULL, from_block bigint NOT NULL, to_block bigint NOT NULL,
  status text NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','leased','done','failed')),
  lease_owner text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY(stream, from_block), CHECK(from_block <= to_block)
);
CREATE TABLE tokens (
  address bytea PRIMARY KEY, symbol text, name text, decimals integer CHECK(decimals BETWEEN 0 AND 255), launchpad text, deployer bytea, curve bytea UNIQUE,
  first_block bigint NOT NULL, block bigint NOT NULL, code_version text NOT NULL DEFAULT 'indexer-v1'
);
CREATE TABLE pools (
  id bytea PRIMARY KEY, venue text NOT NULL, currency0 bytea NOT NULL, currency1 bytea NOT NULL, fee integer NOT NULL, tick_spacing integer NOT NULL, hooks bytea,
  created_block bigint NOT NULL, block bigint NOT NULL, code_version text NOT NULL DEFAULT 'indexer-v1'
);
CREATE TABLE swaps (
  ts timestamptz NOT NULL, block bigint NOT NULL, tx_hash bytea NOT NULL, log_index integer NOT NULL,
  venue text NOT NULL, pool_id bytea NOT NULL, coin bytea NOT NULL, quote_asset bytea NOT NULL,
  trader bytea NOT NULL, tx_from bytea NOT NULL, tx_to bytea NOT NULL, recipient bytea, side smallint NOT NULL CHECK(side IN (1,-1)),
  amount_coin numeric(78,0) NOT NULL, amount_quote numeric(78,0) NOT NULL, price_quote double precision NOT NULL, usd double precision, priced_block bigint,
  code_version text NOT NULL DEFAULT 'indexer-v1', PRIMARY KEY(ts, tx_hash, log_index)
) PARTITION BY RANGE(ts);
CREATE INDEX swaps_coin_block ON swaps(coin, block);
CREATE INDEX swaps_trader_block ON swaps(trader, block);
CREATE TABLE liquidity_events (
  block bigint NOT NULL, tx_hash bytea NOT NULL, log_index integer NOT NULL, ts timestamptz NOT NULL,
  venue text NOT NULL, pool_id bytea NOT NULL, kind text NOT NULL, actor bytea NOT NULL, data jsonb NOT NULL,
  code_version text NOT NULL DEFAULT 'indexer-v1', PRIMARY KEY(tx_hash, log_index)
);
CREATE TABLE token_transfers (
  ts timestamptz NOT NULL, block bigint NOT NULL, tx_hash bytea NOT NULL, log_index integer NOT NULL, token bytea NOT NULL,
  from_address bytea NOT NULL, to_address bytea NOT NULL, amount numeric(78,0) NOT NULL, kind text NOT NULL DEFAULT 'Transfer',
  code_version text NOT NULL DEFAULT 'indexer-v1', PRIMARY KEY(ts, tx_hash, log_index)
) PARTITION BY RANGE(ts);
CREATE INDEX token_transfers_token_block ON token_transfers(token, block);
CREATE TABLE pons_events (
  block bigint NOT NULL, tx_hash bytea NOT NULL, log_index integer NOT NULL, token bytea NOT NULL, emitter bytea NOT NULL, kind text NOT NULL, data jsonb NOT NULL,
  code_version text NOT NULL DEFAULT 'indexer-v1', PRIMARY KEY(tx_hash, log_index)
);
CREATE TABLE pons_exemptions (
  token bytea NOT NULL, wallet bytea NOT NULL, block bigint NOT NULL, tx_hash bytea NOT NULL, log_index integer NOT NULL,
  code_version text NOT NULL DEFAULT 'indexer-v1', PRIMARY KEY(token, wallet)
);
CREATE TABLE wallets (address bytea PRIMARY KEY, block bigint NOT NULL, code_version text NOT NULL DEFAULT 'indexer-v1');
