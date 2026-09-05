-- Owner decision 2026-10-19: full raw rows last one day. These fields alone
-- support seven-day Census reclassification and historical fingerprint refresh.
CREATE TABLE watcher_swap_evidence (
  ts timestamptz NOT NULL, tx_hash bytea NOT NULL, log_index integer NOT NULL,
  block bigint NOT NULL, coin bytea NOT NULL, pool_id bytea NOT NULL, trader bytea,
  side smallint NOT NULL, usd double precision, priced_block bigint,
  senders_pending boolean NOT NULL, pricing_pending boolean NOT NULL,
  tx_to bytea, quote_asset bytea NOT NULL, amount_quote numeric(78,0) NOT NULL,
  PRIMARY KEY(ts,tx_hash,log_index)
);
CREATE INDEX watcher_swap_evidence_wallet_block ON watcher_swap_evidence(trader,block DESC,tx_hash DESC,log_index DESC);
CREATE INDEX watcher_swap_evidence_block ON watcher_swap_evidence(block,ts);
CREATE INDEX watcher_swap_evidence_coin_block ON watcher_swap_evidence(coin,block);
CREATE VIEW watcher_read_swaps AS
  SELECT ts,tx_hash,log_index,block,coin,pool_id,trader,side,usd,priced_block,senders_pending,pricing_pending,tx_to,quote_asset,amount_quote FROM watcher_swap_evidence
  UNION ALL
  SELECT s.ts,s.tx_hash,s.log_index,s.block,s.coin,s.pool_id,s.trader,s.side,s.usd,s.priced_block,s.senders_pending,s.pricing_pending,s.tx_to,s.quote_asset,s.amount_quote FROM raw_history_live_swaps s
  WHERE NOT EXISTS(SELECT 1 FROM watcher_swap_evidence e WHERE (e.ts,e.tx_hash,e.log_index)=(s.ts,s.tx_hash,s.log_index));
