import { createHash } from 'node:crypto';
import { binary, hex, type ChainDb } from '@eko/db';
import type { Address, Hex } from '@eko/shared';
import { seconds } from './sources.js';
export interface BlockTime { number: number; sec: number }
export interface Header { timestamp: bigint; hash: Hex | null }
export interface BlockReader { (block: number): Promise<Header>; readMany?: (blocks:number[]) => Promise<Header[]> }
export interface ClockRow { ts:Date; hash:Uint8Array | null }
export type ClockCache = Map<number,ClockRow>;
export interface Activity { coin: Address; block: number; sec: number; kind: string; low: number | null; high: number | null; price: number | null }
export interface CoinActivity { coin: Address; firstBlock: number; createdSec: number; events: Activity[]; revision: string; base?: ActivityBase }
/** Timestamped event rows establish real block times; never populate the indexer's head-follower table. */
/** Blocks re-read below the last synced block on every incremental pass: covers the indexer's reorg window. */
export const CLOCK_LOOKBACK_BLOCKS = 512;
/** Block times a process keeps in its clock cache; the oldest entries go first (resolveClock reads them again). */
export const CLOCK_CACHE_LIMIT = 100_000;
/** Blocks re-read below the previous live poll on every poll: the indexer's reorg window (INDEX_REORG_DEPTH). */
export const ACTIVITY_LOOKBACK_BLOCKS = 256;
const clockSynced = new WeakMap<ChainDb, number>();
/**
 * Each call reads only blocks above the previous pass minus CLOCK_LOOKBACK_BLOCKS. The first call in a process starts
 * from the newest stored block time; only an empty table is copied in full. Scanning all swaps, transfers, liquidity
 * and Pons events on every poll held the database's disk most of the time in production (2026-10-08) and starved the
 * indexer, and the full copy on a restart outlasted the engines stall watchdog. A row written later for an older block
 * is still found by resolveClock, which falls back to chain_blocks and then the archive.
 *
 * The cache is filled lazily and bounded (CLOCK_CACHE_LIMIT): it holds the newest re-read ranges and whatever
 * resolveClock looked up, never the whole table (in production the full copy no longer fit in the heap). Every reader
 * falls back to the database on a miss; readers that search block times by time (ReplayCache) load the clock from the
 * database instead of iterating the cache.
 */
export async function refreshClock(db: ChainDb, cache?:ClockCache) {
  let prior = clockSynced.get(db);
  if (prior === undefined) {
    const stored = (await db.sql.query<{ n: string | null }>('SELECT max(number)::text AS n FROM engine_block_times')).rows[0]?.n;
    if (stored != null) prior = Number(stored);
  }
  const from = prior === undefined ? -1 : Math.max(-1, prior - CLOCK_LOOKBACK_BLOCKS);
  // Transfers are indexed by time, not block: bound them by the time of the first re-read block (minus a margin).
  const since = from < 0 ? null : (await db.sql.query<{ ts: Date }>(
    `SELECT ts - interval '10 minutes' AS ts FROM engine_block_times WHERE number<=$1 ORDER BY number DESC LIMIT 1`, [from])).rows[0]?.ts ?? null;
  await db.sql.query(`INSERT INTO engine_block_times(number,ts,hash,source)
    SELECT block,min(ts),NULL,'activity' FROM (
      SELECT block,ts FROM raw_history_live_swaps WHERE block>$1
      UNION ALL SELECT block,ts FROM raw_history_live_transfers WHERE block>$1 AND ($2::timestamptz IS NULL OR ts>=$2)
      UNION ALL SELECT block,ts FROM liquidity_events WHERE block>$1
    ) e GROUP BY block ON CONFLICT(number) DO NOTHING`, [from, since]);
  // Rewrite only rows that changed, or each poll leaves a dead copy of every row.
  await db.sql.query(`INSERT INTO engine_block_times(number,ts,hash,source) SELECT number,ts,hash,'head' FROM chain_blocks WHERE number>$1
    ON CONFLICT(number) DO UPDATE SET ts=excluded.ts,hash=excluded.hash,source=excluded.source
    WHERE (engine_block_times.ts,engine_block_times.hash,engine_block_times.source) IS DISTINCT FROM (excluded.ts,excluded.hash,excluded.source)`, [from]);
  // Legacy Pons/pool rows may lack timestamps entirely. Accept actual stored fields
  // when present, including JSON payload timestamps; never infer a block interval.
  // Only rows that carry one of those fields are read (a full copy would otherwise load every Pons event).
  const stored=(await db.sql.query<{block:string;data:Record<string,unknown>}>(`SELECT block,data FROM pons_events WHERE block>$1 AND (data ? 'ts' OR data ? 'timestamp' OR data ? 'blockTimestamp')
    UNION ALL SELECT created_block,data FROM (SELECT created_block,to_jsonb(p) AS data FROM pools p WHERE created_block>$1) p WHERE data ? 'ts' OR data ? 'timestamp' OR data ? 'blockTimestamp'`, [from])).rows;
  const timestamps=new Map<number,Date>();
  for(const row of stored) {
    const raw=row.data.ts ?? row.data.timestamp ?? row.data.blockTimestamp;
    if(typeof raw!=='string' && typeof raw!=='number')continue;
    const numeric=typeof raw==='number' || /^(?:0x[\da-f]+|\d+)$/.test(raw);
    const ms=numeric ? Number(raw)*1000 : Date.parse(raw);
    if(Number.isFinite(ms) && ms>=0 && ms<=8640000000000000)timestamps.set(Number(row.block),new Date(ms));
  }
  const entries=[...timestamps];
  for(let offset=0;offset<entries.length;offset+=250) {
    const params:unknown[]=[],values=entries.slice(offset,offset+250).map(([block,ts])=>{params.push(block,ts);return `($${params.length-1},$${params.length},NULL,'activity')`;});
    await db.sql.query(`INSERT INTO engine_block_times VALUES ${values.join(',')} ON CONFLICT(number) DO NOTHING`,params);
  }
  const top=(await db.sql.query<{ n: string | null }>('SELECT max(number)::text AS n FROM engine_block_times')).rows[0]?.n;
  if(cache) {
    // Only the re-read range is refreshed, never the whole table (a full copy caches its newest blocks only), and the
    // cache stays bounded: every reader falls back to the database for a block it does not hold.
    if (from < 0) cache.clear();
    const lower=from<0 && top!=null ? Number(top)-CLOCK_LOOKBACK_BLOCKS : from;
    for(const row of (await db.sql.query<ClockRow & {number:string}>('SELECT number,ts,hash FROM engine_block_times WHERE number>$1',[lower])).rows)cache.set(Number(row.number),{ts:row.ts,hash:row.hash});
    if(cache.size>CLOCK_CACHE_LIMIT)for(const number of [...cache.keys()].slice(0,cache.size-CLOCK_CACHE_LIMIT/2))cache.delete(number);
  }
  if (top != null) clockSynced.set(db, Math.max(prior ?? -1, Number(top)));
}
export async function resolveClock(db: ChainDb, block: number, readBlock?: BlockReader, cache?:ClockCache) {
  if(cache?.has(block))return cache.get(block);
  let row=(await db.sql.query<{ ts:Date;hash:Uint8Array | null }>('SELECT ts,hash FROM engine_block_times WHERE number=$1',[block])).rows[0];
  if (!row) {
    const head=(await db.sql.query<{ ts:Date;hash:Uint8Array }>('SELECT ts,hash FROM chain_blocks WHERE number=$1',[block])).rows[0];
    if (head) { await db.sql.query("INSERT INTO engine_block_times VALUES($1,$2,$3,'head') ON CONFLICT DO NOTHING",[block,head.ts,head.hash]);row=head; }
  }
  if (!row && readBlock) {
    const header=await readBlock(block);
    await db.sql.query("INSERT INTO engine_block_times VALUES($1,to_timestamp($2),$3,'archive') ON CONFLICT(number) DO UPDATE SET ts=excluded.ts,hash=excluded.hash,source=excluded.source",[block,Number(header.timestamp),header.hash ? binary(header.hash) : null]);
    row=(await db.sql.query<{ ts:Date;hash:Uint8Array | null }>('SELECT ts,hash FROM engine_block_times WHERE number=$1',[block])).rows[0];
  }
  if(row)cache?.set(block,row);
  return row;
}
/** One activity row: a coin's events of one kind in one block (a coin's pools created in one block are one row each). */
export interface ActivityRow { coin:Uint8Array;block:string;ts:Date;kind:string;low:number | null;high:number | null;price:number | null;revision:string }
/** Coin activity rows in (from, to] per coin: `coins[i]` in (`from[i]`, `to[i]`]. Each coin is read through its own indexes. */
export interface CoinRanges { coins:Address[];from:number[];to:number[] }
/**
 * Which rows an activity read covers: every coin through `to`; per-coin block ranges; or every coin's rows in the window
 * (`after`, `to`], with transfers bounded by `since` (they have no block index) plus the transfers of `transfers` by
 * token, so a transfer whose time is out of order with its block is still read.
 */
export type ActivityScope = { ranges:CoinRanges } | { after:number;since:Date | null;transfers:Address[] };
// Per-coin ranges join each source table through a lateral subquery on the coin's index, never a scan of the table.
const ranged=(table:string)=>`unnest($1::bytea[],$2::bigint[],$3::bigint[]) AS r(c,lo,hi) CROSS JOIN LATERAL (${table}) x`;
function activitySql(scope?:ActivityScope) {
  const swaps=`SELECT block,min(ts) AS ts,min(price_quote) AS low,max(price_quote) AS high,
      (array_agg(price_quote ORDER BY log_index DESC,tx_hash DESC))[1] AS price,
      count(*)::text||':'||count(usd)::text||':'||(count(*) FILTER(WHERE senders_pending))::text||':'||coalesce(string_agg(coalesce(encode(trader,'hex'),'missing'),',' ORDER BY log_index,tx_hash),'') AS revision`;
  const liquidity=`SELECT e.block,min(e.ts) AS ts,count(*)::text||':'||(count(*) FILTER(WHERE e.senders_pending))::text||':'||coalesce(string_agg(coalesce(encode(e.actor,'hex'),'missing'),',' ORDER BY e.log_index,e.tx_hash),'') AS revision`;
  if(scope && 'ranges' in scope) return `WITH activity AS (
    SELECT r.c AS coin,x.block,'swap' AS kind,x.ts,x.low,x.high,x.price,x.revision FROM ${ranged(`${swaps} FROM raw_history_live_swaps WHERE coin=r.c AND block>r.lo AND block<=r.hi GROUP BY block`)}
    UNION ALL SELECT r.c,x.block,'transfer',x.ts,NULL,NULL,NULL,x.revision FROM ${ranged('SELECT block,min(ts) AS ts,count(*)::text AS revision FROM raw_history_live_transfers WHERE token=r.c AND block>r.lo AND block<=r.hi GROUP BY block')}
    UNION ALL SELECT r.c,x.block,'liquidity',x.ts,NULL,NULL,NULL,x.revision FROM ${ranged(`${liquidity} FROM (SELECT id FROM pools WHERE currency0=r.c UNION SELECT id FROM pools WHERE currency1=r.c) p
      CROSS JOIN LATERAL (SELECT * FROM liquidity_events WHERE pool_id=p.id AND block>r.lo AND block<=r.hi OFFSET 0) e GROUP BY e.block`)}
    UNION ALL SELECT r.c,x.block,'pons',x.ts,NULL,NULL,NULL,x.revision FROM ${ranged(`SELECT e.block,b.ts,count(*)::text AS revision FROM pons_events e JOIN engine_block_times b ON b.number=e.block
      WHERE e.token=r.c AND e.block>r.lo AND e.block<=r.hi GROUP BY e.block,b.ts`)}
    UNION ALL SELECT r.c,x.block,'exemption',x.ts,NULL,NULL,NULL,x.revision FROM ${ranged(`SELECT e.block,b.ts,count(*)::text AS revision FROM pons_exemptions e JOIN engine_block_times b ON b.number=e.block
      WHERE e.token=r.c AND e.block>r.lo AND e.block<=r.hi GROUP BY e.block,b.ts`)}
    UNION ALL SELECT r.c,x.block,'pair',x.ts,NULL,NULL,NULL,'1' FROM ${ranged(`SELECT p.created_block AS block,b.ts FROM pools p JOIN engine_block_times b ON b.number=p.created_block
      WHERE (p.currency0=r.c OR p.currency1=r.c) AND p.created_block>r.lo AND p.created_block<=r.hi`)}
    )`;
  const after=!!scope && 'after' in scope;
  const above=(column:string)=>after ? ` AND ${column}>$2` : '';
  const transfers=after ? `(SELECT ts,tx_hash,log_index,token,block FROM raw_history_live_transfers WHERE block<=$1 AND block>$2 AND ($3::timestamptz IS NULL OR ts>=$3)
      UNION SELECT ts,tx_hash,log_index,token,block FROM raw_history_live_transfers WHERE block<=$1 AND block>$2 AND token=ANY($4)) t`
    : 'raw_history_live_transfers WHERE block<=$1';
  return `WITH activity AS (
    SELECT coin,block,'swap' AS kind,min(ts) AS ts,min(price_quote) AS low,max(price_quote) AS high,
      (array_agg(price_quote ORDER BY log_index DESC,tx_hash DESC))[1] AS price,
      count(*)::text||':'||count(usd)::text||':'||(count(*) FILTER(WHERE senders_pending))::text||':'||coalesce(string_agg(coalesce(encode(trader,'hex'),'missing'),',' ORDER BY log_index,tx_hash),'') AS revision FROM raw_history_live_swaps WHERE block<=$1${above('block')} GROUP BY coin,block
    UNION ALL SELECT token,block,'transfer',min(ts),NULL,NULL,NULL,count(*)::text FROM ${transfers} GROUP BY token,block
    UNION ALL SELECT t.address,e.block,'liquidity',min(e.ts),NULL,NULL,NULL,count(*)::text||':'||(count(*) FILTER(WHERE e.senders_pending))::text||':'||coalesce(string_agg(coalesce(encode(e.actor,'hex'),'missing'),',' ORDER BY e.log_index,e.tx_hash),'') FROM liquidity_events e
      JOIN pools p ON p.id=e.pool_id JOIN tokens t ON t.address=p.currency0 OR t.address=p.currency1 WHERE e.block<=$1${above('e.block')} GROUP BY t.address,e.block
    UNION ALL SELECT token,e.block,'pons',b.ts,NULL,NULL,NULL,count(*)::text FROM pons_events e
      JOIN engine_block_times b ON b.number=e.block WHERE e.block<=$1${above('e.block')} GROUP BY token,e.block,b.ts
    UNION ALL SELECT token,e.block,'exemption',b.ts,NULL,NULL,NULL,count(*)::text FROM pons_exemptions e
      JOIN engine_block_times b ON b.number=e.block WHERE e.block<=$1${above('e.block')} GROUP BY token,e.block,b.ts
    UNION ALL SELECT t.address,p.created_block,'pair',b.ts,NULL,NULL,NULL,'1' FROM pools p
      JOIN tokens t ON t.address=p.currency0 OR t.address=p.currency1 JOIN engine_block_times b ON b.number=p.created_block WHERE p.created_block<=$1${above('p.created_block')}
    )`;
}
const scopeParams=(to:number,scope?:ActivityScope):unknown[]=>!scope ? [to] : 'ranges' in scope ? [scope.ranges.coins.map(binary),scope.ranges.from,scope.ranges.to]
  : [to,scope.after,scope.since,scope.transfers.map(binary)];
/** One newest indexed row per source (and per pool), without materializing distinct block sets. */
async function nextActivityBlock(db:ChainDb,coin:Address,after:number,to:number) {
  return Number((await db.sql.query<{block:string | null}>(`SELECT greatest(
    (SELECT block FROM raw_history_live_swaps WHERE coin=$1 AND block>$2 AND block<=$3 ORDER BY block DESC LIMIT 1),
    (SELECT block FROM raw_history_live_transfers WHERE token=$1 AND block>$2 AND block<=$3 ORDER BY block DESC LIMIT 1),
    (SELECT e.block FROM (SELECT id FROM pools WHERE currency0=$1 UNION SELECT id FROM pools WHERE currency1=$1) p
      CROSS JOIN LATERAL (SELECT block FROM liquidity_events WHERE pool_id=p.id AND block>$2 AND block<=$3 ORDER BY block DESC LIMIT 1) e ORDER BY e.block DESC LIMIT 1),
    (SELECT block FROM pons_events WHERE token=$1 AND block>$2 AND block<=$3 ORDER BY block DESC LIMIT 1),
    (SELECT block FROM pons_exemptions WHERE token=$1 AND block>$2 AND block<=$3 ORDER BY block DESC LIMIT 1),
    (SELECT created_block FROM pools WHERE currency0=$1 AND created_block>$2 AND created_block<=$3 ORDER BY created_block DESC LIMIT 1),
    (SELECT created_block FROM pools WHERE currency1=$1 AND created_block>$2 AND created_block<=$3 ORDER BY created_block DESC LIMIT 1)
  )::text AS block`,[binary(coin),after,to])).rows[0]?.block ?? after);
}
interface CachedActivity { from:number;to:number;revision:string;rows:ActivityRow[] }
const activityCaches=new WeakMap<ChainDb,Map<Address,CachedActivity>>();
/** Reuse exact block aggregates; generations identify only blocks changed by append, repair, reorg or sealing. */
async function cachedActivityRows(db:ChainDb,ranges:CoinRanges) {
  const cache=activityCaches.get(db) ?? new Map<Address,CachedActivity>(),updates=new Map<Address,CachedActivity>();
  const rows=await db.tx(async tx=>{
    await tx.sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const result:ActivityRow[]=[];
    for(let i=0;i<ranges.coins.length;i++) {
      const coin=ranges.coins[i],from=ranges.from[i],to=ranges.to[i];
      if(from>=to)continue;
      const revision=(await tx.sql.query<{revision:string}>('SELECT revision::text FROM engine_activity_versions WHERE coin=$1',[binary(coin)])).rows[0]?.revision ?? '0';
      const existing=updates.get(coin) ?? cache.get(coin);
      // Another reader may have published a newer snapshot while this transaction was reading other coins.
      const prior=existing && BigInt(existing.revision)<=BigInt(revision) ? existing : undefined;
      const dirty=prior && revision!==prior.revision ? (await tx.sql.query<{block:string}>(`SELECT block::text FROM engine_activity_block_versions
        WHERE coin=$1 AND revision>$2 AND block>$3 AND block<=$4 ORDER BY revision,block`,[binary(coin),prior.revision,prior.from,prior.to])).rows.map(row=>Number(row.block)) : [];
      const changed=new Set(dirty),kept=prior?.rows.filter(row=>!changed.has(Number(row.block))) ?? [];
      const read=async(lo:number,hi:number)=> {
        if(lo>=hi)return;
        const upper=await nextActivityBlock(tx,coin,lo,hi);
        // Empty ranges need no aggregation. A nonempty cold range is read once, not once per DISTINCT page.
        if(upper<=lo)return;
        const scope={ranges:{coins:[coin],from:[lo],to:[upper]}};
        for(const row of (await tx.sql.query<ActivityRow>(`${activitySql(scope)} SELECT * FROM activity ORDER BY coin,block,kind`,scopeParams(upper,scope))).rows)kept.push(row);
      };
      if(!prior)await read(from,to);
      else {
        await read(from,prior.from);
        await read(prior.to,to);
        for(let offset=0;offset<dirty.length;offset+=128) {
          const blocks=dirty.slice(offset,offset+128),scope={ranges:{coins:blocks.map(()=>coin),from:blocks.map(b=>b-1),to:blocks}};
          for(const row of (await tx.sql.query<ActivityRow>(`${activitySql(scope)} SELECT * FROM activity ORDER BY coin,block,kind`,scopeParams(0,scope))).rows)kept.push(row);
        }
      }
      kept.sort((a,b)=>Number(a.block)-Number(b.block) || a.kind.localeCompare(b.kind));
      updates.set(coin,{from:Math.min(from,prior?.from ?? from),to:Math.max(to,prior?.to ?? to),revision,rows:kept});
      for(const row of kept)if(Number(row.block)>from && Number(row.block)<=to)result.push(row);
    }
    return result.sort((a,b)=>hex(a.coin).localeCompare(hex(b.coin)) || Number(a.block)-Number(b.block) || a.kind.localeCompare(b.kind));
  });
  // Publish cache entries only after the read transaction succeeds; concurrent older snapshots cannot poison newer ones.
  for(const [coin,entry] of updates)if(BigInt(entry.revision)>=BigInt(cache.get(coin)?.revision ?? '-1')){cache.delete(coin);cache.set(coin,entry);}
  let size=0;for(const entry of cache.values())size+=entry.rows.length;
  while(cache.size>10000 || size>200000){const coin=cache.keys().next().value!;size-=cache.get(coin)!.rows.length;cache.delete(coin);}
  activityCaches.set(db,cache);
  return rows;
}
/** Activity rows through `to` or coin ranges, in coin/block/kind order. */
export async function activityRows(db:ChainDb,to:number,scope?:ActivityScope) {
  if(scope && 'ranges' in scope)return cachedActivityRows(db,scope.ranges);
  return (await db.sql.query<ActivityRow>(`${activitySql(scope)} SELECT * FROM activity ORDER BY coin,block,kind`,scopeParams(to,scope))).rows;
}
/** An activity row as a checkpoint event, and its part of the coin's revision. */
export const activityEvent=(coin:Address,row:ActivityRow):Activity=>({coin,block:Number(row.block),sec:seconds(row.ts),kind:row.kind,low:row.low,high:row.high,price:row.price});
export const revisionPart=(row:{block:string;kind:string;revision:string})=>`${row.block}:${row.kind}:${row.revision}`;
const MASK=(1n<<128n)-1n;
/**
 * A row's share of its coin's revision: the md5 of its part as a 128-bit number. A coin's revision sums its rows'
 * shares modulo 2^128, so it changes whenever any row is added, removed or rewritten, and a poll can update it from the
 * rows it re-read instead of re-reading the coin's history (live-activity.ts). activitySums computes the same in SQL.
 */
export function partHash(part:string) {const h=createHash('md5').update(part).digest('hex');return (BigInt(`0x${h.slice(0,16)}`)<<64n)+BigInt(`0x${h.slice(16)}`);}
/** A coin's revision: the launch fields the engines read and the sum of its rows' shares. */
export const coinRevision=(supplyBlock:string | null,graduatedBlock:string | null,sum:bigint)=>`${supplyBlock}:${graduatedBlock}:${(sum & MASK).toString(16).padStart(32,'0')}`;
/**
 * Live progress kept per coin (engine_activity_state): the share sum and newest event time of the coin's rows at or
 * below `baseBlock` (null when it has none), so that the next poll re-reads only the rows above it.
 */
export interface ActivityBase { baseBlock:number;baseSum:bigint;baseSec:number | null }
/** Per coin: the share sum and newest event time (seconds, null without rows) of its rows in each range. */
export async function activitySums(db:ChainDb,ranges:CoinRanges) {
  const sums=new Map<Address,{sum:bigint;sec:number | null}>(ranges.coins.map(coin=>[coin,{sum:0n,sec:null}]));
  // Hash the exact same ordered block revisions as the full SQL sum. No unbounded CTE on a cold/repaired coin.
  for(const row of await activityRows(db,0,{ranges})) {
    const sum=sums.get(hex(row.coin))!;
    sum.sum=(sum.sum+partHash(revisionPart(row))) & MASK;
    sum.sec=Math.max(sum.sec ?? -Infinity,seconds(row.ts));
  }
  return sums;
}
/**
 * Pons/pool logs have no timestamp column, and a launch or pool block may have no indexed event. Blocks among them
 * through `to` (for every coin, above `after`, or for the given coins) that have no stored time yet, in ascending order.
 */
export async function clockGaps(db:ChainDb,to:number,scope?:{after:number} | {coins:Address[]}) {
  const coins=!!scope && 'coins' in scope;
  const where=(coin:string,block:string)=>!scope ? '' : coins ? ` AND ${coin}=ANY($2)` : ` AND ${block}>$2`;
  return (await db.sql.query<{block:string}>(`SELECT DISTINCT e.block FROM (
    SELECT block FROM pons_events WHERE true${where('token','block')} UNION ALL SELECT block FROM pons_exemptions WHERE true${where('token','block')}
    UNION ALL SELECT created_block FROM pools WHERE true${!scope ? '' : coins ? ' AND (currency0=ANY($2) OR currency1=ANY($2))' : ' AND created_block>$2'}
    UNION ALL SELECT first_block FROM tokens WHERE true${where('address','first_block')}
    ) e LEFT JOIN engine_block_times b ON b.number=e.block WHERE e.block<=$1 AND b.number IS NULL ORDER BY e.block`,
  !scope ? [to] : coins ? [to,scope.coins.map(binary)] : [to,scope.after])).rows.map(row=>Number(row.block));
}
/**
 * Resolve missing clocks explicitly from archive headers; silently dropping their events would also drop catch-up
 * candidates from backfilled ranges. Returns false when stopped before all were stored.
 */
export async function fillClockGaps(db:ChainDb,gaps:number[],readBlock:BlockReader | undefined,cache:ClockCache,concurrency:number,stopped:()=>boolean) {
  const width=readBlock?.readMany ? 50 : concurrency;
  for(let offset=0;offset<gaps.length;offset+=width) {
    if(stopped())return false;
    const blocks=gaps.slice(offset,offset+width);
    if(!readBlock)throw new Error(`Missing activity timestamp at block ${blocks[0]}; provide RPC_HTTP_URL for archive headers`);
    const headers=readBlock.readMany ? await readBlock.readMany(blocks) : await Promise.all(blocks.map(block=>readBlock(block)));
    if(headers.length!==blocks.length)throw new Error('Incomplete archive header batch');
    const params:unknown[]=[],values=headers.map((header,i)=>{
      const ts=new Date(Number(header.timestamp)*1000),hash=header.hash ? binary(header.hash) : null;
      cache.set(blocks[i],{ts,hash});params.push(blocks[i],ts,hash);
      return `($${params.length-2},$${params.length-1},$${params.length},'archive')`;
    });
    await db.sql.query(`INSERT INTO engine_block_times VALUES ${values.join(',')} ON CONFLICT(number) DO NOTHING`,params);
  }
  return true;
}
/**
 * Every launched coin's whole activity through `to`, aggregated once across coins rather than scanning every coin at
 * every indexed block, with each coin's revision and progress base at `to - ACTIVITY_LOOKBACK_BLOCKS` (unless
 * `revisions` is false: replay does not compare revisions). Retrospective replay reads activity this way. Live polls
 * read only what changed (live-activity.ts), or this with ENGINE_LIVE_ACTIVITY=full.
 */
export async function coinActivity(db: ChainDb, to: number, readBlock?: BlockReader, cache:ClockCache=new Map(), concurrency=4, stopped:()=>boolean=()=>false, revisions=true): Promise<CoinActivity[]> {
  if(!await fillClockGaps(db,await clockGaps(db,to),readBlock,cache,concurrency,stopped))return [];
  const coins=(await db.sql.query<{address:Uint8Array}>('SELECT address FROM tokens WHERE first_block<=$1',[to])).rows.map(row=>hex(row.address));
  const rows=await activityRows(db,to,{ranges:{coins,from:coins.map(()=>-1),to:coins.map(()=>to)}});
  const baseBlock=to-ACTIVITY_LOOKBACK_BLOCKS;
  const events=new Map<Address,Activity[]>(), sums=new Map<Address,{sum:bigint;base:bigint;baseSec:number | null}>();
  for (const row of rows) {
    const coin=hex(row.coin), list=events.get(coin) ?? [], sum=sums.get(coin) ?? {sum:0n,base:0n,baseSec:null};
    const event=activityEvent(coin,row);list.push(event);
    if(revisions){const share=partHash(revisionPart(row));sum.sum+=share;if(event.block<=baseBlock){sum.base+=share;sum.baseSec=Math.max(sum.baseSec ?? -Infinity,event.sec);}}
    events.set(coin,list);sums.set(coin,sum);
  }
  const tokens=(await db.sql.query<{ address:Uint8Array;first_block:string;supply_block:string | null;graduated_block:string | null }>('SELECT address,first_block,supply_block,graduated_block FROM tokens WHERE first_block<=$1 ORDER BY first_block,address',[to])).rows;
  // Launch times in one read: the clock cache is filled lazily (refreshClock), and resolveClock reads one block at a time.
  const firsts=[...new Set(tokens.map(token=>Number(token.first_block)).filter(block=>!cache.has(block)))];
  if(firsts.length)for(const row of (await db.sql.query<ClockRow & {number:string}>('SELECT number,ts,hash FROM engine_block_times WHERE number=ANY($1)',[firsts])).rows)cache.set(Number(row.number),{ts:row.ts,hash:row.hash});
  const result:CoinActivity[]=[];
  for (const token of tokens) {
    const coin=hex(token.address), time=await resolveClock(db,Number(token.first_block),readBlock,cache);
    if (!time) throw new Error(`Missing launch timestamp at block ${token.first_block}; provide RPC_HTTP_URL for archive headers`);
    const sum=sums.get(coin) ?? {sum:0n,base:0n,baseSec:null};
    result.push({coin,firstBlock:Number(token.first_block),createdSec:seconds(time.ts),events:events.get(coin) ?? [],
      revision:coinRevision(token.supply_block,token.graduated_block,sum.sum),base:{baseBlock,baseSum:sum.base & MASK,baseSec:sum.baseSec}});
  }
  return result;
}
/** Block-number lookup over a clock ordered by number, without building a map of every block. */
export function blockIndex(clock:readonly BlockTime[]) {
  return {get(block:number):BlockTime | undefined {
    let low=0,high=clock.length;
    while(low<high){const mid=(low+high)>>>1;if(clock[mid].number<block)low=mid+1;else high=mid;}
    return clock[low]?.number===block ? clock[low] : undefined;
  }};
}
function lowerBound(clock: BlockTime[], sec:number, low=0) {
  let high=clock.length;
  while(low<high){const mid=(low+high)>>>1;if(clock[mid].sec<sec)low=mid+1;else high=mid;}
  return low;
}
export interface Checkpoint { coin:Address;block:number;sec:number }
/** Checkpoint cadence state between blocks (checkpoints). */
export interface Cadence { lastRun:number;lastActivity:number;lastTrade:number;lastPrice:number | null;lastObservedPrice:number | null }
/**
 * Where a plan resumes. Every block that has non-swap activity (a transfer, liquidity, Pons or pool event) and a stored
 * time is checkpointed whatever came before it, so the cadence state right after it depends only on that block and
 * the newest swap block at or before it (live-activity.ts derives it from a few indexed reads). `index` is the first
 * clock position after `after`.
 */
export interface CadenceStart { after:number;index:number;state:Cadence }
/**
 * TODO(spec): without header history, a deadline maps to the first timestamped activity block at/after it, within TO.
 * With `start`, the plan resumes after `start.after` and needs only the events and clock points after it; deadlines
 * then map to the first point at or after them among those (block times do not decrease with height).
 */
export function checkpoints(coin:CoinActivity,clock:BlockTime[],from:number,to:number,clockIndex?:{get(block:number):BlockTime | undefined},start?:CadenceStart):Checkpoint[] {
  if (clock.length<=(start?.index ?? 0)) return [];
  const end=clock.at(-1)!.sec, chosen=new Map<number,Checkpoint>(), first=start?.index ?? 0;
  const events=new Map<number,Activity[]>();
  for(const event of coin.events){const list=events.get(event.block) ?? [];list.push(event);events.set(event.block,list);}
  // Resumed: launch offsets not yet passed at `start.after` (a block's time is at or above every earlier block's).
  const fixed=[0,2,10,60,300].filter(offset=>!start || coin.createdSec+offset>start.state.lastRun)
    .map(offset=>({block:clock[lowerBound(clock,coin.createdSec+offset,first)]?.number,sec:coin.createdSec+offset}));
  const fixedBlocks=new Set(fixed.flatMap(p=>p.block==null?[]:[p.block]));if(!start || coin.firstBlock>start.after)fixedBlocks.add(coin.firstBlock);
  const interesting=[...new Set([...events.keys(),...fixedBlocks])].filter(block=>!start || block>start.after).sort((a,b)=>a-b);
  let {lastRun,lastActivity,lastTrade,lastPrice,lastObservedPrice}:Cadence=start?.state ?? {lastRun:coin.createdSec,lastActivity:coin.createdSec,lastTrade:-Infinity,lastPrice:null,lastObservedPrice:null};
  const add=(point:BlockTime)=>{if(point.number>=from && point.number<=to)chosen.set(point.number,{coin:coin.coin,block:point.number,sec:point.sec});lastRun=point.sec;lastPrice=lastObservedPrice;};
  const periodic=(untilBlock:number,untilSec:number)=>{
    while(lastRun<untilSec){
      const deadline=lastRun+(lastRun+600-lastTrade<3600 ? 600 : 3600);
      if(deadline>=lastActivity+7*86400 || deadline>end)break;
      const point=clock[lowerBound(clock,deadline,first)];
      if(!point || point.number>=untilBlock || point.sec>untilSec || point.sec>=lastActivity+7*86400)break;
      add(point);
    }
  };
  const byBlock=clockIndex ?? new Map(clock.map(point=>[point.number,point]));
  for(const block of interesting){
    const point=byBlock.get(block);if(!point || block>to)continue;
    periodic(block,point.sec);
    const activity=events.get(block) ?? [], swaps=activity.filter(e=>e.kind==='swap');
    if(!activity.length && point.sec>=lastActivity+7*86400)continue;
    if(activity.length)lastActivity=point.sec;
    if(swaps.length){lastTrade=point.sec;lastObservedPrice=swaps.at(-1)!.price;}
    const changed=swaps.some(e=>lastPrice==null || (e.high!=null && e.high>lastPrice*1.05) || (e.low!=null && e.low<lastPrice*0.95));
    if(fixedBlocks.has(block) || changed || activity.some(e=>e.kind!=='swap'))add(point);
  }
  periodic(to+1,end);
  return [...chosen.values()].sort((a,b)=>a.block-b.block);
}
