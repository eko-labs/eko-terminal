-- Production profile 2026-10-08: two queries held the database disk most of the time.
-- 1. The indexer ETH/USD reference lookup (latest swap on one pool at or before a block) had no pool index and
--    walked the coin swaps backwards.
-- 2. The engines clock refresh re-read whole tables every poll. It now reads only new blocks, which needs block
--    lookups on these two tables (swaps already has (block, ts), and transfers are bounded by their time key).
CREATE INDEX IF NOT EXISTS swaps_pool_block ON swaps(pool_id, block);
CREATE INDEX IF NOT EXISTS pons_events_block ON pons_events(block);
CREATE INDEX IF NOT EXISTS liquidity_events_block ON liquidity_events(block);
