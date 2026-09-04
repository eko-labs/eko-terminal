-- A cursor and all summaries for its coin prefix commit together. Never clear a pending fence.
CREATE TABLE raw_history_seal_days (
 name text NOT NULL, partition_name text NOT NULL, day timestamptz NOT NULL, end_ts timestamptz NOT NULL,
 last_coin bytea, coins bigint NOT NULL DEFAULT 0, rows bigint NOT NULL DEFAULT 0,
 through_block bigint NOT NULL DEFAULT -1, complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(name,partition_name,day),
 FOREIGN KEY(name,partition_name) REFERENCES raw_history_seals(name,partition_name),
 CHECK(day<end_ts)
);
-- statement-breakpoint
CREATE OR REPLACE VIEW raw_history_live_swaps AS SELECT s.* FROM swaps s WHERE NOT EXISTS(
 SELECT 1 FROM raw_history_seals r WHERE r.name='swaps' AND r.sealed AND NOT r.dropped AND s.ts>=r.start_ts AND s.ts<r.end_ts
) AND NOT EXISTS(
 SELECT 1 FROM raw_history_seal_days d WHERE d.name='swaps' AND s.ts>=d.day AND s.ts<d.end_ts AND s.coin<=d.last_coin
);
CREATE OR REPLACE VIEW raw_history_live_transfers AS SELECT t.* FROM token_transfers t WHERE NOT EXISTS(
 SELECT 1 FROM raw_history_seals r WHERE r.name='token_transfers' AND r.sealed AND NOT r.dropped AND t.ts>=r.start_ts AND t.ts<r.end_ts
) AND NOT EXISTS(
 SELECT 1 FROM raw_history_seal_days d WHERE d.name='token_transfers' AND t.ts>=d.day AND t.ts<d.end_ts AND t.token<=d.last_coin
);
