-- Marking a coin's flow as dirty ran once per swap row (0159): each row deleted every census snapshot and upserted one
-- flow_dirty row, in the order the rows arrived. A wallet label marks every coin dirty in one statement, in whatever
-- order the table returned them. Two transactions taking the same flow_dirty rows in different orders deadlock: 74
-- times in three days on the box, and each time the database picked the indexer it halted and restarted (2026-10-13).
-- Swaps now mark their coins once per statement, and both statements take the rows in coin order, so one waits for
-- the other instead. Results are the same: each coin's earliest affected time, and its revision moved.
DROP TRIGGER watcher_flow_swap ON swaps
-- statement-breakpoint
CREATE FUNCTION watcher_flow_dirty_swaps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- A statement that changed no row changes nothing here either.
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM new_rows) THEN RETURN NULL; END IF;
  DELETE FROM census_snapshots;
  INSERT INTO flow_dirty(coin,from_sec) SELECT coin,min(extract(epoch FROM ts)) FROM new_rows GROUP BY coin ORDER BY coin
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,from_sec=least(flow_dirty.from_sec,excluded.from_sec);
 ELSIF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM old_rows) THEN RETURN NULL; END IF;
  DELETE FROM census_snapshots;
  INSERT INTO flow_dirty(coin,from_sec) SELECT coin,min(extract(epoch FROM ts)) FROM old_rows GROUP BY coin ORDER BY coin
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,from_sec=least(flow_dirty.from_sec,excluded.from_sec);
 ELSE
  IF NOT EXISTS(SELECT 1 FROM new_rows) THEN RETURN NULL; END IF;
  DELETE FROM census_snapshots;
  INSERT INTO flow_dirty(coin,from_sec) SELECT coin,min(extract(epoch FROM ts)) FROM (SELECT coin,ts FROM new_rows UNION ALL SELECT coin,ts FROM old_rows) r GROUP BY coin ORDER BY coin
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,from_sec=least(flow_dirty.from_sec,excluded.from_sec);
 END IF;
 RETURN NULL;
END $$
-- statement-breakpoint
CREATE TRIGGER watcher_flow_swap_insert AFTER INSERT ON swaps REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION watcher_flow_dirty_swaps()
-- statement-breakpoint
CREATE TRIGGER watcher_flow_swap_update AFTER UPDATE ON swaps REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION watcher_flow_dirty_swaps()
-- statement-breakpoint
CREATE TRIGGER watcher_flow_swap_delete AFTER DELETE ON swaps REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION watcher_flow_dirty_swaps()
-- statement-breakpoint
-- Labels, supersessions and corrected blocks mark every measured coin, in coin order.
CREATE FUNCTION watcher_flow_dirty_all() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE boundary double precision;
BEGIN
 DELETE FROM census_snapshots;
 IF TG_TABLE_NAME='wallet_labels' THEN SELECT extract(epoch FROM ts) INTO boundary FROM chain_blocks WHERE number=NEW.valid_from_block;
 ELSIF TG_TABLE_NAME='wallet_label_supersessions' THEN SELECT extract(epoch FROM b.ts) INTO boundary FROM wallet_labels l JOIN chain_blocks b ON b.number=l.valid_from_block WHERE l.id=NEW.replacement_id;
 ELSE boundary=extract(epoch FROM OLD.ts); END IF;
 INSERT INTO flow_dirty(coin,from_sec) SELECT w.coin,coalesce(boundary,0) FROM (SELECT DISTINCT coin FROM flow_windows) w ORDER BY w.coin
 ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,from_sec=least(flow_dirty.from_sec,excluded.from_sec);
 RETURN NULL;
END $$
-- statement-breakpoint
DROP TRIGGER watcher_flow_label ON wallet_labels
-- statement-breakpoint
CREATE TRIGGER watcher_flow_label AFTER INSERT ON wallet_labels FOR EACH ROW EXECUTE FUNCTION watcher_flow_dirty_all()
-- statement-breakpoint
DROP TRIGGER watcher_flow_supersession ON wallet_label_supersessions
-- statement-breakpoint
CREATE TRIGGER watcher_flow_supersession AFTER INSERT ON wallet_label_supersessions FOR EACH ROW EXECUTE FUNCTION watcher_flow_dirty_all()
-- statement-breakpoint
DROP TRIGGER watcher_flow_chain_correction ON chain_blocks
-- statement-breakpoint
CREATE TRIGGER watcher_flow_chain_correction AFTER UPDATE OR DELETE ON chain_blocks FOR EACH ROW EXECUTE FUNCTION watcher_flow_dirty_all()
-- statement-breakpoint
DROP FUNCTION watcher_flow_dirty()
