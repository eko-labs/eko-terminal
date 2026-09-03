-- Production profile 2026-10-09: the retention horizon (newest indexed block older than a number of days) read every
-- chain_blocks row on each call, about 21 s and half of the sampled database time. Block times never decrease with
-- height, so the newest time below the cutoff, read from this index, is that block.
CREATE INDEX IF NOT EXISTS chain_blocks_ts ON chain_blocks(ts, number)
