import { HEADER_TODAY_SQL, HEADER_HOURS_SQL } from './header-totals.js';
import { MinuteSnapshot } from './minute-snapshot.js';
import { hex } from '@eko/db';
import { sellRefusalTotals } from '@eko/engines';
import { InputError } from '../http/v1/helpers.js';
import type { RadarRow } from '@eko/shared';
import type { ReadRow, ReadStore } from './store.js';
import { decodeCursor, encodeCursor } from './pagination.js';
// TODO(spec): Pending tier is unspecified; place it between Monitor and Danger (task 023).
/**
 * Radar rank: the most traded coins of the last hour first, whatever their grade. Ranking by grade first (no match, then
 * Monitor, pending, Danger) filled the first 124 pages with quiet coins once "no match" became the largest grade: on
 * 2026-10-12 the first page held 100 of them trading $700-3,000 an hour, while the coins trading $12,000-60,000 an hour
 * (Monitor and Danger, most of them graduated) sat thousands of rows down. The grade is on every row and in the filter.
 */
export function rankRadar(rows: ReadRow[]): RadarRow[] {
  return rows.sort((a,b) => b.volume-a.volume || a.row.address.localeCompare(b.row.address)).map((r,i)=>({...r.row,rank:i+1}));
}
export class RadarService {
  constructor(readonly store: ReadStore) {
    this.header=new MinuteSnapshot({coins:0,clear:0,monitor:0,pending:0,danger:0,evaluatedToday:0,evaluatedByHour:Array(24).fill(0),dangerByHour:Array(24).fill(0)},()=>this.computeTotals(),()=>store.now());
    store.onSummaryRefresh(()=>this.header.refresh());
  }
  async order() {await this.store.currentRanks();return (await this.store.db.sql.query<{coin:Uint8Array}>('SELECT coin FROM read_coins WHERE activity>$1 ORDER BY -volume,coin',[new Date(this.store.now()-7*86400000)])).rows.map(r=>hex(r.coin));}
  async list(cursor?:string,blueChipOnly=false) {
    await this.store.currentRanks();
    const key=decodeCursor(cursor,'radar');
    if(key && (key.length!==4 || !Number.isInteger(key[0]) || typeof key[1]!=='number' || typeof key[2]!=='string' || !/^0x[0-9a-f]{40}$/.test(key[2]) || !Number.isInteger(key[3])))throw new InputError('Invalid radar cursor');
    const cutoff=new Date(this.store.now()-7*86400000),params:unknown[]=[cutoff];
    // The cursor keeps its four fields (tier, volume, coin, rank); the tier no longer orders the page.
    if(key)params.push(-Number(key[1]),Buffer.from(String(key[2]).slice(2),'hex'));
    const category=blueChipOnly && this.store.blueChip?.config.enabled ? `AND ${this.store.blueChip.predicate('read_coins.coin',params,'read_coins.tier')}` : '';
    const selected=await this.store.db.sql.query<{coin:Uint8Array;tier:number;volume:number}>(`SELECT coin,tier,volume FROM read_coins
      WHERE activity>$1 ${key ? 'AND (-volume,coin)>($2,$3)' : ''} ${category} ORDER BY -volume,coin LIMIT 101`,params);
    const page=selected.rows.slice(0,100);
    const [details,totals]=await Promise.all([this.store.rows(undefined,page.map(r=>hex(r.coin))),this.totals()]);
    const indexed=new Map(details.map(e=>[e.row.address,e.row]));
    const rows=page.map((r,i)=>({...indexed.get(hex(r.coin))!,rank:i+1+(key ? Number(key[3]) : 0)}));
    const last=page.at(-1);
    return {rows,cursor:selected.rows.length>100 && last ? encodeCursor('radar',[last.tier,last.volume,hex(last.coin),(key ? Number(key[3]) : 0)+page.length]) : null,delayedSec:0,totals};
  }
  private header:MinuteSnapshot<Awaited<ReturnType<RadarService['computeTotals']>>>;
  totals() {return Promise.resolve(this.header.value);}
  /** Explicit host/test refresh, never called by a request. */
  refreshTotals() {return this.header.refresh(true);}
  private async computeTotals() {
    const result=await this.store.db.sql.query<{tier:number;n:string}>('SELECT tier,count(*) AS n FROM read_coins WHERE activity>$1 GROUP BY tier',[new Date(this.store.now()-7*86400000)]);
    const midnight=Math.floor(this.store.now()/86400000)*86400;
    const live=new Date(this.store.now()-7*86400000);
    const today=await this.store.db.sql.query<{n:string}>(HEADER_TODAY_SQL,[midnight,midnight+86400,live]);
    const count=(tier:number)=>Number(result.rows.find(r=>r.tier===tier)?.n ?? 0);
    const from=Math.floor(this.store.now()/3600000)*3600-23*3600;
    const hours=await this.store.db.sql.query<{h:number;n:string;danger:string}>(HEADER_HOURS_SQL,[from,live]);
    const hourly=(field:'n'|'danger')=>Array.from({length:24},(_,i)=>Number(hours.rows.find(r=>Number(r.h)===i)?.[field] ?? 0));
    // Refusals exist only while buy quotes run the sell check; otherwise the stat has no source and is omitted (CA-36).
    const refused=this.store.sellCheckQuotes ? await sellRefusalTotals(this.store.db,this.store.now()) : null;
    return {coins:result.rows.reduce((n,r)=>n+Number(r.n),0),clear:count(0),monitor:count(1),pending:count(2),danger:count(3),evaluatedToday:Number(today.rows[0].n),
      evaluatedByHour:hourly('n'),dangerByHour:hourly('danger'),...(refused ? {honeypotsRefused:refused.today,refusedByHour:refused.byHour} : {})};
  }
}
