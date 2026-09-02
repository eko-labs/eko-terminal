-- Retention roll-up: when old transfers are compacted, each holder's net movement is kept here so balances that are
-- recomputed from transfer history (market.ts, engine holdings) stay exact. through_block is the newest compacted block.
CREATE TABLE IF NOT EXISTS transfer_baselines (
  token bytea NOT NULL, holder bytea NOT NULL, amount numeric(78,0) NOT NULL, through_block bigint NOT NULL,
  PRIMARY KEY(token, holder)
);
