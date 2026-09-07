import type { RetentionRuleRunner } from './retention-control.js';
import { validateReceiptPublication, type Publication } from './receipt-outbox.js';
import type { ChainDb } from './client.js';
import type { RetentionOptions, RetentionResult } from './retention.js';
import { addReport, reportRows, retentionBatch } from './determination-retention.js';

/** First grade since each rules cut is a permanent public measurement boundary. */
export const GRADE_CUTS = ['2026-10-12T18:30:00Z', '2026-10-13T07:30:00Z'] as const;
/** Seek one grade block first; only same-block ties need receipt-sequence ordering. */
const gradeSeek = (coin:string) => `SELECT v.id,b.ts,v.data->>'level' AS level FROM (
    SELECT v.valid_from_block FROM verdicts v WHERE v.coin=${coin}
      AND v.valid_from_block>=(SELECT number FROM engine_block_times WHERE ts>=c.since ORDER BY ts,number LIMIT 1)
      AND v.data->>'level' IN ('clear','monitor','danger')
      AND EXISTS(SELECT 1 FROM engine_block_times b WHERE b.number=v.valid_from_block AND b.ts>=c.since)
    ORDER BY v.valid_from_block LIMIT 1
  ) first_grade JOIN verdicts v ON v.coin=${coin} AND v.valid_from_block=first_grade.valid_from_block
  JOIN engine_block_times b ON b.number=v.valid_from_block LEFT JOIN receipt_publications p ON p.id=v.id
  WHERE v.data->>'level' IN ('clear','monitor','danger')
  ORDER BY p.publication_sequence ASC NULLS FIRST,v.id LIMIT 1`;
export async function preserveGradePrices(db: ChainDb, coin: Uint8Array, before: Date, endangeredBefore = before) {
  await db.sql.query(`INSERT INTO retention_grade_prices(coin,since,horizon_sec,graded_at,level,p0,p1,hi)
    SELECT $1,c.since,h.sec,g.ts,g.level,
    (SELECT s.usd/s.amount_coin::double precision FROM swaps s WHERE s.coin=$1 AND s.ts<=g.ts AND s.ts>g.ts-interval '1 hour' AND s.usd>0 AND s.amount_coin>0 ORDER BY s.ts DESC LIMIT 1),
    (SELECT s.usd/s.amount_coin::double precision FROM swaps s WHERE s.coin=$1 AND s.ts<=g.ts+h.sec*interval '1 second' AND s.usd>0 AND s.amount_coin>0 ORDER BY s.ts DESC LIMIT 1),
    (SELECT max(s.usd/s.amount_coin::double precision) FROM swaps s WHERE s.coin=$1 AND s.ts>g.ts AND s.ts<=g.ts+h.sec*interval '1 second' AND s.usd>0 AND s.amount_coin>0)
    FROM unnest($2::timestamptz[]) c(since) CROSS JOIN (VALUES(3600),(86400)) h(sec)
    CROSS JOIN LATERAL (${gradeSeek('$1')}) g
    WHERE g.ts<$3 AND g.ts<$4
    ON CONFLICT(coin,since,horizon_sec) DO UPDATE SET
      p0=coalesce(retention_grade_prices.p0,excluded.p0),p1=coalesce(excluded.p1,retention_grade_prices.p1),hi=greatest(retention_grade_prices.hi,excluded.hi)`, [coin,GRADE_CUTS,before,endangeredBefore]);
}
const old = (block: string) => `EXISTS(SELECT 1 FROM engine_block_times b WHERE b.number=${block} AND b.ts<$1)`;
const gradeProbe = `SELECT g.id FROM (${gradeSeek('x.coin')}) g`;
const gradeException = `NOT EXISTS(SELECT 1 FROM unnest($2::timestamptz[]) c(since) WHERE x.id=(${gradeProbe}))`;
/** Reader/FK exceptions are applied only to bounded candidate windows. Dry-run estimates are skipped. */
export function ratingSelections() {
  const selections = [
    { table:'wallet_fingerprint_dependencies',select:`SELECT x.* FROM wallet_fingerprint_dependencies x JOIN wallet_fingerprint_runs r ON r.id=x.run_id
      WHERE ${old('r.block')} AND NOT EXISTS(SELECT 1 FROM wallet_label_fingerprint_dependencies l WHERE l.run_id=x.run_id)`,remove:`DELETE FROM wallet_fingerprint_dependencies x USING picked p WHERE x.run_id=p.run_id AND x.block=p.block` },
    { table: 'guard_shadow_runs', select: `SELECT x.* FROM guard_shadow_runs x WHERE x.recorded_at<$1 AND EXISTS(SELECT 1 FROM guard_shadow_runs n WHERE n.coin=x.coin AND (n.block,n.recorded_at,n.id)>(x.block,x.recorded_at,x.id))`, remove: `DELETE FROM guard_shadow_runs x USING picked p WHERE x.id=p.id` },
    { table: 'coin_cards', select: `SELECT x.* FROM coin_cards x WHERE ${old('x.valid_from_block')} AND NOT EXISTS(SELECT 1 FROM coin_card_latest l WHERE l.card_id=x.id)
      AND EXISTS(SELECT 1 FROM coin_cards n WHERE n.coin=x.coin AND n.rules_version=x.rules_version AND (n.valid_from_block,n.id)>(x.valid_from_block,x.id))`, remove: `DELETE FROM coin_cards x USING picked p WHERE x.id=p.id` },
    { table: 'playbook_matches', select: `SELECT x.* FROM playbook_matches x WHERE ${old('x.valid_from_block')}
      AND EXISTS(SELECT 1 FROM playbook_matches n WHERE n.coin=x.coin AND n.valid_from_block>x.valid_from_block)`, remove: `DELETE FROM playbook_matches x USING picked p WHERE (x.coin,x.valid_from_block,x.rules_version,x.playbook_id)=(p.coin,p.valid_from_block,p.rules_version,p.playbook_id)` },
    { table: 'verdicts', select: `SELECT x.* FROM verdicts x WHERE ${old('x.valid_from_block')}
      AND EXISTS(SELECT 1 FROM verdicts n WHERE n.coin=x.coin AND n.rules_version=x.rules_version AND (n.valid_from_block,n.id)>(x.valid_from_block,x.id) AND NOT EXISTS(SELECT 1 FROM verdict_events e WHERE e.verdict_id=n.id AND e.kind='orphaned'))
      AND x.id<>(SELECT n.id FROM verdicts n WHERE n.coin=x.coin AND n.rules_version=x.rules_version AND NOT EXISTS(SELECT 1 FROM verdict_events e WHERE e.verdict_id=n.id AND e.kind='orphaned') ORDER BY n.valid_from_block DESC,n.id DESC LIMIT 1)
      AND EXISTS(SELECT 1 FROM verdicts n WHERE n.coin=x.coin AND (n.valid_from_block,n.id)<(x.valid_from_block,x.id))
      AND EXISTS(SELECT 1 FROM receipt_publications p WHERE p.id=x.id AND p.data IS NULL)
      AND NOT EXISTS(SELECT 1 FROM guard_shadow_runs s WHERE s.legacy_verdict_id=x.id)
      AND NOT EXISTS(SELECT 1 FROM verdict_events e WHERE e.verdict_id=x.id AND e.kind IN ('orphaned','corrected'))
      AND ${gradeException}`, remove: `DELETE FROM verdicts x USING picked p WHERE x.id=p.id` },
  ];
  return selections;
}
export const receiptSelection = `SELECT p.* FROM receipt_publications p WHERE p.recorded_at<$1 AND p.data IS NOT NULL AND p.kind='verdict'
  AND p.producer='engines' AND p.chain_id=4663`;
const currentReceiptExclusion = `
  AND NOT EXISTS(SELECT 1 FROM coin_card_latest c WHERE c.coin=decode(substring(p.data->>'coin' FROM 3),'hex') AND c.data->'verdict'->'receipt'->>'id'=p.id)`;

/** Fetch a bounded key window before testing eligibility, even if none of its rows can be removed. */
export async function ratingWindow(db: ChainDb, table: string, columns: string[], types: string[], after: unknown[] | undefined, limit: number) {
  const keys = columns.join(',');
  return (await db.sql.query<Record<string, unknown>>(`SELECT ${keys} FROM ${table}
    ${after ? `WHERE (${keys})>(${types.map((t,i)=>`$${i+1}::${t}`).join(',')})` : ''}
    ORDER BY ${keys} LIMIT ${limit}`, after)).rows;
}
function windowPredicate(rows: Record<string, unknown>[], columns: string[], types: string[], values: unknown[]) {
  const arrays = columns.map((c,i) => { values.push(rows.map(row=>row[c])); return `$${values.length}::${types[i]}[]`; });
  if (columns.length === 1) return `x.${columns[0]}=ANY(${arrays[0]})`;
  // 2026-10-17: a tuple-IN join can walk all 3.9M dependencies. Bound both delete inputs by key.
  const keys=`(${columns.map(c=>`x.${c}`).join(',')})`;
  const edge=(row:Record<string,unknown>)=>`(${columns.map((c,i)=>{values.push(row[c]);return `$${values.length}::${types[i]}`;}).join(',')})`;
  return `${keys}>=${edge(rows[0]!)} AND ${keys}<=${edge(rows.at(-1)!)} AND ${keys} IN (SELECT * FROM unnest(${arrays.join(',')}))`;
}
export async function ratingRetention(db: ChainDb, options: RetentionOptions, result: RetentionResult, nowMs: number,
  runRule: RetentionRuleRunner, cursors: Map<string, unknown[]>) {
  const cutoff = new Date(nowMs-(options.ratingDays ?? 1)*86400000);
  result.ratingRows = Object.fromEntries(['receipt_publications','receipt_items',...ratingSelections().map(r=>r.table)].map(t=>[t,0]));
  const receiptCutoff = options.receiptHours === undefined ? cutoff : new Date(nowMs-options.receiptHours*3600000);
  await runRule('receipt_publications', (timeLeft,limit) => receiptRetention(db,options,result,receiptCutoff,limit,timeLeft,cursors,nowMs));
  for (const rule of ratingSelections()) await runRule(rule.table, async (timeLeft,limit) => {
    if (options.dryRun) {
      addReport(result,await reportRows(db,rule.table,'',[]));
      if(rule.table==='verdicts')addReport(result,await reportRows(db,'verdict_events','',[]));
      return;
    }
    const columns=rule.table==='playbook_matches' ? ['coin','valid_from_block','rules_version','playbook_id'] : rule.table==='wallet_fingerprint_dependencies' ? ['run_id','block'] : ['id'];
    const types=rule.table==='playbook_matches' ? ['bytea','bigint','text','text'] : rule.table==='wallet_fingerprint_dependencies' ? ['text','bigint'] : ['text'];
    while(timeLeft()) {
      const batch=await retentionBatch(db,async tx=>{
        const window=await ratingWindow(tx,rule.table,columns,types,cursors.get(rule.table),limit);
        if(!window.length)return {moved:0,after:undefined};
        const params:unknown[]=rule.table==='verdicts' ? [cutoff,GRADE_CUTS] : [cutoff];
        const predicate=windowPredicate(window,columns,types,params);
        const selectedColumns = [...new Set([...columns, ...(rule.table==='coin_cards' || rule.table==='verdicts' || rule.table==='playbook_matches' ? ['coin','data'] : [])])];
        let bounded=rule.select.replace('SELECT x.*',`SELECT ${selectedColumns.map(c=>`x.${c}`).join(',')}`).replace(`WHERE `,`WHERE ${predicate} AND `);
        if (rule.table==='verdicts') {
          // The same coin can occupy most of a window. Compute each permanent grade boundary once per coin/cut.
          const coins=(await tx.sql.query<{coin:Uint8Array}>(`SELECT v.coin FROM unnest($1::text[]) k(id)
            CROSS JOIN LATERAL (SELECT coin FROM verdicts WHERE id=k.id OFFSET 0) v`,[window.map(r=>r.id)])).rows;
          const unique=new Map(coins.map(r=>[Buffer.from(r.coin).toString('hex'),r.coin]));
          params.push([...unique.values()]);
          bounded=`WITH candidate_coins AS MATERIALIZED (SELECT coin FROM unnest($4::bytea[]) k(coin)),
            grade_boundaries AS MATERIALIZED (SELECT g.id FROM candidate_coins x CROSS JOIN unnest($2::timestamptz[]) c(since)
              CROSS JOIN LATERAL (${gradeProbe}) g)
            ${bounded.replace(gradeException,'NOT EXISTS(SELECT 1 FROM grade_boundaries g WHERE g.id=x.id)')}`;
        }
        const rows=(await tx.sql.query<Record<string,unknown>>(`${bounded}${columns.length>1 ? ` ORDER BY ${columns.map(c=>`x.${c}`).join(',')}` : ''} FOR UPDATE OF x SKIP LOCKED`,params)).rows;
        const after=columns.map(c=>window.at(-1)![c]);
        if(!rows.length)return {moved:0,after};
        const values:unknown[]=[];
        const filter=windowPredicate(rows,columns,types,values);
        const picked=`SELECT ${columns.map(c=>`x.${c}`).join(',')} FROM ${rule.table} x WHERE ${filter}`;
        const summaryPicked=`SELECT ${selectedColumns.map(c=>`x.${c}`).join(',')} FROM ${rule.table} x WHERE ${filter}`;
        if(rule.table==='coin_cards' || rule.table==='verdicts')await tx.sql.query(`WITH picked AS (${summaryPicked})
          INSERT INTO read_blue_chip_danger(coin) SELECT DISTINCT coin FROM picked
          WHERE ${rule.table==='coin_cards' ? "data->'verdict'->>'level'" : "data->>'level'"}='danger' ON CONFLICT DO NOTHING`,values);
        if(rule.table==='playbook_matches')await tx.sql.query(`WITH picked AS (${summaryPicked})
          INSERT INTO coin_match_lifetime SELECT coin,rules_version,playbook_id,data->>'level',min(valid_from_block) FROM picked GROUP BY coin,rules_version,playbook_id,data->>'level'
          ON CONFLICT(coin,rules_version,playbook_id,level) DO UPDATE SET first_block=least(coin_match_lifetime.first_block,excluded.first_block)`,values);
        if(rule.table==='verdicts')await tx.sql.query(`WITH picked AS (${picked}) DELETE FROM verdict_events e USING picked p WHERE e.verdict_id=p.id`,values);
        const remove=rule.table==='wallet_fingerprint_dependencies' ? rule.remove.replace('WHERE ',`WHERE ${filter} AND `) : rule.remove;
        const moved=Number((await tx.sql.query<{n:string}>(`WITH picked AS (${picked}),gone AS (${remove} RETURNING 1) SELECT count(*)::text AS n FROM gone`,values)).rows[0]?.n ?? 0);
        return {moved,after};
      },options.pauseMs);
      addReport(result,{table:rule.table,rows:batch.moved,estimatedBytes:0});
      result.ratingRows![rule.table]!+=batch.moved;
      if(!batch.after) {cursors.delete(rule.table);break;}
      cursors.set(rule.table,batch.after);
    }
  });
}
async function receiptRetention(db:ChainDb,options:RetentionOptions,result:RetentionResult,cutoff:Date,limit:number,timeLeft:()=>boolean,cursors:Map<string,unknown[]>,nowMs:number) {
  if(options.dryRun) {
    for(const table of ['receipt_publications','receipt_items'])addReport(result,await reportRows(db,table,'',[]));
    return;
  }
  addReport(result,{table:'receipt_publications',rows:0,estimatedBytes:0,examined:0,eligible:0});
  // The optional third cursor value holds a completed, ineligible walk for one hour.
  const cursor=cursors.get('receipt_publications');
  if(cursor?.[2] !== undefined) {
    if(options.receiptKeepCurrent && nowMs<Number(cursor[2]))return;
    cursors.delete('receipt_publications');
  }
  const selection=receiptSelection+(options.receiptKeepCurrent ? currentReceiptExclusion : '');
  let eligibleThisPass=0;
  while(timeLeft()) {
    const after=cursors.get('receipt_publications');
    // 2026-10-17: large TOAST payloads must be validated without holding publication row locks.
    const window=(await db.sql.query<{id:string;recorded_at:Date}>(`SELECT id,recorded_at FROM receipt_publications
      WHERE recorded_at<$1 AND data IS NOT NULL AND kind='verdict' AND producer='engines' AND chain_id=4663
      ${after ? 'AND (recorded_at,id)>($2::timestamptz,$3::text)' : ''}
      ORDER BY recorded_at,id LIMIT ${limit}`,[cutoff,...(after ?? [])])).rows;
    if(!window.length) {
      if(options.receiptKeepCurrent && after && eligibleThisPass===0)
        cursors.set('receipt_publications',[...after.slice(0,2),(options.now ?? Date.now)()+3_600_000]);
      else cursors.delete('receipt_publications');
      break;
    }
    const next=[window.at(-1)!.recorded_at,window.at(-1)!.id];
    addReport(result,{table:'receipt_publications',rows:0,estimatedBytes:0,examined:window.length});
    const eligible=(await db.sql.query<{id:string}>(`${selection.replace('SELECT p.*','SELECT p.id')} AND p.id=ANY($2::text[])`,[cutoff,window.map(r=>r.id)])).rows;
    eligibleThisPass+=eligible.length;
    addReport(result,{table:'receipt_publications',rows:0,estimatedBytes:0,eligible:eligible.length});
    if(!eligible.length) {cursors.set('receipt_publications',next);continue;}
    // Fetch large payloads only for eligible IDs; a concurrent stripper may already have cleared them.
    const candidates=(await db.sql.query<Publication>('SELECT p.* FROM receipt_publications p WHERE p.id=ANY($1::text[]) AND p.data IS NOT NULL',[eligible.map(r=>r.id)])).rows;
    for(const row of candidates)validateReceiptPublication(row);
    const n=await retentionBatch(db,async tx=>{
      // Payloads are append-only. Recheck eligibility under lock after validation; another stripper may have won.
      const rows=(await tx.sql.query<{id:string}>(`${selection.replace('SELECT p.*','SELECT p.id')} AND p.id=ANY($2::text[]) FOR UPDATE OF p SKIP LOCKED`,[cutoff,candidates.map(r=>r.id)])).rows;
      if(!rows.length)return {publications:0,items:0,after:next};
      const ids=rows.map(r=>r.id);
      await tx.sql.query(`UPDATE receipt_publications SET summary=jsonb_build_object('coin',data->'coin','supersedes',data->'supersedes','reorgOf',data->'reorgOf',
        'recordedAt',data->'recordedAt','rulesVersion',data->'rulesVersion','revisionId',data->'revisionId','receiptId',data->'receiptId','window',data->'window',
        'level',data->'decision'->'level'),data=NULL,canonical_payload=NULL WHERE id=ANY($1::text[])`,[ids]);
      const items=Number((await tx.sql.query<{n:string}>(`WITH moved AS (UPDATE receipt_items SET data=NULL,canonical_payload=NULL WHERE id=ANY($1::text[]) AND data IS NOT NULL RETURNING 1) SELECT count(*)::text AS n FROM moved`,[ids])).rows[0]?.n ?? 0);
      return {publications:rows.length,items,after:next};
    },options.pauseMs);
    addReport(result,{table:'receipt_publications',rows:n.publications,estimatedBytes:0});
    addReport(result,{table:'receipt_items',rows:n.items,estimatedBytes:0});
    result.ratingRows!.receipt_publications!+=n.publications;result.ratingRows!.receipt_items!+=n.items;
    if(!n.after) {cursors.delete('receipt_publications');break;}
    cursors.set('receipt_publications',n.after);
  }
}
