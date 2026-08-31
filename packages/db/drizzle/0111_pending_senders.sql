ALTER TABLE swaps ALTER COLUMN trader DROP NOT NULL;
ALTER TABLE swaps ALTER COLUMN tx_from DROP NOT NULL;
ALTER TABLE swaps ALTER COLUMN tx_to DROP NOT NULL;
ALTER TABLE swaps ALTER COLUMN price_quote DROP NOT NULL;
ALTER TABLE swaps ADD COLUMN senders_pending boolean NOT NULL DEFAULT false;
ALTER TABLE liquidity_events ALTER COLUMN actor DROP NOT NULL;
ALTER TABLE liquidity_events ADD COLUMN tx_from bytea;
ALTER TABLE liquidity_events ADD COLUMN tx_to bytea;
ALTER TABLE liquidity_events ADD COLUMN senders_pending boolean NOT NULL DEFAULT false;
CREATE INDEX swaps_pending_coin ON swaps(coin,block) WHERE senders_pending;
CREATE INDEX liquidity_pending_pool ON liquidity_events(pool_id,block) WHERE senders_pending;
CREATE TABLE pending_pool_events (
  block bigint NOT NULL, tx_hash bytea NOT NULL, log_index integer NOT NULL,
  code_version text NOT NULL DEFAULT 'indexer-v1', emitter bytea NOT NULL, currency_hints jsonb NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(tx_hash,log_index)
);
CREATE INDEX pending_pool_hints ON pending_pool_events USING gin(currency_hints);
