import type { ChainDb } from './client.js';
import { binary, hex } from './types.js';

/** Sufficient statistics for launch/lifetime checks, not a replay journal. Amounts retain integer precision. */
export interface LifetimeSwap {
  block: string; ts: string; tx_hash: string; log_index: number; trader: string | null; recipient?: string | null;
  senders_pending?: boolean; side: number; amount_coin: string; amount_quote: string; price_quote: number;
  usd: number | null; venue: string; pool_id: string; quote_asset: string;
}
export interface Lifetime {
  legacyIncomplete?:boolean;
  checkpointHour?:{totalCount:number;unattributedCount:number;totalVolumeUsd:number;unattributedVolumeUsd:number;unknownVolumeCount:number};
  liquidity?: Record<string,LifetimePool>;
  liquidityThrough?:number; ponsThrough?:number;
  priorRemovalCount?: number;
  priorRemovals?: LifetimeEvidence[];
  tail?:LifetimeSwap[];
  lastPositivePriced?:LifetimeSwap;
  lastRatingPriced?:LifetimeSwap; peakRawPrice?:number;
  poolLastPriced?:Record<string,LifetimeSwap>;
  graduation?:LifetimeGraduation;
  first?:LifetimeSwap;
  firstPriced?: LifetimeSwap;
  priorRemovalLastBlock?:number;
  firstHourBuys: Record<string,number>; firstHourSells: Record<string,number>;
  sellCounts: Record<string,number>; sellEvidence: Record<string,LifetimeSwap[]>;
  count: number; missing: number; volume: number; missingVolume: number; unknown: number; usdComplete: boolean;
  curveVolume: number; curveNet: number; net: number; hasEth: boolean; buyers: string[]; pools: Record<string, number>;
  devByActor?:Record<string,Lifetime['dev']>;
  dev: { cashIn: number; cashOut: number; sold: number; complete: boolean; sells: LifetimeSwap[] };
  early: Record<string, { first: LifetimeSwap; gross: number; soldEarly: number; sold: number; deployer: boolean;funders?:string[] }>;
  earlyComplete: boolean; unknownBuyers: boolean; earlySales: Record<string,number>; exemptBought: Record<string, number>; last?: LifetimeSwap; lastPriced?: LifetimeSwap;
  curve: { launchSeen?:boolean;launchThreshold?:string;threshold?: string; reserve: string; valid: boolean };
}
export function emptyLifetime(): Lifetime {
  return { firstHourBuys:{},firstHourSells:{},sellCounts:{},sellEvidence:{},count: 0, missing: 0, volume: 0, missingVolume: 0, unknown: 0, usdComplete: true, curveVolume: 0, curveNet: 0,
    net: 0, hasEth: false, buyers: [], pools: {}, dev: { cashIn: 0, cashOut: 0, sold: 0, complete: true, sells: [] },
    early: {}, earlyComplete: true, unknownBuyers: false, earlySales: {}, exemptBought: {}, curve: { reserve: '0', valid: true } };
}
export function packSwap(r: Record<string, unknown>): LifetimeSwap {
  const bytes = (k: string) => r[k] == null ? null : hex(r[k] as Uint8Array);
  return { block:String(r.block),ts:new Date(r.ts as Date).toISOString(),tx_hash:bytes('tx_hash')!,log_index:r.log_index as number,
    trader:bytes('trader'),recipient:bytes('recipient'),senders_pending:r.senders_pending as boolean|undefined,
    side:r.side as number,amount_coin:String(r.amount_coin),amount_quote:String(r.amount_quote),price_quote:r.price_quote as number,
    usd:r.usd as number|null,venue:r.venue as string,pool_id:bytes('pool_id')!,quote_asset:bytes('quote_asset')! };
}
export function unpackSwap(r: LifetimeSwap) {
  return { ...r, ts: new Date(r.ts), tx_hash: binary(r.tx_hash as `0x${string}`), trader: r.trader ? binary(r.trader as `0x${string}`) : null,
    recipient: r.recipient ? binary(r.recipient as `0x${string}`) : null, pool_id: binary(r.pool_id as `0x${string}`), quote_asset: binary(r.quote_asset as `0x${string}`) };
}
export interface LifetimeIdentity { deployer: string; firstBlock: number; createdSec: number; pools: Set<string>; firstBlocks: number; cohortSec: number }
/** Feed in canonical block/log order. Deletion resumes from the same prefix, so no row is counted twice. */
export function addLifetimeSwaps(s: Lifetime, rows: LifetimeSwap[], id: LifetimeIdentity) {
  const buyers = new Set(s.buyers);
  for (const r of rows) {
    const amount = Number(r.amount_coin), sec = Date.parse(r.ts) / 1000, attributed = r.trader != null && !r.senders_pending;
    const early = Number(r.block) >= id.firstBlock && (Number(r.block) - id.firstBlock < id.firstBlocks || sec - id.createdSec < id.cohortSec);
    const g=s.graduation;
    if(g && sec>g.atSec-0.001 && sec<=g.atSec+300) {
      g.count++;g.volume+=r.usd ?? 0;
      if(!attributed) {g.missing++;g.missingVolume+=r.usd ?? 0;if(r.usd==null)g.unknown++;}
      if(attributed && r.side===-1 && r.usd!=null) {
        const a=g.actors[r.trader!] ??= {amount:0,minPrice:Number.MAX_VALUE,atSec:sec,refs:[]};a.amount+=amount;
        a.minPrice=Math.min(a.minPrice,Number.isFinite(r.usd/amount) ? r.usd/amount : Number.MAX_VALUE);if(a.refs.length<5)a.refs.push(r);
      }
    }
    if(r.usd!=null && r.usd>0 && amount>0 && Number(r.amount_quote)>0) {
      s.poolLastPriced ??= {};s.poolLastPriced[r.pool_id]=r;
    }
    if(r.usd!=null && r.usd>0 && amount>0) {
      s.peakRawPrice=Math.max(s.peakRawPrice ?? 0,r.usd/amount);s.lastRatingPriced=r;
    }
    s.count++; s.volume += r.usd ?? 0; s.net += r.side * amount; s.usdComplete &&= r.usd != null;
    if(attributed) {
      if(sec<=id.createdSec+3600) {
        const amounts=r.side===1 ? s.firstHourBuys : s.firstHourSells;amounts[r.trader!]=(amounts[r.trader!] ?? 0)+amount;
      }
      if(r.side===-1) {
        s.sellCounts[r.trader!]=(s.sellCounts[r.trader!] ?? 0)+1;
        const refs=s.sellEvidence[r.trader!] ??= [];if(refs.length<5)refs.push(r);
      }
    }
    const earlier=(a:LifetimeSwap,b:LifetimeSwap)=>Number(a.block)<Number(b.block) || Number(a.block)===Number(b.block) && (a.log_index<b.log_index || a.log_index===b.log_index && a.tx_hash<b.tx_hash);
    if(!s.first || earlier(r,s.first))s.first=r;
    if(r.usd!=null && amount>0 && (!s.firstPriced || earlier(r,s.firstPriced)))s.firstPriced=r;
    if (!attributed) { s.missing++; s.missingVolume += r.usd ?? 0; if (r.usd == null) s.unknown++; }
    s.hasEth ||= /^0x0{40}$/.test(r.quote_asset);
    if (r.venue === 'pons_curve') { s.curveVolume += r.usd ?? 0; s.curveNet += r.side * (r.usd ?? 0); }
    else s.pools[r.pool_id] = (s.pools[r.pool_id] ?? 0) + 1;
    const newer=(a:LifetimeSwap,b:LifetimeSwap)=>Number(a.block)>Number(b.block) || Number(a.block)===Number(b.block) && (a.log_index>b.log_index || a.log_index===b.log_index && a.tx_hash>b.tx_hash);
    if(!s.last || newer(r,s.last))s.last=r;
    if(r.usd!=null && r.usd>0 && amount>0 && Number(r.amount_quote)>0 && (!s.lastPositivePriced || newer(r,s.lastPositivePriced)))s.lastPositivePriced=r;
    if(r.usd!=null && amount>0 && (!s.lastPriced || newer(r,s.lastPriced)))s.lastPriced=r;
    if (r.side === 1) {
      if (r.trader) buyers.add(r.trader); if (r.recipient) buyers.add(r.recipient);
      if (attributed) s.exemptBought[r.trader!] = (s.exemptBought[r.trader!] ?? 0) + amount;
      if(!r.recipient && !attributed)s.unknownBuyers=true;
      const buyer = r.recipient ?? (attributed ? r.trader : null);
      if (early && !(buyer && id.pools.has(buyer))) {
        if (!buyer) s.earlyComplete = false;
        else {
          const e = s.early[buyer] ??= { first: r, gross: 0, soldEarly: s.earlySales[buyer] ?? 0, sold: s.earlySales[buyer] ?? 0, deployer: false };
          e.gross += amount;if(r.trader && !(e.funders ?? []).includes(r.trader))(e.funders ??= []).push(r.trader); e.deployer ||= buyer === id.deployer || r.trader === id.deployer;
        }
      }
    } else if(r.trader) {
      if(early)s.earlySales[r.trader]=(s.earlySales[r.trader] ?? 0)+amount;
      if(s.early[r.trader]) { s.early[r.trader].sold+=amount;if(early)s.early[r.trader].soldEarly+=amount; }
    }
    if(attributed) {
      s.devByActor ??= {};const actor=s.devByActor[r.trader!] ??= {cashIn:0,cashOut:0,sold:0,complete:true,sells:[]};
      actor.complete &&=r.usd!=null;
      if(r.side===1)actor.cashIn+=r.usd ?? 0;
      else {actor.cashOut+=r.usd ?? 0;actor.sold+=amount;actor.sells.push(r);actor.sells.sort((a,b)=>Number(a.block)-Number(b.block) || a.log_index-b.log_index || a.tx_hash.localeCompare(b.tx_hash));actor.sells=actor.sells.slice(0,5);}
    }
    if (attributed && r.trader === id.deployer) {
      s.dev.complete &&= r.usd != null;
      if (r.side === 1) s.dev.cashIn += r.usd ?? 0;
      else { s.dev.cashOut += r.usd ?? 0; s.dev.sold += amount; s.dev.sells.push(r);s.dev.sells.sort((a,b)=>Number(a.block)-Number(b.block) || a.log_index-b.log_index || a.tx_hash.localeCompare(b.tx_hash));s.dev.sells=s.dev.sells.slice(0,5); }
    }
  }
  s.tail=[...(s.tail ?? []),...rows].sort((a,b)=>Number(a.block)-Number(b.block) || a.log_index-b.log_index || a.tx_hash.localeCompare(b.tx_hash)).slice(-60);
  s.buyers = [...buyers];
}
export function addLifetimePons(s: Lifetime, rows: { block: string; kind: string; data: Record<string, unknown> }[], launch: number) {
  const units = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : undefined;
  let reserve = BigInt(s.curve.reserve);
  for (const r of rows) {
    if (r.kind === 'launch') {
      if(!s.curve.launchSeen) {s.curve.launchSeen=true;if(r.data.graduationThreshold!=null)s.curve.launchThreshold=String(r.data.graduationThreshold);}
      const threshold = Number(r.block) === launch ? units(r.data.graduationThreshold) : undefined;
      s.curve.threshold = threshold && threshold > 0n ? String(threshold) : undefined;
    } else if (r.kind === 'trade') {
      const q = units(r.data.amountEth), f = units(r.data.feeEth), t = units(r.data.taxEth), side = r.data.side;
      if (q == null || f == null || t == null || (side !== 1 && side !== -1)) s.curve.valid = false;
      else { const delta = side === 1 ? q-f-t : -(q+f+t); if (side === 1 && delta < 0n) s.curve.valid = false; reserve += delta; if (reserve < 0n) s.curve.valid = false; }
    }
  }
  s.curve.reserve = String(reserve);
}
export async function readLifetime(db: ChainDb, coin: Uint8Array): Promise<Lifetime | undefined> {
  return (await db.sql.query<{ data: Lifetime }>('SELECT data FROM coin_lifetime WHERE coin=$1', [coin])).rows[0]?.data;
}
export async function saveLifetime(db: ChainDb, coin: Uint8Array, data: Lifetime) {
  await db.sql.query('INSERT INTO coin_lifetime(coin,data) VALUES($1,$2) ON CONFLICT(coin) DO UPDATE SET data=excluded.data,revision=coin_lifetime.revision+1', [coin, JSON.stringify(data)]);
}

export interface LifetimeEvidence { kind: 'log'; ref: string; block: number; label: string }
export interface LifetimePool {
  moneyPositions?:Record<string,{lower:number;upper:number;liquidity:string}>;
  fullRangeDelta?:string;
  held: string; peak: string; events: number; missing: number; first?: string; lastAdd: number;
  positions: Record<string, { actor: string; amount: string; refs: LifetimeEvidence[] }>;
  wallets: Record<string, { held: string; peak: string; removals: LifetimeEvidence[]; lastRemoval: number }>;
}
export interface LifetimeLiquidityRow { block: string; tx_hash: Uint8Array; log_index: number; pool_id: Uint8Array; kind: string; actor: Uint8Array | null; senders_pending?: boolean; data: Record<string,string> }
export function addLifetimeLiquidity(s: Lifetime, rows: LifetimeLiquidityRow[], launchpad: string, deployer: string) {
  s.liquidity ??= {};
  for(const e of rows) {
    const key=hex(e.pool_id),p=s.liquidity[key] ??= {held:'0',peak:'0',events:0,missing:0,lastAdd:-1,positions:{},wallets:{}};
    if(['Mint','Burn','ModifyLiquidity'].includes(e.kind) && 'tickLower' in e.data && 'tickUpper' in e.data) {
      const lower=Number(e.data.tickLower),upper=Number(e.data.tickUpper),key=`${lower}:${upper}`;
      p.moneyPositions ??= {};const position=p.moneyPositions[key] ??= {lower,upper,liquidity:'0'};
      const value=e.kind==='ModifyLiquidity' ? e.data.liquidityDelta : e.data.amount;
      if(value!=null) {
        const delta=BigInt(value)*(e.kind==='Burn' ? -1n:1n);position.liquidity=String(BigInt(position.liquidity)+delta);
        if(e.kind==='ModifyLiquidity' && lower<=-887000 && upper>=887000)p.fullRangeDelta=String(BigInt(p.fullRangeDelta ?? '0')+delta);
      }
    }
    if(['Mint','Burn','ModifyLiquidity'].includes(e.kind)) {const delta=BigInt(e.data.liquidityDelta ?? e.data.amount ?? '0');p.held=String(BigInt(p.held)+(e.kind==='Burn' ? -delta:delta));if(BigInt(p.held)>BigInt(p.peak))p.peak=p.held;}
    p.events++; if(!e.actor || e.senders_pending) {p.missing++;continue;}
    if(!['Mint','Burn','ModifyLiquidity'].includes(e.kind))continue;
    const actor=hex(e.actor),named=(e.data.owner ?? e.data.sender ?? actor).toLowerCase();
    const posKey=`${named}:${e.data.tickLower}:${e.data.tickUpper}:${e.data.salt ?? ''}`;
    const pos=p.positions[posKey] ??= {actor:launchpad==='pons' ? named : actor,amount:'0',refs:[]};
    const delta=BigInt(e.data.liquidityDelta ?? e.data.amount ?? '0'),change=e.kind==='Burn' ? -delta : delta;
    pos.amount=String(BigInt(pos.amount)+change);
    const ref:LifetimeEvidence={kind:'log',ref:`${hex(e.tx_hash)}:${e.log_index}`,block:Number(e.block),label:'Liquidity position'};
    pos.refs.push(ref);pos.refs=pos.refs.slice(-5);
    if(launchpad!=='pons') {
      const w=p.wallets[actor] ??= {held:'0',peak:'0',removals:[],lastRemoval:-1};
      w.held=String(BigInt(w.held)+change);if(BigInt(w.held)>BigInt(w.peak))w.peak=w.held;
      if(change>0n) {p.first ??= actor;p.lastAdd=Math.max(p.lastAdd,Number(e.block));}
      if(change<0n) {w.removals.push({...ref,label:'Liquidity removal'});w.removals=w.removals.slice(-5);w.lastRemoval=Math.max(w.lastRemoval,Number(e.block));}
    }
    if(actor===deployer && (e.kind==='Burn' || e.kind==='ModifyLiquidity' && change<0n)) {
      s.priorRemovalCount=(s.priorRemovalCount ?? 0)+1;
      s.priorRemovalLastBlock=Number(e.block);s.priorRemovals ??= [];if(s.priorRemovals.length<5)s.priorRemovals.push({...ref,label:'Prior liquidity removal'});
    }
  }
}
export interface LifetimeGraduation {
  block:number; atSec:number; first:LifetimeSwap; before?:LifetimeSwap;
  count:number; missing:number; volume:number; missingVolume:number; unknown:number;
  actors:Record<string,{amount:number;minPrice:number;atSec:number;refs:LifetimeSwap[]}>;
}

/** First-buy provenance and unresolved-buy counts used by wallet reactions, captured with the exact deleted batch. */
export async function recordBuyerStatistics(db:ChainDb,coin:Uint8Array,rows:Record<string,unknown>[]) {
  const known=rows.filter(r=>r.side===1 && r.trader!=null && !r.senders_pending);
  if(known.length) {
    const params:unknown[]=[coin];
    const values=known.map(r=>{params.push(r.trader,r.block,r.pool_id,r.tx_hash,r.log_index);const n=params.length;return `($1::bytea,$${n-4}::bytea,$${n-3}::bigint,$${n-2}::bytea,$${n-1}::bytea,$${n}::integer)`;}).join(',');
    await db.sql.query(`INSERT INTO coin_buyer_firsts(coin,trader,first_block,pool_id,tx_hash,log_index)
      SELECT DISTINCT ON(coin,trader) * FROM (VALUES ${values}) r(coin,trader,first_block,pool_id,tx_hash,log_index)
      ORDER BY coin,trader,first_block,tx_hash,log_index ON CONFLICT(coin,trader) DO UPDATE SET
        first_block=excluded.first_block,pool_id=excluded.pool_id,tx_hash=excluded.tx_hash,log_index=excluded.log_index
      WHERE (excluded.first_block,excluded.tx_hash,excluded.log_index)<(coin_buyer_firsts.first_block,coin_buyer_firsts.tx_hash,coin_buyer_firsts.log_index)`,params);
  }
  const missing=new Map<string,number>();
  for(const r of rows)if(r.side===1 && (r.trader==null || r.senders_pending))missing.set(String(r.block),(missing.get(String(r.block)) ?? 0)+1);
  if(missing.size) {
    const params:unknown[]=[coin],values=[...missing].map(([block,n])=>{params.push(block,n);return `($1::bytea,$${params.length-1}::bigint,$${params.length}::bigint)`;}).join(',');
    await db.sql.query(`INSERT INTO coin_unknown_buys VALUES ${values} ON CONFLICT(coin,block) DO UPDATE SET n=coin_unknown_buys.n+excluded.n`,params);
  }
}
