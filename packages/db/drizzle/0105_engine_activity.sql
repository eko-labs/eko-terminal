CREATE TABLE engine_block_times (number bigint PRIMARY KEY, ts timestamptz NOT NULL, hash bytea, source text NOT NULL);
CREATE INDEX engine_block_times_ts ON engine_block_times(ts,number);
CREATE TABLE engine_activity_state (coin bytea PRIMARY KEY, revision text NOT NULL, through_block bigint NOT NULL);
ALTER TABLE engine_reads ALTER COLUMN block_hash DROP NOT NULL;
