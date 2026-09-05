import { addOutcomeHours, prepareOutcomeEvents, addOutcomeEvents, preserveOutcomeHoldings, type OutcomeCuts } from './raw-history-checkpoints.js';
import { retentionLimits } from './retention-control.js';
import type { ChainDb } from './client.js';
import { addLifetimePons, addLifetimeSwaps, addLifetimeLiquidity, type LifetimeLiquidityRow, emptyLifetime, packSwap, readLifetime, saveLifetime, recordBuyerStatistics } from './lifetime.js';
import { hex } from './types.js';
import type { RetentionOptions, RetentionResult, HistoryRule, QuietCoin } from './retention.js';
import { compactTransfers, quietCoins, retentionHorizon, SWAP_EVIDENCE_DAYS } from './retention.js';
import { preserveGradePrices } from './rating-retention.js';
import { snapshotTrending } from './trending.js';

export interface RetentionTableReport { table: string; rows: number; estimatedBytes: number; estimateSkipped?: boolean; examined?: number; eligible?: number }
/** Eligibility estimates are deliberately skipped: counting payloads scans the very backlog being pruned. */
export async function reportRows(_db: ChainDb, table: string, _selection: string, _params: unknown[]): Promise<RetentionTableReport> {
  return { table, rows: 0, estimatedBytes: 0, estimateSkipped: true };
}
export const retentionLog = (dryRun: boolean, r: RetentionTableReport) => `retention dry_run=${dryRun} table=${r.table} rows=${r.rows} estimated_bytes=${r.estimatedBytes}${r.estimateSkipped ? ' estimate_skipped=true' : ''}`;

/** Budget, transaction timeouts and pauses apply to old rules too. No session-wide trigger disabling. */
export async function retentionBatch<T>(db: ChainDb, work: (tx: ChainDb) => Promise<T>, pauseMs = 100): Promise<T> {
  try { return await db.tx(async tx => {
    await retentionLimits(tx);
    await tx.sql.query("SELECT set_config('eko.retention','on',true)");
    const result = await work(tx);
    await tx.sql.query("SELECT set_config('eko.retention','off',true)");
    return result;
  }); } finally {
    if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
}
export async function preserveGraduation(db: ChainDb, coin: Uint8Array, through: bigint) {
  await db.sql.query(`UPDATE coin_lifetime l SET opening_holdings=x.data FROM tokens t CROSS JOIN LATERAL (
    SELECT coalesce(jsonb_object_agg(encode(holder,'hex'),amount::text),'{}') AS data FROM (
      SELECT holder,sum(amount) AS amount FROM (
        SELECT to_address AS holder,amount FROM token_transfers WHERE token=t.address AND block<=t.first_block AND kind='Transfer'
        UNION ALL SELECT from_address,-amount FROM token_transfers WHERE token=t.address AND block<=t.first_block AND kind='Transfer'
        UNION ALL SELECT holder,amount FROM transfer_baselines WHERE token=t.address AND through_block<=t.first_block
      ) a GROUP BY holder HAVING sum(amount)>0
    ) b
  ) x WHERE l.coin=$1 AND t.address=l.coin AND l.opening_holdings IS NULL`,[coin]);
  await db.sql.query(`UPDATE coin_lifetime l SET graduation_holdings=x.data FROM tokens t CROSS JOIN LATERAL (
    SELECT coalesce(jsonb_object_agg(encode(holder,'hex'),amount::text),'{}') AS data FROM (
      SELECT holder,sum(amount) AS amount FROM (
        SELECT to_address AS holder,amount FROM token_transfers WHERE token=t.address AND block<t.graduated_block AND kind='Transfer'
        UNION ALL SELECT from_address,-amount FROM token_transfers WHERE token=t.address AND block<t.graduated_block AND kind='Transfer'
        UNION ALL SELECT holder,amount FROM transfer_baselines WHERE token=t.address AND through_block<t.graduated_block
      ) a GROUP BY holder HAVING sum(amount)>0
    ) b
  ) x WHERE l.coin=$1 AND t.address=l.coin AND t.graduated_block<=$2 AND l.graduation_holdings IS NULL`, [coin, through.toString()]);
}
/** Aggregate and delete exactly the same prefix in one short transaction. */
export async function compactLifetimeSwaps(db: ChainDb, coin: Uint8Array, through: bigint, limit: number, firstBlocks = 35, cohortSec = 60, poolManager?: string, minimal=false, bounded=false, cuts?:OutcomeCuts): Promise<number> {
  await db.sql.query('SELECT read_lock_coins($1::bytea[])',[[coin]]);
  const identity = (await db.sql.query<{ deployer: Uint8Array; first_block: string; ts: Date }>(`SELECT t.deployer,t.first_block,coalesce(b.ts,c.ts) AS ts FROM tokens t
    LEFT JOIN engine_block_times b ON b.number=t.first_block LEFT JOIN chain_blocks c ON c.number=t.first_block WHERE t.address=$1`, [coin])).rows[0];
  if (!bounded && !minimal && !identity?.ts) return 0;
  if(!bounded && !minimal && (await db.sql.query('SELECT 1 FROM history_prunes p WHERE p.coin=$1 AND p.transfers+p.swaps+p.liquidity+p.pons>0 AND NOT EXISTS(SELECT 1 FROM coin_lifetime l WHERE l.coin=p.coin)',[coin])).rows.length)return 0;
  // Entire old minutes, as in pruneSwaps: charts must never rebuild a partly removed minute.
  const before=(await db.sql.query<{ts:Date}>('SELECT ts FROM engine_block_times WHERE number=$1 UNION ALL SELECT ts FROM chain_blocks WHERE number=$1 LIMIT 1',[through.toString()])).rows[0]?.ts;
  if(before && !minimal && !bounded)await preserveGradePrices(db,coin,before);
  const rows = (await db.sql.query<Record<string, unknown>>(bounded
    ? `SELECT * FROM swaps WHERE coin=$1 AND block=$2 ORDER BY block,log_index,tx_hash LIMIT $3 FOR UPDATE`
    : `WITH edge AS (SELECT date_trunc('minute',ts)+interval '1 minute' AS ts
      FROM swaps WHERE coin=$1 AND block<=$2 ORDER BY ts LIMIT 1 OFFSET $3)
      SELECT * FROM swaps WHERE coin=$1 AND block<=$2 AND ts<coalesce((SELECT ts FROM edge),'infinity'::timestamptz)
      ORDER BY ts LIMIT $4 FOR UPDATE`, bounded ? [coin, through.toString(),limit]
      : [coin, through.toString(), Math.max(0, limit-1),Math.max(1000,limit*2)+1])).rows;
  rows.sort((a,b)=>BigInt(String(a.block))<BigInt(String(b.block)) ? -1 : BigInt(String(a.block))>BigInt(String(b.block)) ? 1 : Number(a.log_index)-Number(b.log_index) || hex(a.tx_hash as Uint8Array).localeCompare(hex(b.tx_hash as Uint8Array)));
  // A pathological minute is retained rather than creating an unbounded transaction.
  if (!rows.length || !bounded && rows.length > Math.max(1000,limit*2)) return 0;
  await db.sql.query(`INSERT INTO reference_price_baselines(pool_id,coin,quote_asset,block,log_index,price_quote)
    SELECT DISTINCT ON(s.pool_id,c.coin,s.quote_asset) s.pool_id,c.coin,s.quote_asset,s.block,s.log_index,s.price_quote
    -- Reuse the locked batch: no second cold primary-key read of every swap.
    FROM unnest($2::bytea[],$3::bytea[],$4::bigint[],$5::integer[],$6::double precision[])
      s(pool_id,quote_asset,block,log_index,price_quote)
    CROSS JOIN LATERAL (SELECT $1::bytea AS coin) c
    WHERE c.coin=$1 AND s.price_quote>0 AND s.price_quote<'Infinity'::double precision
      AND EXISTS(SELECT 1 FROM eth_usd_reference_sources r WHERE r.pool_id=s.pool_id)
    ORDER BY s.pool_id,c.coin,s.quote_asset,s.block DESC,s.log_index DESC
    ON CONFLICT(pool_id,coin,quote_asset) DO UPDATE SET block=excluded.block,log_index=excluded.log_index,price_quote=excluded.price_quote
    WHERE (excluded.block,excluded.log_index)>(reference_price_baselines.block,reference_price_baselines.log_index)`,
    [coin,rows.map(r=>r.pool_id),rows.map(r=>r.quote_asset),rows.map(r=>String(r.block)),rows.map(r=>r.log_index),rows.map(r=>r.price_quote)]);
  await recordBuyerStatistics(db,coin,rows);
  if(bounded)await addOutcomeHours(db,coin,rows,cuts);
  const data = minimal ? emptyLifetime() : await readLifetime(db, coin) ?? emptyLifetime();
  if(!minimal && !data.graduation) {
    const graduation=(await db.sql.query<{block:string;ts:Date}>('SELECT t.graduated_block AS block,b.ts FROM tokens t JOIN engine_block_times b ON b.number=t.graduated_block WHERE t.address=$1',[coin])).rows[0];
    if(graduation) {
      const first=(await db.sql.query<Record<string,unknown>>("SELECT * FROM swaps WHERE coin=$1 AND block>=$2 AND venue<>'pons_curve' ORDER BY block,log_index,tx_hash LIMIT 1",[coin,graduation.block])).rows[0];
      const beforeRow=(await db.sql.query<Record<string,unknown>>('SELECT * FROM swaps WHERE coin=$1 AND block<$2 ORDER BY block DESC,log_index DESC,tx_hash DESC LIMIT 1',[coin,graduation.block])).rows[0];
      if(first)data.graduation={block:Number(graduation.block),atSec:new Date(graduation.ts).getTime()/1000,first:packSwap(first),
        before:beforeRow ? packSwap(beforeRow) : data.last,count:0,missing:0,volume:0,missingVolume:0,unknown:0,actors:{}};
    }
  }
  const pools = (await db.sql.query<{ id: Uint8Array }>('SELECT id FROM pools WHERE currency0=$1 OR currency1=$1', [coin])).rows;
  if(!minimal)addLifetimeSwaps(data, rows.map(packSwap), { deployer:identity?.deployer ? hex(identity.deployer) : '', firstBlock: Number(identity?.first_block ?? 0), createdSec: identity?.ts ? new Date(identity.ts).getTime()/1000 : 0,
    pools: new Set([...pools.map(p => hex(p.id)),...(poolManager ? [poolManager.toLowerCase()] : [])]), firstBlocks, cohortSec });
  if(!minimal)await saveLifetime(db, coin, data);
  const known=rows.filter(r=>r.side===1 && r.trader!=null && !r.senders_pending);
  if(known.length && !minimal)await db.sql.query('INSERT INTO read_buyers(coin,trader) SELECT $1,holder FROM unnest($2::bytea[]) holder ON CONFLICT DO NOTHING',[coin,known.map(r=>r.trader)]);
  const last = rows.at(-1)!;
  await db.sql.query(`INSERT INTO history_prunes(coin,rule,through_block,swaps_through_block,first_trade_ts,last_trade_ts,buyers,swaps)
    VALUES($1,'raw_cap',$2,$2,$3,$4,$5,$6) ON CONFLICT(coin) DO UPDATE SET
    through_block=greatest(history_prunes.through_block,excluded.through_block),swaps_through_block=greatest(history_prunes.swaps_through_block,excluded.swaps_through_block),
    first_trade_ts=least(history_prunes.first_trade_ts,excluded.first_trade_ts),last_trade_ts=greatest(history_prunes.last_trade_ts,excluded.last_trade_ts),
    buyers=(SELECT count(*) FROM read_buyers WHERE coin=$1),swaps=history_prunes.swaps+excluded.swaps,updated_at=now()`,
    [coin, String(last.block), rows[0]!.ts, last.ts, data.buyers.length, rows.length]);
  await db.sql.query(`UPDATE history_prunes SET buyer_stats_complete=true,buyers=(SELECT count(*) FROM coin_buyer_firsts WHERE coin=$1)+(SELECT coalesce(sum(n),0) FROM coin_unknown_buys WHERE coin=$1) WHERE coin=$1`,[coin]);
  await db.sql.query(`WITH removed AS (DELETE FROM swaps s USING unnest($2::timestamptz[],$3::bytea[],$4::integer[]) p(ts,hash,idx) WHERE s.coin=$1 AND s.ts=p.ts AND s.tx_hash=p.hash AND s.log_index=p.idx RETURNING s.*),
    evidence AS (INSERT INTO watcher_swap_evidence(ts,tx_hash,log_index,block,coin,pool_id,trader,side,usd,priced_block,senders_pending,pricing_pending,tx_to,quote_asset,amount_quote)
      SELECT ts,tx_hash,log_index,block,coin,pool_id,trader,side,usd,priced_block,senders_pending,pricing_pending,tx_to,quote_asset,amount_quote FROM removed WHERE ts>=(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '7 days' ON CONFLICT DO NOTHING RETURNING 1) SELECT count(*) FROM removed`,[coin,rows.map(r=>new Date(r.ts as string).toISOString()),rows.map(r=>r.tx_hash),rows.map(r=>r.log_index)]);
  return rows.length;
}
async function compactPons(db: ChainDb, coin: Uint8Array, through: bigint, limit: number): Promise<number> {
  const rows = (await db.sql.query<{ block: string; kind: string; data: Record<string, unknown>; tx_hash: Uint8Array; log_index: number }>(`SELECT * FROM pons_events
    WHERE token=$1 AND block<=$2 AND kind IN ('launch','trade') ORDER BY block,log_index,tx_hash LIMIT $3 FOR UPDATE`, [coin, through.toString(), limit])).rows;
  if (!rows.length) return 0;
  const launch = (await db.sql.query<{ first_block: string }>('SELECT first_block FROM tokens WHERE address=$1', [coin])).rows[0];
  const data = await readLifetime(db, coin) ?? emptyLifetime();
  await addOutcomeEvents(db,coin,rows,'pons',{launchpad:'pons',deployer:'',firstBlock:Number(launch!.first_block)});
  addLifetimePons(data, rows, Number(launch!.first_block));data.ponsThrough=Math.max(data.ponsThrough ?? 0,...rows.map(r=>Number(r.block))); await saveLifetime(db, coin, data);
  await db.sql.query('DELETE FROM pons_events e USING unnest($1::bytea[],$2::integer[]) AS p(hash,idx) WHERE e.tx_hash=p.hash AND e.log_index=p.idx',[rows.map(r=>r.tx_hash),rows.map(r=>r.log_index)]);
  return rows.length;
}
async function compactLiquidity(db:ChainDb,coin:Uint8Array,through:bigint,quotes:Uint8Array[],limit:number) {
  const rows=(await db.sql.query<LifetimeLiquidityRow>(`SELECT e.* FROM pools p CROSS JOIN LATERAL (
      SELECT x.* FROM liquidity_events x WHERE x.pool_id=p.id AND x.block<=$2 ORDER BY x.block,x.log_index,x.tx_hash LIMIT $4 FOR UPDATE OF x
    ) e WHERE ((p.currency0=$1 AND p.currency1=ANY($3::bytea[])) OR (p.currency1=$1 AND p.currency0=ANY($3::bytea[])))
    ORDER BY e.block,e.log_index,e.tx_hash LIMIT $4`,[coin,through.toString(),quotes,limit])).rows;
  if(!rows.length)return 0;
  const token=(await db.sql.query<{launchpad:string;deployer:Uint8Array}>('SELECT launchpad,deployer FROM tokens WHERE address=$1',[coin])).rows[0]!;
  const data=await readLifetime(db,coin) ?? emptyLifetime();
  await addOutcomeEvents(db,coin,rows,'liquidity',{launchpad:token.launchpad,deployer:hex(token.deployer),firstBlock:0});
  addLifetimeLiquidity(data,rows,token.launchpad,hex(token.deployer));data.liquidityThrough=Math.max(data.liquidityThrough ?? 0,...rows.map(r=>Number(r.block)));await saveLifetime(db,coin,data);
  await db.sql.query('DELETE FROM liquidity_events e USING unnest($1::bytea[],$2::integer[]) p(hash,idx) WHERE e.tx_hash=p.hash AND e.log_index=p.idx',[rows.map(r=>r.tx_hash),rows.map(r=>r.log_index)]);
  await db.sql.query(`INSERT INTO history_prunes(coin,rule,through_block,liquidity) VALUES($1,'raw_cap',$2,$3)
    ON CONFLICT(coin) DO UPDATE SET liquidity=history_prunes.liquidity+excluded.liquidity,through_block=greatest(history_prunes.through_block,excluded.through_block)`,[coin,through.toString(),rows.length]);
  return rows.length;
}
/** Extend the existing per-coin mechanism. Two-non-quote pools remain shared raw evidence. */
export async function pruneDeterminedCoin(db: ChainDb, coin: QuietCoin, rule: HistoryRule, through: bigint, swapsThrough: bigint | null,
  options: RetentionOptions, result: RetentionResult, timeLeft: () => boolean) {
  const legacy=(await db.sql.query('SELECT 1 FROM history_prunes p WHERE p.coin=$1 AND p.transfers+p.swaps+p.pons+p.liquidity>0 AND NOT EXISTS(SELECT 1 FROM coin_lifetime l WHERE l.coin=p.coin)',[coin.address])).rows.length;
  if(legacy)return; // Missing old evidence cannot be reconstructed into a complete lifetime summary.
  const limit = Math.min(options.batchRows ?? 1000, 5000);
  const drain = async (work: (tx: ChainDb) => Promise<number>, count: 'historyTransfers' | 'historyPons' | 'historySwaps' | 'historyLiquidity') => {
    while (timeLeft()) {
      const moved = await retentionBatch(db, work, options.pauseMs); result[count] += moved;
      if (moved < limit) return;
    }
    result.finished = false;
  };
  const taxThrough=await retentionHorizon(db,1,(options.now ?? Date.now)());
  const transferThrough=taxThrough==null ? null : through<taxThrough ? through : taxThrough;
  await retentionBatch(db, async tx => {
    if (!await readLifetime(tx, coin.address)) await saveLifetime(tx, coin.address, emptyLifetime());
    await preserveGraduation(tx, coin.address, through);
    await prepareOutcomeEvents(tx,coin.address,(await readLifetime(tx,coin.address))!);
  }, 0);
  if(options.swapDays === undefined && options.transferDays === undefined) await drain(async tx => {
    if(transferThrough==null)return 0;
    const n = await compactTransfers(tx, [coin.address], transferThrough, limit);
    if (n) await tx.sql.query(`INSERT INTO history_prunes(coin,rule,through_block,transfers,verdict_level,danger_playbooks)
      SELECT $1,$2,$3,$4,c.data->'verdict'->>'level',coalesce((SELECT jsonb_agg(m->>'id') FROM jsonb_array_elements(coalesce(c.data->'verdict'->'playbooks','[]')) m WHERE m->>'level'='danger'),'[]')
      FROM coin_card_latest c WHERE c.coin=$1 ON CONFLICT(coin) DO UPDATE SET through_block=greatest(history_prunes.through_block,excluded.through_block),
      transfers=history_prunes.transfers+excluded.transfers,updated_at=now()`, [coin.address, rule, through.toString(), n]);
    if(n)await tx.sql.query('UPDATE coin_lifetime SET revision=revision+1 WHERE coin=$1',[coin.address]);
    return n;
  }, 'historyTransfers');
  await drain(tx=>compactLiquidity(tx,coin.address,through,[...options.quoteTokens.map(q=>Buffer.from(q.slice(2),'hex')),Buffer.alloc(20)],limit),'historyLiquidity');
  await drain(async tx => {
    if(transferThrough==null)return 0;
    const n = await compactPons(tx, coin.address, transferThrough, limit);
    if(n)await tx.sql.query(`INSERT INTO history_prunes(coin,rule,through_block,pons) VALUES($1,$2,$3,$4) ON CONFLICT(coin) DO UPDATE SET pons=history_prunes.pons+excluded.pons,through_block=greatest(history_prunes.through_block,excluded.through_block)`,[coin.address,rule,through.toString(),n]);
    return n;
  }, 'historyPons');
  if (swapsThrough != null && coin.swaps) await drain(tx => compactLifetimeSwaps(tx, coin.address, swapsThrough, limit, options.firstBlocks, options.cohortSec,options.poolManager), 'historySwaps');
}

export async function determinationPass(db: ChainDb, options: RetentionOptions, result: RetentionResult, quotes: Uint8Array[], nowMs: number,
  rule: 'settled' | 'raw_cap', timeLeft: () => boolean, reported = new Map<string, RetentionTableReport>(), cursors = new Map<string,unknown[]>()) {
  const days = rule === 'settled' ? (options.settleHours ?? 24)/24 : options.rawDays ?? 1;
  const through = await retentionHorizon(db, days, nowMs); if (through == null) return;
  const taxThrough=await retentionHorizon(db,1,nowMs);
  const transferThrough=taxThrough==null ? null : through<taxThrough ? through : taxThrough;
  // Watcher inputs survive separately; transaction-level checks require one raw day.
  let swapsThrough = options.swapDays !== undefined || options.transferDays !== undefined ? null : await retentionHorizon(db, Math.max(days, SWAP_EVIDENCE_DAYS), nowMs);
  if (swapsThrough != null && !options.dryRun) {
    let done = false;
    while (timeLeft() && !done) { const saved = await snapshotTrending(db, swapsThrough, 1); result.trendingSnapshots += saved.saved; done = saved.complete; }
    if (!done) swapsThrough = null;
  }
  let after=(cursors.get(rule)?.[0] as Uint8Array | undefined) ?? null;
  while (timeLeft()) {
    const coins = await quietCoins(db, rule, through, swapsThrough, quotes, [...quotes, Buffer.alloc(20)], after, Math.min(Math.max(options.batchRows ?? 1000,32),100));
    if (!coins.length) {cursors.delete(rule);break;}
    for (const coin of coins) {
      if (!timeLeft()) { result.finished = false; return; }
      if (!coin.eligible) {after=coin.address;cursors.set(rule,[after]);continue;}
      if (options.dryRun) {
        const lp=await reportRows(db,'liquidity_events',`SELECT e.* FROM liquidity_events e JOIN pools p ON p.id=e.pool_id WHERE e.block<=$2 AND ((p.currency0=$1 AND p.currency1=ANY($3::bytea[])) OR (p.currency1=$1 AND p.currency0=ANY($3::bytea[])))`,[coin.address,through.toString(),[...quotes,Buffer.alloc(20)]]);
        const lpKey=`liquidity_events:${hex(coin.address)}`,lpPrior=reported.get(lpKey);
        if(!lpPrior || lp.rows>lpPrior.rows) {addReport(result,{...lp,rows:lp.rows-(lpPrior?.rows ?? 0),estimatedBytes:lp.estimatedBytes-(lpPrior?.estimatedBytes ?? 0)});reported.set(lpKey,lp);}
        for (const [table,key,boundary] of [['token_transfers','token',transferThrough],['pons_events','token',transferThrough],['swaps','coin',coin.swaps ? swapsThrough : null]] as const) {
          if (boundary == null) continue;
          const r = await reportRows(db, table, `SELECT * FROM ${table} WHERE ${key}=$1 AND block<=$2${table==='pons_events' ? " AND kind IN ('launch','trade')" : ''}`, [coin.address,boundary.toString()]);
          const reportKey=`${table}:${hex(coin.address)}`,prior=reported.get(reportKey);
          if(!prior || r.rows>prior.rows) { addReport(result,{...r,rows:r.rows-(prior?.rows ?? 0),estimatedBytes:r.estimatedBytes-(prior?.estimatedBytes ?? 0)}); reported.set(reportKey,r); }
        }
      } else await pruneDeterminedCoin(db, coin, rule, through, swapsThrough, options, result, timeLeft);
      if(!timeLeft()) {result.finished=false;return;}
      after = coin.address;cursors.set(rule,[after]);
    }
  }
}
export function addReport(result: RetentionResult, r: RetentionTableReport) {
  const rows = result.tables ??= [];
  const prior = rows.find(x => x.table === r.table);
  if (prior) { prior.rows += r.rows; prior.estimatedBytes += r.estimatedBytes; if (r.estimateSkipped) prior.estimateSkipped = true; } else rows.push(r);
  for (const key of ['examined','eligible'] as const) if (r[key] !== undefined) {
    if (prior) prior[key] = (prior[key] ?? 0) + r[key];
    const stats = result.ruleStats?.[r.table];
    if (stats) stats[key] = (stats[key] ?? 0) + r[key];
  }
}

export async function compactUnratedTransfers(db:ChainDb,coin:Uint8Array,through:bigint,limit:number) {
  if((await db.sql.query('SELECT 1 FROM history_prunes p WHERE p.coin=$1 AND p.transfers+p.swaps+p.liquidity+p.pons>0 AND NOT EXISTS(SELECT 1 FROM coin_lifetime l WHERE l.coin=p.coin)',[coin])).rows.length)return 0;
  if(!await readLifetime(db,coin))await saveLifetime(db,coin,emptyLifetime());
  await preserveGraduation(db,coin,through);
  await preserveOutcomeHoldings(db,coin,through);
  const n=await compactTransfers(db,[coin],through,limit);if(n)await db.sql.query('UPDATE coin_lifetime SET revision=revision+1 WHERE coin=$1',[coin]);return n;
}
