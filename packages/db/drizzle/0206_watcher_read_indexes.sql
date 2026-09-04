-- Parent indexes cover existing and future partitions. Prebuild and attach children in production.
CREATE INDEX IF NOT EXISTS swaps_buy_wallet_first ON swaps(coin,trader,block,tx_hash,log_index) INCLUDE(pool_id) WHERE side=1 AND trader IS NOT NULL;
CREATE INDEX IF NOT EXISTS swaps_fingerprint_wallet_order ON swaps(trader,block DESC,tx_hash DESC,log_index DESC) INCLUDE(ts) WHERE NOT senders_pending;
CREATE INDEX IF NOT EXISTS swaps_unpriced_time ON swaps(ts DESC,block,tx_hash,log_index) INCLUDE(coin,quote_asset) WHERE usd IS NULL;
