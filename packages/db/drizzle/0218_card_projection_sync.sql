-- Card writers need the compact coin projection immediately for engine candidate selection.
-- Provision mutex keys with token writes so the card trigger can try existing keys without inserting or waiting.
CREATE FUNCTION read_token_projection_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO read_projection_locks(coin) SELECT DISTINCT address FROM new_rows ORDER BY address ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_00_token_projection_keys_insert AFTER INSERT ON tokens REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_token_projection_keys();
CREATE TRIGGER read_00_token_projection_keys_update AFTER UPDATE ON tokens REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_token_projection_keys();
-- statement-breakpoint
DO $$
DECLARE last_coin bytea=''::bytea; batch bytea[];
BEGIN
 LOOP
  SELECT array_agg(address ORDER BY address) INTO batch FROM (SELECT address FROM tokens WHERE address>last_coin ORDER BY address LIMIT 500) page;
  EXIT WHEN batch IS NULL;
  INSERT INTO read_projection_locks(coin) SELECT unnest(batch) ON CONFLICT DO NOTHING;
  last_coin=batch[array_length(batch,1)];
 END LOOP;
END $$;
-- statement-breakpoint
-- Never wait for a projection mutex from a source-row trigger. Grouped engine writes may arrive in any coin order.
-- The existing statement-level dirty triggers always enqueue every coin, including ones skipped here.
CREATE OR REPLACE FUNCTION read_card_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c bytea;
BEGIN
 c=CASE WHEN TG_OP='DELETE' THEN OLD.coin ELSE NEW.coin END;
 PERFORM coin FROM read_projection_locks WHERE coin=c FOR UPDATE SKIP LOCKED;
 IF FOUND THEN PERFORM refresh_read_coin(c); END IF;
 RETURN NULL;
END $$;
