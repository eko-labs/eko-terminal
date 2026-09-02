-- Source mutations make old measurements unavailable until the Watcher replaces them.
CREATE FUNCTION watcher_flow_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE boundary double precision;
BEGIN
 DELETE FROM census_snapshots;
 -- Row triggers run on month partitions; the explicit source kind is stable.
 IF TG_ARGV[0]='swap' THEN
  IF TG_OP<>'DELETE' THEN INSERT INTO flow_dirty(coin,from_sec) VALUES(NEW.coin,extract(epoch FROM NEW.ts)) ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,from_sec=least(flow_dirty.from_sec,excluded.from_sec); END IF;
  IF TG_OP<>'INSERT' THEN INSERT INTO flow_dirty(coin,from_sec) VALUES(OLD.coin,extract(epoch FROM OLD.ts)) ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,from_sec=least(flow_dirty.from_sec,excluded.from_sec); END IF;
 ELSE
  IF TG_TABLE_NAME='wallet_labels' THEN SELECT extract(epoch FROM ts) INTO boundary FROM chain_blocks WHERE number=NEW.valid_from_block;
  ELSIF TG_TABLE_NAME='wallet_label_supersessions' THEN SELECT extract(epoch FROM b.ts) INTO boundary FROM wallet_labels l JOIN chain_blocks b ON b.number=l.valid_from_block WHERE l.id=NEW.replacement_id;
  ELSE boundary=extract(epoch FROM OLD.ts); END IF;
  INSERT INTO flow_dirty(coin,from_sec) SELECT DISTINCT coin,coalesce(boundary,0) FROM flow_windows ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,from_sec=least(flow_dirty.from_sec,excluded.from_sec);
 END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER watcher_flow_swap AFTER INSERT OR UPDATE OR DELETE ON swaps FOR EACH ROW EXECUTE FUNCTION watcher_flow_dirty('swap');
CREATE TRIGGER watcher_flow_label AFTER INSERT ON wallet_labels FOR EACH ROW EXECUTE FUNCTION watcher_flow_dirty();
CREATE TRIGGER watcher_flow_supersession AFTER INSERT ON wallet_label_supersessions FOR EACH ROW EXECUTE FUNCTION watcher_flow_dirty();
INSERT INTO flow_dirty(coin) SELECT DISTINCT coin FROM swaps ON CONFLICT DO NOTHING;
CREATE TRIGGER watcher_flow_chain_correction AFTER UPDATE OR DELETE ON chain_blocks FOR EACH ROW EXECUTE FUNCTION watcher_flow_dirty();
