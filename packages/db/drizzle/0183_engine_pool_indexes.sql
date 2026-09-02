CREATE INDEX IF NOT EXISTS pools_currency0 ON pools(currency0);
CREATE INDEX IF NOT EXISTS pools_currency1 ON pools(currency1);
CREATE INDEX IF NOT EXISTS pending_pool_events_emitter_block ON pending_pool_events(emitter,block);
CREATE INDEX IF NOT EXISTS liquidity_events_pool_block ON liquidity_events(pool_id,block);
