import { MinuteSnapshot } from './minute-snapshot.js';
import { binary, hex, type Hex } from '@eko/db';
import { InputError } from '../http/v1/helpers.js';
import type { PairRow } from '@eko/shared';
import type { ReadRow, ReadStore } from './store.js';
import { decodeCursor, encodeCursor } from './pagination.js';
export function pairStage(row: Pick<PairRow,'stage'|'curvePct'|'launchpad'>): PairRow['column'] {
  // A coin that launched in a Uniswap pool never migrates: it stays under New by its launch (as read_coins.pair_column has it).
  if(row.launchpad!=='pons')return 'new';
  // TODO(spec): Owner tunes the near-graduation threshold; use 75% until then.
  return row.stage==='graduated' ? 'migrated' : (row.curvePct ?? 0)>=75 ? 'near_grad' : 'new';
}
/** Pairs show exit cost at $100: unavailable unless the sell check measured that size (CA-35). */
function exit100(entry:ReadRow):Pick<PairRow,'exitCost100Pct'|'unavailable'> {
  const unavailable=(entry.row.unavailable ?? []).filter(field=>field!=='exitCost');
  return {exitCost100Pct:entry.exit100 ?? 0,unavailable:entry.exit100==null ? [...unavailable,'exitCost'] : unavailable};
}
/** New pairs header: launches since UTC midnight (Pons curves and Uniswap pools), their median seconds from launch block to first scan, and how many were Danger at that first scan. */
export interface PairsToday { launches:number; medianFirstScanSec:number|null; refused:number }
/** Holder shares for a pair card, from the coin's card: each only when the card measured it. */
function holders(entry:ReadRow):Pick<PairRow,'top10Pct'|'devPct'|'earlyHeldPct'> {
  const card=entry.card,meta=card?.meta?.supply;
  if(!card || !meta || meta.unavailable)return {};
  const pct=(n:number)=>Math.min(100,Math.max(0,n));
  // After graduation the card's top-ten share counts the pool that holds the liquidity (96-100% on 2026-10-12), so a
  // graduated coin shows the share the holder check measured with pools left out, when that check reported one.
  const measured=card.verdict.playbooks.find(m=>m.id==='holder_concentration')?.evidence.find(e=>e.kind==='stat' && e.label==='Top 10 holders supply share')?.value;
  const top10=card.identity.stage==='graduated' ? typeof measured==='number' ? pct(measured*100) : undefined : pct(card.supply.top10Pct);
  return {...(top10===undefined ? {} : {top10Pct:top10}),devPct:pct(card.supply.devPct),...(meta.missing?.includes('bundlesHeldPct') ? {} : {earlyHeldPct:pct(card.supply.bundlesHeldPct)})};
}
export class PairsService {
  constructor(readonly store:ReadStore) {
    this.header=new MinuteSnapshot<PairsToday>({launches:0,medianFirstScanSec:null,refused:0},()=>this.computeToday(),()=>store.now());
    store.onSummaryRefresh(()=>this.header.refresh());
  }
  private header:MinuteSnapshot<PairsToday>;
  today():Promise<PairsToday> {return Promise.resolve(this.header.value);}
  refreshToday() {return this.header.refresh(true);}
  private async computeToday():Promise<PairsToday> {
    const midnight=new Date(Math.floor(this.store.now()/86400000)*86400000);
    // The first block of the UTC day is found once (either block-time table can lack a block), through the (ts,number)
    // indexes: as min(number) the planner walked the blocks from the oldest until one passed midnight (6 million rows
    // in each table, 8 s on a copy of 2026-10-13, every minute the page was open; 2 ms and the same block this way).
    // A launch's first scan is its earliest engine run by wall clock, and its first verdict the earliest by block.
    const row=(await this.store.db.sql.query<{launches:string;median:number|null;refused:string}>(`WITH cut AS (
        SELECT least((SELECT number FROM engine_block_times WHERE ts>=$1 ORDER BY ts,number LIMIT 1),(SELECT number FROM chain_blocks WHERE ts>=$1 ORDER BY ts,number LIMIT 1)) AS block),
      launched AS (SELECT r.coin,coalesce(bt.ts,cb.ts) AS at,
          (SELECT min(coalesce(e.created_at,to_timestamp(e.sec))) FROM engine_runs e WHERE e.coin=r.coin) AS scanned,
          (SELECT v.data->>'level' FROM verdicts v WHERE v.coin=r.coin ORDER BY v.valid_from_block LIMIT 1) AS first_level
        FROM read_coins r CROSS JOIN cut LEFT JOIN engine_block_times bt ON bt.number=r.first_block LEFT JOIN chain_blocks cb ON cb.number=r.first_block
        WHERE r.first_block>=cut.block)
      SELECT count(*) AS launches,
        (extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY scanned-at) FILTER (WHERE scanned IS NOT NULL AND at IS NOT NULL)))::float8 AS median,
        count(*) FILTER (WHERE first_level='danger') AS refused FROM launched`,[midnight])).rows[0];
    return {launches:Number(row.launches),medianFirstScanSec:row.median==null ? null : Math.max(0,Number(row.median)),refused:Number(row.refused)};
  }
  async row(address:Hex):Promise<PairRow | null> {
    const entry=(await this.store.rows(address))[0];
    if(!entry?.eligible)return null;
    const count=await this.store.db.sql.query<{count:string}>('SELECT buyers AS count FROM read_coins WHERE coin=$1',[binary(address)]);
    return {...entry.row,column:pairStage(entry.row),buyers:Number(count.rows[0]?.count ?? 0),...exit100(entry),...holders(entry),
      antiSnipe:entry.card?.meta?.tradeability?.missing?.includes('antiSnipeTiming') ? undefined : entry.card?.tradeability.antiSnipe,
      verdictPending:entry.row.verdictPending ?? false};
  }
  async list(stage:PairRow['column'],cursor?:string,blueChipOnly=false) {
    await this.store.currentModels();
    const key=decodeCursor(cursor,`pairs:${stage}`);
    if(key && (key.length!==2 || !Number.isSafeInteger(key[0]) || typeof key[1]!=='string' || !/^0x[0-9a-f]{40}$/.test(key[1])))throw new InputError('Invalid pairs cursor');
    const params:unknown[]=[stage];if(key)params.push(key[0],binary(key[1] as Hex));
    const category=blueChipOnly && this.store.blueChip?.config.enabled ? `AND ${this.store.blueChip.predicate('read_coins.coin',params)}` : '';
    const selected=await this.store.db.sql.query<{coin:Uint8Array;pair_block:string;buyers:string}>(`SELECT coin,pair_block,buyers FROM read_coins
      WHERE pair_column=$1 ${key ? 'AND (pair_block,coin)<($2,$3)' : ''} ${category} ORDER BY pair_block DESC,coin DESC LIMIT 101`,params);
    const page=selected.rows.slice(0,100),details=await this.store.rows(undefined,page.map(r=>hex(r.coin)));
    const indexed=new Map(details.map(e=>[e.row.address,e]));
    const last=page.at(-1);
    return {rows:page.map(r=>{const e=indexed.get(hex(r.coin))!;return {...e.row,column:stage,buyers:Number(r.buyers),...exit100(e),...holders(e),verdictPending:e.row.verdictPending ?? false,antiSnipe:e.card?.meta?.tradeability?.missing?.includes('antiSnipeTiming') ? undefined : e.card?.tradeability.antiSnipe};}),
      cursor:selected.rows.length>100 && last ? encodeCursor(`pairs:${stage}`,[Number(last.pair_block),hex(last.coin)]) : null,delayedSec:0,
      // The page header's counts ride on the first New page.
      ...(stage==='new' && !key ? {today:await this.today()} : {})};
  }
}
