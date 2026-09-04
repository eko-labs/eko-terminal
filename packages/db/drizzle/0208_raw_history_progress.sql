-- Prebuild each leaf CONCURRENTLY and attach before deploying this transactional migration.
CREATE INDEX IF NOT EXISTS token_transfers_block ON token_transfers(block);
INSERT INTO raw_history_watermarks(name,through_block) VALUES('swaps',-1),('token_transfers',-1) ON CONFLICT DO NOTHING;
-- This cursor is separate from the insert fence: updating it must not block fresh indexer inserts.
CREATE TABLE raw_history_progress(name text PRIMARY KEY,after_block bigint NOT NULL);
INSERT INTO raw_history_progress VALUES('swaps',-1),('token_transfers',-1);
-- statement-breakpoint
CREATE OR REPLACE FUNCTION raw_history_insert_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE boundary bigint;
BEGIN
 -- SHARE is compatible with other inserts. Only the short, separately committed fence advance waits for writers.
 -- A locking read observes an advance that committed while this statement was waiting (READ COMMITTED).
 SELECT through_block INTO boundary FROM raw_history_watermarks WHERE name=TG_TABLE_NAME FOR SHARE;
 IF EXISTS(SELECT 1 FROM new_rows WHERE block<=boundary) THEN
  RAISE EXCEPTION 'Insert crosses compacted raw history: use an archive';
 END IF;
 RETURN NULL;
END $$;
