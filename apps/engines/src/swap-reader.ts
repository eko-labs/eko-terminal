import { binary, type ChainDb } from '@eko/db';
import type { Address } from '@eko/shared';
import { prepareSwap } from './aggregates.js';
import type { SwapRow } from './sources.js';

export const SWAP_PAGE_SIZE = 2000;
const MAX_ROWS = 1_000_000, MAX_COINS = 128;
interface Entry { revision:string; through:number; rows:SwapRow[] }
interface State { entries:Map<Address,Entry>; pending:Map<Address,Promise<SwapRow[]>>; seeded:Set<Address> }
const states=new WeakMap<ChainDb,State>();
/** Cold replay/history reads are keyset pages, never a sort/materialization of an entire coin in one statement. */
export async function swapPages(db:ChainDb,coin:Address,through:number,after=-1,projection:'all'|'replay'='all') {
  const rows:SwapRow[]=[],columns=projection==='replay' ? 'block,ts,tx_hash,log_index,trader,recipient,side,amount_coin,amount_quote,price_quote,usd,venue,pool_id,quote_asset' : '*';
  let cursor:SwapRow|undefined;
  for (;;) {
    const params:unknown[]=[binary(coin),after,through,SWAP_PAGE_SIZE];
    const seek=cursor ? ' AND (block,log_index,tx_hash,ts)>($5::bigint,$6::integer,$7::bytea,$8::timestamptz)' : '';
    if(cursor)params.push(cursor.block,cursor.log_index,cursor.tx_hash,cursor.ts);
    const page=(await db.sql.query<SwapRow>(`SELECT ${columns} FROM raw_history_live_swaps WHERE coin=$1 AND block>$2 AND block<=$3${seek}
      ORDER BY block,log_index,tx_hash,ts LIMIT $4`,params)).rows.map(prepareSwap);
    rows.push(...page);
    if(page.length<SWAP_PAGE_SIZE)return rows;
    cursor=page.at(-1);
  }
}
/**
 * Lifetime checks need the exact prefix. Keep it per coin, append only new blocks, and invalidate on same-block
 * inserts, old backfills, pricing/sender repairs and deletes. Generations are unconditional statement triggers,
 * independent of the optional live activity feed. The process cache has both a coin and row budget.
 */
export async function incrementalSwaps(db:ChainDb,coin:Address,block:number):Promise<SwapRow[]> {
  let state=states.get(db);if(!state){state={entries:new Map(),pending:new Map(),seeded:new Set()};states.set(db,state);}
  const pending=state.pending.get(coin);if(pending){await pending;return incrementalSwaps(db,coin,block);}
  const read=(async()=>{
    // Existing production history is seeded per coin through its index, not backfilled in a migration.
    if(!state.seeded.has(coin))await db.sql.query(`INSERT INTO engine_swap_versions AS v(coin,revision,high_block)
      SELECT $1,0,coalesce(max(block),-1) FROM raw_history_live_swaps WHERE coin=$1
      ON CONFLICT(coin) DO UPDATE SET high_block=greatest(v.high_block,excluded.high_block),
        revision=v.revision+CASE WHEN v.high_block<excluded.high_block THEN 1 ELSE 0 END`,[binary(coin)]);
    state.seeded.add(coin);
    const version=async()=> (await db.sql.query<{revision:string;high_block:string}>(
      'SELECT revision::text,high_block::text FROM engine_swap_versions WHERE coin=$1',[binary(coin)])).rows[0];
    for(let attempt=0;attempt<3;attempt++) {
      const before=await version(),existing=state.entries.get(coin);
      const compatible=existing?.revision===before.revision;
      const through=Math.min(block,Number(before.high_block));
      const rows=compatible && through<=existing.through ? existing.rows
        : [...(compatible ? existing.rows : []),...await swapPages(db,coin,through,compatible ? existing.through : -1)];
      const after=await version();
      if(before.revision!==after.revision)continue;
      // A newer append above the checkpoint is harmless; one inside it needs another pass.
      if(Number(after.high_block)>Number(before.high_block) && Number(before.high_block)<block)continue;
      state.entries.delete(coin);
      state.entries.set(coin,{revision:after.revision,through:compatible ? Math.max(existing.through,through) : through,rows});
      let size=0;for(const entry of state.entries.values())size+=entry.rows.length;
      while(size>MAX_ROWS || state.entries.size>MAX_COINS) {
        const key=state.entries.keys().next().value!;size-=state.entries.get(key)!.rows.length;state.entries.delete(key);
      }
      if(through>= (compatible ? existing.through : through))return rows;
      return rows.filter(row=>Number(row.block)<=block);
    }
    throw new Error('Swap history changed during incremental read');
  })();
  state.pending.set(coin,read);
  try{return await read;}finally{state.pending.delete(coin);}
}
