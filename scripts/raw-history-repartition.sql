-- Load with psql -X -v ON_ERROR_STOP=1 -f scripts/raw-history-repartition.sql.
-- Operator helpers only. Loading this file never detaches or deletes history.
-- Session settings: eko.days_ahead (DAYS_AHEAD, default 3), eko.reorg_tail (REORG_TAIL, default 300).
SET statement_timeout='300s';
-- statement-breakpoint
SET lock_timeout='10s';
-- statement-breakpoint
SET TIME ZONE 'UTC';
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS raw_history_repartition_days (
 name text NOT NULL, day timestamptz NOT NULL, copied boolean NOT NULL DEFAULT false,
 high_block bigint NOT NULL DEFAULT -1, PRIMARY KEY(name,day)
);
-- statement-breakpoint
ALTER TABLE raw_history_repartition_days ADD COLUMN IF NOT EXISTS high_block bigint NOT NULL DEFAULT -1;
-- statement-breakpoint
DROP FUNCTION IF EXISTS raw_history_repartition_prepare(text),raw_history_repartition_drain(text),
 raw_history_repartition_detach(text),raw_history_repartition_attach(text);

-- 1. Persist/extend the fixed seal cutoff through today plus the configured lookahead.
-- statement-breakpoint
CREATE OR REPLACE FUNCTION raw_history_repartition_plan(t text,
 days_ahead integer DEFAULT coalesce(nullif(current_setting('eko.days_ahead',true),''),'3')::integer)
 RETURNS void LANGUAGE plpgsql AS $$
DECLARE cutoff timestamptz; last_day timestamptz; source text;
BEGIN
 IF t NOT IN ('swaps','token_transfers') OR days_ahead IS NULL OR days_ahead<0 OR days_ahead>366 THEN RAISE EXCEPTION 'Invalid plan'; END IF;
 IF NOT pg_try_advisory_xact_lock(4663,208) THEN RAISE EXCEPTION 'Raw mutex is busy' USING ERRCODE='55P03'; END IF;
 source:=t||'_2026_10';
 SELECT end_ts INTO STRICT cutoff FROM raw_history_seals WHERE name=t AND partition_name=source AND sealed;
 IF to_regclass(source) IS NULL THEN RETURN; END IF;
 EXECUTE format('SELECT ts FROM %I ORDER BY ts DESC LIMIT 1',source) INTO last_day;
 last_day:=greatest(date_trunc('day',last_day AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
  (date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+days_ahead*interval '1 day');
 INSERT INTO raw_history_repartition_days(name,day)
 SELECT t,d FROM generate_series(date_trunc('day',cutoff AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',last_day,interval '1 day')d ON CONFLICT DO NOTHING;
END $$;

-- 2. One resumable transaction per day. The monthly source stays attached throughout.
-- Indexes (expressions, INCLUDE columns, predicates and uniqueness) come from the parent catalog.
-- statement-breakpoint
CREATE OR REPLACE FUNCTION raw_history_repartition_copy(t text,d timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE leaf text; source text; cutoff timestamptz; x record; idx text; already boolean; high bigint;
BEGIN
 IF t NOT IN ('swaps','token_transfers') OR d IS NULL OR d<>(date_trunc('day',d AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN RAISE EXCEPTION 'Invalid day'; END IF;
 IF NOT pg_try_advisory_xact_lock(4663,208) THEN RAISE EXCEPTION 'Raw mutex is busy' USING ERRCODE='55P03'; END IF;
 PERFORM set_config('lock_timeout','10s',true);
 SELECT copied INTO STRICT already FROM raw_history_repartition_days WHERE name=t AND day=d FOR UPDATE;
 IF already THEN RETURN; END IF;
 source:=t||'_2026_10';leaf:=t||'_d'||to_char(d AT TIME ZONE 'UTC','YYYY_MM_DD');
 SELECT end_ts INTO STRICT cutoff FROM raw_history_seals WHERE name=t AND partition_name=source AND sealed;
 IF NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=to_regclass(source) AND inhparent=t::regclass) THEN RAISE EXCEPTION 'Monthly source must still be attached'; END IF;
 -- Outside October, ensurePartitions may already have provisioned an authoritative daily partition.
 IF EXISTS(SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent=t::regclass
  AND c.oid=to_regclass(leaf) AND pg_get_expr(c.relpartbound,c.oid)=format('FOR VALUES FROM (%L) TO (%L)',d,d+interval '1 day')) THEN
  UPDATE raw_history_repartition_days SET copied=true,high_block=-1 WHERE name=t AND day=d;
  RETURN;
 END IF;
 IF to_regclass(leaf) IS NOT NULL THEN RAISE EXCEPTION 'Unplanned existing day table: inspect it before proceeding'; END IF;
 EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING ALL EXCLUDING INDEXES)',leaf,t);
 EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (ts >= %L::timestamptz AND ts < %L::timestamptz)',leaf,leaf||'_bounds',d,d+interval '1 day');
 EXECUTE format('INSERT INTO %I SELECT * FROM %I WHERE ts >= greatest($1,$3) AND ts < $2',leaf,source) USING d,d+interval '1 day',cutoff;
 -- Measure the rows actually copied, never a later snapshot of the moving source.
 EXECUTE format('SELECT coalesce(max(block),-1) FROM %I',leaf) INTO high;
 FOR x IN SELECT i.indexrelid,i.indisunique,i.indisprimary,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i WHERE i.indrelid=t::regclass ORDER BY i.indexrelid LOOP
  idx:=leaf||'_'||substr(md5(x.indexrelid::text),1,8);
  EXECUTE format('CREATE %s INDEX %I ON %I %s',CASE WHEN x.indisunique THEN 'UNIQUE' ELSE '' END,idx,leaf,substring(x.definition FROM 'USING .*'));
  -- ATTACH requires the constraint as well as an equivalent unique index for a parent primary key.
  IF x.indisprimary THEN EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY USING INDEX %I',leaf,leaf||'_pkey',idx); END IF;
 END LOOP;
 -- Transfers have no parent block-leading index; both sides need one for bounded reorg repair.
 IF t='token_transfers' THEN EXECUTE format('CREATE INDEX %I ON %I(block,ts)',leaf||'_repartition_block',leaf); END IF;
 EXECUTE format('ANALYZE %I',leaf);
 UPDATE raw_history_repartition_days SET copied=true,high_block=high WHERE name=t AND day=d;
END $$;

-- 3. ONE transaction per table: lock, detach, bounded catch-up, attach. Any error rolls it ALL back.
-- Call as a standalone SELECT (autocommit). The function cannot commit partway through.
-- statement-breakpoint
CREATE OR REPLACE FUNCTION raw_history_repartition_cutover(t text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; leaf text; source text; cutoff timestamptz; high bigint; tail_start bigint;
 days_ahead integer:=coalesce(nullif(current_setting('eko.days_ahead',true),''),'3')::integer;
 reorg_tail integer:=coalesce(nullif(current_setting('eko.reorg_tail',true),''),'300')::integer;
 cols text; vals text;
BEGIN
 IF t NOT IN ('swaps','token_transfers') OR days_ahead<0 OR days_ahead>366 OR reorg_tail<1 THEN RAISE EXCEPTION 'Invalid cutover settings'; END IF;
 IF NOT pg_try_advisory_xact_lock(4663,208) THEN RAISE EXCEPTION 'Raw mutex is busy' USING ERRCODE='55P03'; END IF;
 PERFORM set_config('lock_timeout','10s',true);
 source:=t||'_2026_10';
 SELECT end_ts INTO STRICT cutoff FROM raw_history_seals WHERE name=t AND partition_name=source AND sealed;
 -- Metadata-only checks; no raw heap scan is permitted in this transaction.
 IF NOT EXISTS(SELECT 1 FROM raw_history_repartition_days WHERE name=t) OR EXISTS(
  SELECT 1 FROM generate_series(date_trunc('day',cutoff AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
   (date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+days_ahead*interval '1 day',interval '1 day')d
  WHERE NOT EXISTS(SELECT 1 FROM raw_history_repartition_days p WHERE p.name=t AND p.day=d AND p.copied))
  OR EXISTS(SELECT 1 FROM raw_history_repartition_days WHERE name=t AND NOT copied)
 THEN RAISE EXCEPTION 'Extend plan through today plus DAYS_AHEAD and finish all copies first'; END IF;
 -- A committed cutover is a no-op, including after source cleanup; reject an unexpected detached source.
 IF NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=to_regclass(source) AND inhparent=t::regclass) THEN
  IF EXISTS(SELECT 1 FROM raw_history_repartition_days p WHERE p.name=t AND NOT EXISTS(
   SELECT 1 FROM pg_inherits WHERE inhparent=t::regclass AND inhrelid=to_regclass(t||'_d'||to_char(p.day AT TIME ZONE 'UTC','YYYY_MM_DD'))))
  THEN RAISE EXCEPTION 'Source unexpectedly detached; inspect before proceeding'; END IF;
  RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am a ON a.oid=c.relam
  JOIN pg_attribute b ON b.attrelid=i.indrelid AND b.attname='block'
  WHERE i.indrelid=to_regclass(source) AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND a.amname='btree' AND i.indkey[0]=b.attnum)
 THEN RAISE EXCEPTION 'Build the monthly block index concurrently before cutover'; END IF;
 SELECT max(high_block) INTO high FROM raw_history_repartition_days WHERE name=t;
 tail_start:=greatest(0,high-reorg_tail+1);
 SELECT string_agg(format('%I',attname),',' ORDER BY attnum),string_agg(format('excluded.%I',attname),',' ORDER BY attnum)
 INTO cols,vals FROM pg_attribute WHERE attrelid=t::regclass AND attnum>0 AND NOT attisdropped;
 -- Favor block ranges / partial indexes even for tiny test fixtures; prohibit hash/merge heap joins.
 PERFORM set_config('enable_seqscan','off',true);
 PERFORM set_config('enable_hashjoin','off',true);PERFORM set_config('enable_mergejoin','off',true);
 EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE',t);
 EXECUTE format('ALTER TABLE %I DETACH PARTITION %I',t,source);
 FOR r IN SELECT day,high_block FROM raw_history_repartition_days WHERE name=t ORDER BY day LOOP
  leaf:=t||'_d'||to_char(r.day AT TIME ZONE 'UTC','YYYY_MM_DD');
  IF EXISTS(SELECT 1 FROM pg_inherits WHERE inhparent=t::regclass AND inhrelid=to_regclass(leaf)) THEN CONTINUE; END IF;
  -- (a) Block-leading source index, time bounds enforce the leaf CHECK and fixed kept cutoff.
  EXECUTE format('INSERT INTO %I SELECT * FROM %I WHERE block>$1 AND ts>=greatest($2,$4) AND ts<$3 ON CONFLICT DO NOTHING',leaf,source)
   USING r.high_block,r.day,r.day+interval '1 day',cutoff;
  -- (b) Leaf partial indexes enumerate pending keys, then parameterized source PK probes re-read ALL columns.
  -- OFFSET 0 keeps the source lookup lateral (one index probe per key), rather than a whole-source join.
  IF t='swaps' THEN
   EXECUTE format('INSERT INTO %I AS dst SELECT s.* FROM (
    SELECT ts,tx_hash,log_index FROM %I WHERE senders_pending UNION SELECT ts,tx_hash,log_index FROM %I WHERE pricing_pending) p
    CROSS JOIN LATERAL(SELECT * FROM %I m WHERE m.ts=p.ts AND m.tx_hash=p.tx_hash AND m.log_index=p.log_index OFFSET 0)s
    ON CONFLICT(ts,tx_hash,log_index) DO UPDATE SET (%s)=(%s) WHERE dst.* IS DISTINCT FROM excluded.*',leaf,leaf,leaf,source,cols,vals);
  END IF;
  -- (c) Rebuild the last REORG_TAIL blocks of the TABLE-wide copied high, across day boundaries.
  -- Deleted/replaced events and late events within this range must exactly match the source.
  EXECUTE format('DELETE FROM %I WHERE block >= $1 AND block <= $2',leaf) USING tail_start,high;
  EXECUTE format('INSERT INTO %I SELECT * FROM %I WHERE block >= $1 AND block <= $2 AND ts>=greatest($3,$5) AND ts<$4 ON CONFLICT DO NOTHING',leaf,source)
   USING tail_start,high,r.day,r.day+interval '1 day',cutoff;
  -- Validated per-day CHECK and equivalent prebuilt indexes avoid heap validation / index builds here.
  EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',t,leaf,r.day,r.day+interval '1 day');
 END LOOP;
END $$;

-- 4. Reclaim detached original files only after every kept day is attached.
-- statement-breakpoint
CREATE OR REPLACE FUNCTION raw_history_repartition_drop(t text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source text;
BEGIN
 IF t NOT IN ('swaps','token_transfers') THEN RAISE EXCEPTION 'Invalid raw table'; END IF;
 IF NOT pg_try_advisory_xact_lock(4663,208) THEN RAISE EXCEPTION 'Raw mutex is busy' USING ERRCODE='55P03'; END IF;
 PERFORM set_config('lock_timeout','10s',true);source:=t||'_2026_10';
 IF NOT EXISTS(SELECT 1 FROM raw_history_repartition_days WHERE name=t) OR EXISTS(
  SELECT 1 FROM raw_history_repartition_days d WHERE name=t AND (NOT copied OR NOT EXISTS(
   SELECT 1 FROM pg_inherits WHERE inhparent=t::regclass AND inhrelid=to_regclass(t||'_d'||to_char(d.day AT TIME ZONE 'UTC','YYYY_MM_DD')))))
 THEN RAISE EXCEPTION 'Attach every planned day first'; END IF;
 IF EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=to_regclass(source)) THEN RAISE EXCEPTION 'Source is still attached'; END IF;
 EXECUTE format('DROP TABLE IF EXISTS %I',source);
 UPDATE raw_history_seals SET dropped=true WHERE name=t AND partition_name=source AND sealed;
END $$;

-- 5. Advance the discarded-prefix block fence after drop; verify the configured future coverage.
-- statement-breakpoint
CREATE OR REPLACE FUNCTION raw_history_repartition_finish(t text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; days_ahead integer:=coalesce(nullif(current_setting('eko.days_ahead',true),''),'3')::integer;
BEGIN
 IF t NOT IN ('swaps','token_transfers') OR days_ahead IS NULL OR days_ahead<0 OR days_ahead>366 THEN RAISE EXCEPTION 'Invalid finish settings'; END IF;
 IF NOT pg_try_advisory_xact_lock(4663,208) THEN RAISE EXCEPTION 'Raw mutex is busy' USING ERRCODE='55P03'; END IF;
 PERFORM set_config('lock_timeout','10s',true);
 IF NOT EXISTS(SELECT 1 FROM raw_history_seals WHERE name=t AND partition_name=t||'_2026_10' AND sealed AND dropped) THEN RAISE EXCEPTION 'Drop source first'; END IF;
 FOR r IN SELECT generate_series(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
  (date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+days_ahead*interval '1 day',interval '1 day') AS day LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhparent=t::regclass AND inhrelid=to_regclass(t||'_d'||to_char(r.day AT TIME ZONE 'UTC','YYYY_MM_DD'))) THEN RAISE EXCEPTION 'Run ensurePartitions for today plus DAYS_AHEAD first'; END IF;
 END LOOP;
 UPDATE raw_history_watermarks SET through_block=greatest(through_block,(SELECT through_block FROM raw_history_seals WHERE name=t AND partition_name=t||'_2026_10')) WHERE name=t;
END $$;
