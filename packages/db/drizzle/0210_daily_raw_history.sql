-- Empty legacy siblings only. A populated sibling must remain attached for operator migration.
DO $$ DECLARE t text; p text; occupied boolean; BEGIN
 PERFORM set_config('lock_timeout','5s',true);
 FOREACH t IN ARRAY ARRAY['swaps','token_transfers'] LOOP
  FOREACH p IN ARRAY ARRAY['2026_05','2026_06','2026_07','2026_11','2026_12'] LOOP
   IF to_regclass(t||'_'||p) IS NOT NULL THEN
    EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE',t||'_'||p);
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I LIMIT 1)',t||'_'||p) INTO occupied;
    IF NOT occupied THEN EXECUTE format('DROP TABLE %I',t||'_'||p); END IF;
   END IF;
  END LOOP;
 END LOOP;
END $$;
-- statement-breakpoint
DROP TABLE raw_history_progress;
CREATE TABLE raw_history_seals (
 name text NOT NULL CHECK(name IN ('swaps','token_transfers')), partition_name text NOT NULL,
 start_ts timestamptz NOT NULL, end_ts timestamptz NOT NULL,
 sealed boolean NOT NULL DEFAULT false, rows bigint NOT NULL, through_block bigint NOT NULL, dropped boolean NOT NULL DEFAULT false,
 PRIMARY KEY(name,partition_name), CHECK(start_ts<end_ts)
);
-- statement-breakpoint
CREATE OR REPLACE FUNCTION raw_history_insert_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE boundary bigint;
BEGIN
 SELECT through_block INTO boundary FROM raw_history_watermarks WHERE name=TG_TABLE_NAME FOR SHARE;
 IF EXISTS(SELECT 1 FROM new_rows WHERE block<=boundary) OR EXISTS(
  SELECT 1 FROM raw_history_seals s JOIN new_rows n ON n.ts>=s.start_ts AND n.ts<s.end_ts WHERE s.name=TG_TABLE_NAME
 ) THEN RAISE EXCEPTION 'Insert crosses compacted raw history: use an archive'; END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
-- Mutation fencing and reorg exclusion cover the seal -> detach -> drop -> watermark crash gaps.
CREATE FUNCTION raw_history_mutation_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM through_block FROM raw_history_watermarks WHERE name=TG_TABLE_NAME FOR SHARE;
 IF EXISTS(SELECT 1 FROM raw_history_seals s JOIN old_rows n ON n.ts>=s.start_ts AND n.ts<s.end_ts WHERE s.name=TG_TABLE_NAME)
 THEN RAISE EXCEPTION 'Mutation crosses sealed raw history: use an archive'; END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER raw_history_swap_update AFTER UPDATE ON swaps REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION raw_history_mutation_boundary();
CREATE TRIGGER raw_history_swap_delete AFTER DELETE ON swaps REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION raw_history_mutation_boundary();
CREATE TRIGGER raw_history_transfer_update AFTER UPDATE ON token_transfers REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION raw_history_mutation_boundary();
CREATE TRIGGER raw_history_transfer_delete AFTER DELETE ON token_transfers REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION raw_history_mutation_boundary();
-- statement-breakpoint
-- Ordered fold equivalent to addLifetimeSwaps; no event crosses the application/database boundary.
CREATE FUNCTION raw_history_add(s jsonb,p text[],v double precision) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_set(s,p,to_jsonb(coalesce((s#>>p)::double precision,0)+v),true)
$$;
-- statement-breakpoint
CREATE FUNCTION raw_history_lifetime_step(s jsonb,r jsonb,base jsonb,id jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE amount double precision; usd double precision; sec double precision; actor text; buyer text; pool text;
 attributed boolean; early boolean; e jsonb; a jsonb; g jsonb; k text; refs jsonb;
BEGIN
 s:=coalesce(s,base); amount:=(r->>'amount_coin')::double precision; usd:=(r->>'usd')::double precision;
 sec:=extract(epoch FROM (r->>'ts')::timestamptz);actor:=r->>'trader';pool:=r->>'pool_id';
 attributed:=actor IS NOT NULL AND NOT coalesce((r->>'senders_pending')::boolean,false);
 early:=(r->>'block')::bigint>=(id->>'firstBlock')::bigint AND
  ((r->>'block')::bigint-(id->>'firstBlock')::bigint<(id->>'firstBlocks')::integer OR sec-(id->>'createdSec')::double precision<(id->>'cohortSec')::integer);
 g:=s->'graduation';
 IF g IS NOT NULL AND sec>(g->>'atSec')::double precision-0.001 AND sec<=(g->>'atSec')::double precision+300 THEN
  g:=raw_history_add(raw_history_add(g,ARRAY['count'],1),ARRAY['volume'],coalesce(usd,0));
  IF NOT attributed THEN
   g:=raw_history_add(raw_history_add(g,ARRAY['missing'],1),ARRAY['missingVolume'],coalesce(usd,0));
   IF usd IS NULL THEN g:=raw_history_add(g,ARRAY['unknown'],1); END IF;
  END IF;
  IF attributed AND (r->>'side')::integer=-1 AND usd IS NOT NULL THEN
   a:=coalesce(g#>ARRAY['actors',actor],jsonb_build_object('amount',0,'minPrice',1.7976931348623157e308::double precision,'atSec',sec,'refs','[]'::jsonb));
   a:=raw_history_add(a,ARRAY['amount'],amount);
   IF amount<>0 THEN a:=jsonb_set(a,'{minPrice}',to_jsonb(least((a->>'minPrice')::double precision,usd/amount))); END IF;
   IF jsonb_array_length(a->'refs')<5 THEN a:=jsonb_set(a,'{refs}',(a->'refs')||jsonb_build_array(r)); END IF;
   g:=jsonb_set(g,ARRAY['actors',actor],a);
  END IF;
  s:=jsonb_set(s,'{graduation}',g);
 END IF;
 IF usd>0 AND amount>0 AND (r->>'amount_quote')::double precision>0 THEN
  s:=s||jsonb_build_object('poolLastPriced',coalesce(s->'poolLastPriced','{}')||jsonb_build_object(pool,r),'lastPositivePriced',r);
 END IF;
 IF usd>0 AND amount>0 THEN s:=s||jsonb_build_object('peakRawPrice',greatest(coalesce((s->>'peakRawPrice')::double precision,0),usd/amount),'lastRatingPriced',r); END IF;
 s:=raw_history_add(raw_history_add(raw_history_add(s,ARRAY['count'],1),ARRAY['volume'],coalesce(usd,0)),ARRAY['net'],(r->>'side')::integer*amount);
 s:=jsonb_set(s,'{usdComplete}',to_jsonb((s->>'usdComplete')::boolean AND usd IS NOT NULL));
 IF attributed THEN
  IF sec<=(id->>'createdSec')::double precision+3600 THEN
   k:=CASE WHEN (r->>'side')::integer=1 THEN 'firstHourBuys' ELSE 'firstHourSells' END;
   s:=raw_history_add(s,ARRAY[k,actor],amount);
  END IF;
  IF (r->>'side')::integer=-1 THEN
   s:=raw_history_add(s,ARRAY['sellCounts',actor],1);refs:=coalesce(s#>ARRAY['sellEvidence',actor],'[]');
   IF jsonb_array_length(refs)<5 THEN s:=jsonb_set(s,ARRAY['sellEvidence',actor],refs||jsonb_build_array(r)); END IF;
  END IF;
 END IF;
 IF s->'first' IS NULL THEN s:=s||jsonb_build_object('first',r); END IF;
 IF usd IS NOT NULL AND amount>0 AND s->'firstPriced' IS NULL THEN s:=s||jsonb_build_object('firstPriced',r); END IF;
 IF NOT attributed THEN
  s:=raw_history_add(raw_history_add(s,ARRAY['missing'],1),ARRAY['missingVolume'],coalesce(usd,0));
  IF usd IS NULL THEN s:=raw_history_add(s,ARRAY['unknown'],1); END IF;
 END IF;
 s:=jsonb_set(s,'{hasEth}',to_jsonb((s->>'hasEth')::boolean OR r->>'quote_asset'='0x0000000000000000000000000000000000000000'));
 IF r->>'venue'='pons_curve' THEN s:=raw_history_add(raw_history_add(s,ARRAY['curveVolume'],coalesce(usd,0)),ARRAY['curveNet'],(r->>'side')::integer*coalesce(usd,0));
 ELSE s:=raw_history_add(s,ARRAY['pools',pool],1); END IF;
 s:=s||jsonb_build_object('last',r);
 IF usd IS NOT NULL AND amount>0 THEN s:=s||jsonb_build_object('lastPriced',r); END IF;
 IF (r->>'side')::integer=1 THEN
  IF actor IS NOT NULL AND NOT (s->'buyers') ? actor THEN s:=jsonb_set(s,'{buyers}',(s->'buyers')||to_jsonb(actor)); END IF;
  buyer:=r->>'recipient';
  IF buyer IS NOT NULL AND NOT (s->'buyers') ? buyer THEN s:=jsonb_set(s,'{buyers}',(s->'buyers')||to_jsonb(buyer)); END IF;
  IF attributed THEN s:=raw_history_add(s,ARRAY['exemptBought',actor],amount); END IF;
  IF buyer IS NULL AND NOT attributed THEN s:=jsonb_set(s,'{unknownBuyers}','true'); END IF;
  buyer:=coalesce(buyer,CASE WHEN attributed THEN actor END);
  IF early AND NOT coalesce((id->'pools') ? buyer,false) THEN
   IF buyer IS NULL THEN s:=jsonb_set(s,'{earlyComplete}','false');
   ELSE
    e:=coalesce(s#>ARRAY['early',buyer],jsonb_build_object('first',r,'gross',0,'soldEarly',coalesce(s#>ARRAY['earlySales',buyer],'0'),'sold',coalesce(s#>ARRAY['earlySales',buyer],'0'),'deployer',false));
    e:=raw_history_add(e,ARRAY['gross'],amount);
    IF actor IS NOT NULL AND NOT coalesce((e->'funders') ? actor,false) THEN e:=e||jsonb_build_object('funders',coalesce(e->'funders','[]')||to_jsonb(actor)); END IF;
    e:=jsonb_set(e,'{deployer}',to_jsonb((e->>'deployer')::boolean OR buyer=id->>'deployer' OR coalesce(actor=id->>'deployer',false)));
    s:=jsonb_set(s,ARRAY['early',buyer],e);
   END IF;
  END IF;
 ELSIF actor IS NOT NULL THEN
  IF early THEN s:=raw_history_add(s,ARRAY['earlySales',actor],amount); END IF;
  IF s#>ARRAY['early',actor] IS NOT NULL THEN
   s:=raw_history_add(s,ARRAY['early',actor,'sold'],amount);
   IF early THEN s:=raw_history_add(s,ARRAY['early',actor,'soldEarly'],amount); END IF;
  END IF;
 END IF;
 IF attributed THEN
  a:=coalesce(s#>ARRAY['devByActor',actor],'{"cashIn":0,"cashOut":0,"sold":0,"complete":true,"sells":[]}');
  a:=jsonb_set(a,'{complete}',to_jsonb((a->>'complete')::boolean AND usd IS NOT NULL));
  IF (r->>'side')::integer=1 THEN a:=raw_history_add(a,ARRAY['cashIn'],coalesce(usd,0));
  ELSE
   a:=raw_history_add(raw_history_add(a,ARRAY['cashOut'],coalesce(usd,0)),ARRAY['sold'],amount);
   IF jsonb_array_length(a->'sells')<5 THEN a:=jsonb_set(a,'{sells}',(a->'sells')||jsonb_build_array(r)); END IF;
  END IF;
  s:=s||jsonb_build_object('devByActor',coalesce(s->'devByActor','{}')||jsonb_build_object(actor,a));
  IF actor=id->>'deployer' THEN s:=jsonb_set(s,'{dev}',a); END IF;
 END IF;
 SELECT coalesce(jsonb_agg(v ORDER BY n),'[]') INTO refs FROM jsonb_array_elements(coalesce(s->'tail','[]')||jsonb_build_array(r)) WITH ORDINALITY a(v,n)
 WHERE n>jsonb_array_length(coalesce(s->'tail','[]'))+1-60;
 RETURN s||jsonb_build_object('tail',refs);
END $$;
-- statement-breakpoint
CREATE AGGREGATE raw_history_lifetime(jsonb,jsonb,jsonb) (SFUNC=raw_history_lifetime_step, STYPE=jsonb);
-- statement-breakpoint
-- Readers exclude committed summaries while a sealed partition awaits detach/drop (including lock retries).
CREATE VIEW raw_history_live_swaps AS SELECT s.* FROM swaps s WHERE NOT EXISTS(
 SELECT 1 FROM raw_history_seals r WHERE r.name='swaps' AND r.sealed AND NOT r.dropped AND s.ts>=r.start_ts AND s.ts<r.end_ts
);
CREATE VIEW raw_history_live_transfers AS SELECT t.* FROM token_transfers t WHERE NOT EXISTS(
 SELECT 1 FROM raw_history_seals r WHERE r.name='token_transfers' AND r.sealed AND NOT r.dropped AND t.ts>=r.start_ts AND t.ts<r.end_ts
);
