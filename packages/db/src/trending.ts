import type { ChainDb } from './client.js';
import { hex, type Hex } from './types.js';

/** One coin of the hourly USD volume ranking before a launch block, as clone_swarm reads it (engines `sources.ts`). */
export interface TrendingRow { coin: Hex; name: string; symbol: string; created: Date; started: Date; volume: number }
interface Stored { coin: Hex; name: string; symbol: string; created: string; started: string; volume: string }

/**
 * The 50 coins with the most priced swap volume in the hour before `block` (whose time is `sinceSec + 3600`). Rows come
 * from `trending_snapshots` when retention saved one for this block (it does before deleting swaps such a window
 * reads); otherwise they are computed from swaps. `untilSec` (the block's time) only bounds the scan: swaps at or
 * before a block are never later than it, so the rows are the same.
 */
export async function trendingAt(db: ChainDb, block: number, sinceSec: number, untilSec?: number): Promise<TrendingRow[]> {
  const saved = (await db.sql.query<{ data: Stored[] }>('SELECT data FROM trending_snapshots WHERE created_block=$1', [block])).rows[0];
  if (saved) return saved.data.map(r => ({ coin: r.coin, name: r.name, symbol: r.symbol, created: new Date(r.created), started: new Date(r.started), volume: Number(r.volume) }));
  return computeTrending(db, block, sinceSec, untilSec);
}
interface VolumeRow {coin:Uint8Array;started:Date;volume:number}
const windows=new WeakMap<ChainDb,Map<string,{version:string;rows:VolumeRow[]}>>();
/** Cache only swap aggregates. Token identity/clock joins always read current metadata. */
async function computeTrending(db: ChainDb, block: number, sinceSec: number, untilSec?: number): Promise<TrendingRow[]> {
  const version=async()=> {
    const r=(await db.sql.query<{v:string}>(`SELECT coalesce(sum(revision),0)::text AS v FROM engine_window_versions WHERE bucket<=($1::bigint/10000)`,[block])).rows[0];
    return r.v;
  };
  const key=`${block}:${sinceSec}:${untilSec ?? ''}`;
  let cache=windows.get(db);if(!cache){cache=new Map();windows.set(db,cache);}
  let rows:VolumeRow[]|undefined;
  for(let attempt=0;attempt<3;attempt++) {
    const before=await version(),cached=cache.get(key);
    if(cached?.version===before){rows=cached.rows;break;}
    // A launch ranking is one hour. Always supply the upper timestamp for partition pruning.
    const end=untilSec??sinceSec+3600;
    rows=(await db.sql.query<VolumeRow>(`SELECT coin,min(ts) AS started,sum(usd) AS volume FROM swaps
      WHERE block<=$1 AND ts>to_timestamp($2) AND ts<=to_timestamp($3) AND usd>0 GROUP BY coin ORDER BY sum(usd) DESC,coin`,
      [block,sinceSec,end])).rows;
    if(before!==await version()){rows=undefined;continue;}
    cache.delete(key);cache.set(key,{version:before,rows});
    if(cache.size>256)cache.delete(cache.keys().next().value!);
    break;
  }
  if(!rows)throw new Error('Trending inputs changed during read');
  const result:TrendingRow[]=[];
  // Sorted volumes retain the original SQL order. Join only enough identities to find 50 eligible coins.
  for(let offset=0;offset<rows.length && result.length<50;offset+=50) {
    const chunk=rows.slice(offset,offset+50);
    const identity=new Map((await db.sql.query<{address:Uint8Array;name:string;symbol:string;created:Date}>(
      `SELECT t.address,t.name,t.symbol,b.ts AS created FROM tokens t JOIN engine_block_times b ON b.number=t.first_block
       WHERE t.address=ANY($1::bytea[]) AND t.name IS NOT NULL AND t.symbol IS NOT NULL`,[chunk.map(r=>r.coin)])).rows.map(r=>[hex(r.address),r]));
    for(const r of chunk) {
      const coin=hex(r.coin),t=identity.get(coin);if(!t)continue;
      result.push({coin,name:t.name,symbol:t.symbol,created:new Date(t.created),started:new Date(r.started),volume:r.volume});
      if(result.length===50)break;
    }
  }
  return result;
}

/**
 * Save the trending rows of up to `limit` launch blocks whose window starts before `horizon`'s time and which have no
 * snapshot yet, oldest first. Returns how many were saved and whether none is left. Launch blocks without a known
 * time are skipped: the engines cannot evaluate such a coin either.
 */
export async function snapshotTrending(db: ChainDb, horizon: bigint, limit: number): Promise<{ saved: number; complete: boolean }> {
  // Bound by block first (queue PK), then resolve clocks by number. Completed launches leave the queue.
  const due = (await db.sql.query<{ block: string; ts: Date }>(`SELECT q.created_block AS block,coalesce(e.ts,c.ts) AS ts
    FROM trending_snapshot_queue q LEFT JOIN engine_block_times e ON e.number=q.created_block LEFT JOIN chain_blocks c ON c.number=q.created_block
    WHERE q.created_block<=(SELECT number FROM chain_blocks
      WHERE ts<(SELECT ts FROM chain_blocks WHERE number=$1)+interval '1 hour' ORDER BY ts DESC,number DESC LIMIT 1)
      AND coalesce(e.ts,c.ts)<(SELECT ts FROM chain_blocks WHERE number=$1)+interval '1 hour'
    ORDER BY q.created_block LIMIT $2`, [horizon.toString(), limit + 1])).rows;
  for (const row of due.slice(0, limit)) {
    const sec = new Date(row.ts).getTime() / 1000;
    const exists=(await db.sql.query('SELECT 1 FROM trending_snapshots WHERE created_block=$1',[row.block])).rows.length;
    const rows = exists ? [] : await computeTrending(db, Number(row.block), sec - 3600, sec + 1);
    const data: Stored[] = rows.map(r => ({ coin: r.coin, name: r.name, symbol: r.symbol, created: r.created.toISOString(), started: r.started.toISOString(), volume: String(r.volume) }));
    await db.sql.query('INSERT INTO trending_snapshots VALUES($1,$2) ON CONFLICT(created_block) DO NOTHING', [row.block, JSON.stringify(data)]);
    await db.sql.query('DELETE FROM trending_snapshot_queue WHERE created_block=$1',[row.block]);
  }
  return { saved: Math.min(limit, due.length), complete: due.length <= limit };
}
