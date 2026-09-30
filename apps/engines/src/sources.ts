import { isRpcUnavailable, rpcStopReason } from '@eko/chain';
import { countEvaluations, recordFirstPlans } from './throughput.js';
import { incrementalSwaps } from './swap-reader.js';
import { gapFromTotals, attributionGap } from './attribution-coverage.js';
import { loadReferenceInputs } from './reference-simulation.js';
import { loadSellCheckReference } from './sell-check-reference.js';
import { binary, trendingAt, readLifetime, addLifetimeSwaps, addLifetimePons, addLifetimeLiquidity, type Lifetime, packSwap, unpackSwap, type ChainDb } from '@eko/db';
import { loadRegistry, type PonsProfileClient } from '@eko/chain';
import { toUntrusted } from '@eko/untrusted';
import { CONFIG_V1, RULES_VERSION, type CardSources, type HistoryView, type PriorLaunch } from '@eko/playbooks';
import type { Address, EvidenceRef, PoolRef } from '@eko/shared';
import { curveProgress, curveProgressAt, type PonsEventRow } from './curve-progress.js';
import { liveRanks } from './market.js';
import { ponsProfiles } from './pons-profile.js';
import { resolveClock, type ClockCache } from './activity.js';
import type { ReplayCache } from './replay-cache.js';
import { upperBlock } from './replay-cache.js';
import { rowHex, prepareSwap, prepareHolding, isSink, TradeAggregate, HolderAggregate, timeWindow, type TradeView } from './aggregates.js';
import { historyPrune, prunedGap, revivedBy } from './history-prunes.js';

export interface TokenRow {
  address: Uint8Array; deployer: Uint8Array | null; curve: Uint8Array | null;
  name: string | null; symbol: string | null; launchpad: CardSources['launchpad'] | null;
  first_block: string; total_supply: string | null; decimals: number | null; supply_block: string | null;
  graduated_block: string | null; graduated_pool: Uint8Array | null;
}
export interface SwapRow {
  block: string; ts: Date; tx_hash: Uint8Array; log_index: number; trader: Uint8Array | null; senders_pending?:boolean; recipient?: Uint8Array | null;
  traderHex?:Address;quoteHex?:Address;poolHex?:Address;txHex?:Address;sec?:number;
  side: number; amount_coin: string; amount_quote: string; price_quote: number; usd: number | null;
  venue: string; pool_id: Uint8Array; quote_asset: Uint8Array;
}
export interface PoolRow { id: Uint8Array; currency0: Uint8Array; currency1: Uint8Array; venue: PoolRef['venue']; fee: number; hooks: Uint8Array | null; created_block:string }
export interface EventRow { block: string; ts: Date; tx_hash: Uint8Array; log_index: number; kind: string; actor: Uint8Array | null; senders_pending?:boolean; pool_id: Uint8Array; data: Record<string, string> }
export interface Holding { holder: Uint8Array; amount: string; block: string; holderHex?:Address }
export interface LoadedSources extends CardSources {
  lifetime?: Lifetime;
  blueChipHolderCount?: number;
  attributionCoverage?: Record<string,import('@eko/shared').AttributionCoverageGap>;
  referenceResults?: import('@eko/chain').ReferenceResult[];
  curvePct?:number;trade:TradeView;holderSummary:{count:number;previousCount:number;top10:number;dev:number;burned:bigint;inventory:bigint};
  token: TokenRow; swaps: SwapRow[]; holdings: Holding[]; previousHoldings: Holding[]; events: EventRow[];
  poolRefs: PoolRef[]; supply?: { total: bigint; circulating: bigint; burned: bigint; block: number };
  profile?: { creatorTaxPct: number; feePct: number; antiSnipeActive: boolean; codehash: string; curve: Address; observationVersion: 'pons-getters-2';
    /** Owner powers found in the token's bytecode dispatch table (ownerPowers in pons-profile.ts); absent on reads before 2026-10-12. */
    powers?: { mint: boolean; blacklist: boolean; pause: boolean; upgrade: boolean; owner: boolean; codeBytes: number } };
  sectionBlocks: { identity: number; supply?: number; liquidity?: number };
  history: HistoryView; usdComplete: boolean; trendingRank?: number; exemptionWallets: Address[]; previousHolderBlock?: number;
  /** The coin was rated Danger when retention pruned its raw history; the verdict keeps that floor (worker.ts). */
  dangerBeforePrune?: { playbooks: string[] };
  /** The live sell check run that supplied this card's honeypot input (sell-check-reference.ts). */
  sellCheckReference?: { runId: string; block: number };
  /** Independent sellers that completed the honeypot check where the sell check cannot probe (sell-check-reference.ts). */
  observedSellers?: { sellers: number; block: number };
  /** The pool most of the coin's trades of the last day went through (all its trades when none is that recent), and its hook. */
  mainPool?: { id: Address; hooks: Address | null };
}
export const seconds = (date: string | Date) => new Date(date).getTime() / 1000;
/** The swaps of the trailing day among the first `end` (block order; times do not decrease with height). */
function recentDay(swaps: readonly SwapRow[], end: number, asOfSec: number): SwapRow[] {
  let from = end;
  while (from > 0 && (swaps[from - 1].sec ?? seconds(swaps[from - 1].ts)) > asOfSec - 86_400) from--;
  return swaps.slice(from, end);
}
export const evidence = (r: { tx_hash: Uint8Array; log_index: number; block: string }, label: string): EvidenceRef =>
  ({ kind: 'log', ref: `${rowHex(r.tx_hash)}:${r.log_index}`, block: Number(r.block), label });
const eq = (a: Uint8Array, b: Uint8Array) => rowHex(a) === rowHex(b);

let holderCursor=0;
export async function holdingsAt(db: ChainDb, coin: Address, block: number, cache?:ReplayCache,lane='now'): Promise<Holding[]> {
  const checkpoint=(await db.sql.query<{data:Record<string,{amount:string;block:string}>}>('SELECT data FROM coin_holder_checkpoints WHERE coin=$1 AND block=$2',[binary(coin),block])).rows[0];
  if(checkpoint)return Object.entries(checkpoint.data).sort(([a],[b])=>a.localeCompare(b)).map(([holder,r])=>prepareHolding({holder:Buffer.from(holder,'hex'),...r}));
  if(cache)return cache.holdingsAt(coin,block,lane);
  // ORDER BY ... LIMIT 1 stops at the first index entry; min() and max() through the live view walk the coin's whole index.
  // Select the nearer endpoint. Old horizon/opening views must not reverse a coin's entire future history.
  const bounds=(await db.sql.query<{first:string|null;last:string|null;baseline:string|null}>(`SELECT
    (SELECT block FROM raw_history_live_transfers WHERE token=$1 ORDER BY block LIMIT 1)::text AS first,
    (SELECT block FROM raw_history_live_transfers WHERE token=$1 ORDER BY block DESC LIMIT 1)::text AS last,
    (SELECT max(through_block)::text FROM transfer_baselines WHERE token=$1) AS baseline`,[binary(coin)])).rows[0];
  if(bounds.last==null || Number(bounds.last)<=block)return (await db.sql.query<Holding>(
    'SELECT holder,amount,last_block::text AS block FROM balances WHERE token=$1 AND amount>0 ORDER BY holder',[binary(coin)])).rows.map(prepareHolding);
  if(block<(Number(bounds.first)+Number(bounds.last))/2 || bounds.baseline!=null && block<Number(bounds.baseline)) {
    // A cursor streams the two signed movement lanes and retained baselines from one statement snapshot.
    // FETCH bounds the work per statement without a historical GROUP BY/sort or cross-page compaction races.
    return db.tx(async tx=>{
      const amounts=new Map<Address,{holder:Uint8Array;amount:bigint;block:number}>(),name=`engine_holder_prefix_${++holderCursor}`;
      await tx.sql.query(`DECLARE ${name} NO SCROLL CURSOR FOR
        SELECT to_address AS holder,amount,block FROM raw_history_live_transfers WHERE token=$1 AND block<=$2 AND kind='Transfer'
        UNION ALL SELECT from_address,-amount,block FROM raw_history_live_transfers WHERE token=$1 AND block<=$2 AND kind='Transfer'
        UNION ALL SELECT holder,amount,through_block FROM transfer_baselines WHERE token=$1 AND through_block<=$2`,[binary(coin),block]);
      for(;;) {
        const page=(await tx.sql.query<Holding>(`FETCH FORWARD 2000 FROM ${name}`)).rows;
        for(const r of page) {
          const key=rowHex(r.holder),prior=amounts.get(key);
          amounts.set(key,{holder:r.holder,amount:(prior?.amount ?? 0n)+BigInt(r.amount),block:Math.max(prior?.block ?? -1,Number(r.block))});
        }
        if(page.length<2000)break;
      }
      await tx.sql.query(`CLOSE ${name}`);
      return [...amounts].filter(([,r])=>r.amount>0n).sort(([a],[b])=>a<b ? -1:a>b ? 1:0)
        .map(([,r])=>prepareHolding({holder:r.holder,amount:String(r.amount),block:String(r.block)}));
    });
  }

  // One statement snapshot: current balances minus only the movements after the checkpoint.
  // Include zero/negative balances, since a wallet that exited can have been positive then.
  return (await db.sql.query<Holding>(`WITH later AS MATERIALIZED (
    SELECT from_address,to_address,amount FROM raw_history_live_transfers WHERE token=$1 AND block>$2 AND kind='Transfer'
  ), delta AS (
    SELECT holder,sum(amount) AS amount FROM (
      SELECT to_address AS holder,amount FROM later UNION ALL SELECT from_address,-amount FROM later
    ) d GROUP BY holder
  ), historical AS (
    SELECT b.holder,b.amount-coalesce(d.amount,0) AS amount,
      CASE WHEN b.last_block<=$2 THEN b.last_block ELSE greatest(
        (SELECT block FROM raw_history_live_transfers WHERE token=$1 AND to_address=b.holder AND block<=$2 AND kind='Transfer' ORDER BY block DESC LIMIT 1),
        (SELECT block FROM raw_history_live_transfers WHERE token=$1 AND from_address=b.holder AND block<=$2 AND kind='Transfer' ORDER BY block DESC LIMIT 1),
        (SELECT through_block FROM transfer_baselines WHERE token=$1 AND holder=b.holder AND through_block<=$2)
      ) END AS block
    FROM balances b LEFT JOIN delta d ON d.holder=b.holder WHERE b.token=$1
  ) SELECT holder,amount::text,block::text FROM historical WHERE amount>0 ORDER BY holder`,
    [binary(coin),block])).rows.map(prepareHolding);
}
export async function historyAt(db: ChainDb, deployer: Address, coin: Address, block: number, cache?:ReplayCache): Promise<HistoryView> {
  if(cache)return cache.historyAt(deployer,coin,block);
  const stats = (await db.sql.query<{ data: PriorLaunch }>(`SELECT DISTINCT ON(coin) data FROM deployer_stats
    WHERE deployer=$1 AND coin<>$2 AND valid_from_block<=$3 AND rules_version=$4 ORDER BY coin,valid_from_block DESC`, [binary(deployer), binary(coin), block, RULES_VERSION])).rows;
  return { launches: stats.map(r => r.data) };
}
/** Reads shared by every coin evaluated in one live poll (most of them at the same head block). */
export const RETENTION_RULE_INPUTS={firstBlocks:CONFIG_V1.bundle_dump.firstBlocks,cohortSec:CONFIG_V1.bundle_dump.cohortSec};
export interface SourceMemo { ranks: Map<string, Promise<Map<Address, number>>> }
async function readSources(db: ChainDb, coin: Address, block: number, client?: PonsProfileClient, clock?:ClockCache,cache?:ReplayCache,retrospective=false,memo?:SourceMemo): Promise<LoadedSources | null> {
  // A coin whose raw history retention dropped is evaluated again only after it trades or moves again; its earlier
  // checkpoints and quiet period cannot be rebuilt from what is left (docs/operations/retention.md).
  const prune=await historyPrune(db,coin);
  const checkpoint=retrospective ? (await db.sql.query<{data:Lifetime}>('SELECT data FROM coin_lifetime_checkpoints WHERE coin=$1 AND block=$2',[binary(coin),block])).rows[0] : undefined;
  if(checkpoint)cache=undefined;
  const savedLifetime=checkpoint?.data ?? await readLifetime(db,binary(coin));
  if(checkpoint && savedLifetime) {
    const events=(await db.sql.query<{data:Lifetime}>('SELECT data FROM coin_outcome_events WHERE coin=$1 AND block=$2',[binary(coin),block])).rows[0];
    if(events)for(const key of ['liquidity','curve','priorRemovalCount','priorRemovalLastBlock','priorRemovals'] as const)Object.assign(savedLifetime,{[key]:events.data[key]});
    else if(savedLifetime.liquidity && (savedLifetime.liquidityThrough==null || savedLifetime.liquidityThrough>block)
      || savedLifetime.curve.launchSeen && (savedLifetime.ponsThrough==null || savedLifetime.ponsThrough>block))savedLifetime.legacyIncomplete=true;
  }
  if(prune && (block<=prune.watermark && !checkpoint || !(savedLifetime && retrospective) && !(await revivedBy(db,coin,prune,block))))return unavailable(db,coin,block,'history_pruned',retrospective);
  const token = cache ? cache.tokens.get(coin) : (await db.sql.query<TokenRow>('SELECT * FROM tokens WHERE address=$1 AND first_block<=$2', [binary(coin), block])).rows[0];
  if(token && Number(token.first_block)>block)return unavailable(db,coin,block,'launch_after_checkpoint',retrospective);
  if (!token?.deployer || token.name == null || token.symbol == null) return unavailable(db,coin,block,'missing_launch_identity',retrospective);
  const [now,created]=await Promise.all([resolveClock(db,block,undefined,clock),resolveClock(db,Number(token.first_block),undefined,clock)]);
  if (!now || !created) return unavailable(db,coin,block,'missing_block_clock',retrospective);
  const asOfSec = seconds(now.ts), createdAtSec = seconds(created.ts);
  const cachedRows=cache ? await cache.coinRows(coin) : undefined;
  const swaps = cachedRows ? cachedRows.swaps : await incrementalSwaps(db,coin,block);
  const swapEnd=cachedRows ? upperBlock(swaps,block) : swaps.length;
  const poolRows = cachedRows ? cachedRows.pools.filter(p=>Number(p.created_block)<=block) : (await db.sql.query<PoolRow>('SELECT * FROM pools WHERE (currency0=$1 OR currency1=$1) AND created_block<=$2 ORDER BY id', [binary(coin), block])).rows;
  const events = cachedRows ? cachedRows.events.slice(0,upperBlock(cachedRows.events,block)) : (await db.sql.query<EventRow>(`SELECT e.* FROM liquidity_events e JOIN pools p ON p.id=e.pool_id
    WHERE (p.currency0=$1 OR p.currency1=$1) AND e.block<=$2 ORDER BY e.block,e.log_index,e.tx_hash`, [binary(coin), block])).rows;
  const exemptions = cachedRows ? cachedRows.exemptions.filter(e=>Number(e.block)<=block) : (await db.sql.query<{ wallet: Uint8Array; block: string; tx_hash: Uint8Array; log_index: number }>('SELECT * FROM pons_exemptions WHERE token=$1 AND block<=$2 ORDER BY wallet', [binary(coin), block])).rows;
  const exSet=new Set(exemptions.map(e=>rowHex(e.wallet))),deployer=rowHex(token.deployer);
  const priorBlock = cache ? cache.priorBlock(asOfSec-3600,block) : (await db.sql.query<{ number: string }>('SELECT number FROM engine_block_times WHERE ts<=to_timestamp($1) AND number<=$2 ORDER BY number DESC LIMIT 1', [asOfSec - 3600, block])).rows[0];
  let holdings:Holding[]=[],previousHoldings:Holding[]=[];
  const makeHolders=(rows:Holding[])=>{const state=new HolderAggregate(coin,token.curve ? rowHex(token.curve) : undefined,loadRegistry().addressOf('ours.burnWallet')?.toLowerCase() as Address|undefined);for(const r of rows)state.set(rowHex(r.holder),BigInt(r.amount),Number(r.block));return state;};
  // Early buyers (bundle_dump): buys in the first blocks after launch (same-funder groups) or the first cohortSec
  // seconds (the cohort: bundles wait out the 5-second anti-snipe tax), credited to the wallet that received the coins.
  const launchBlock=Number(token.first_block),early=(r:SwapRow)=>Number(r.block)-launchBlock<CONFIG_V1.bundle_dump.firstBlocks || seconds(r.ts)-createdAtSec<CONFIG_V1.bundle_dump.cohortSec;
  // Pools hold liquidity, not a holder's bag: skipped in the top holders (the curve and burn addresses never rank).
  const poolHolders=new Set<string>([...poolRows.map(p=>rowHex(p.id)),...[loadRegistry().addressOf('uniswapV4.poolManager')].filter((a):a is Address=>!!a).map(a=>a.toLowerCase())]);
  // What a wallet sold again inside the window comes off what it bought there: a wallet flipping in and out several
  // times would otherwise count each buy, and a busy first minute would add up to more than the whole supply.
  const earlyRows:SwapRow[]=[],earlySold=new Map<string,number>();
  const buyerOf=(r:SwapRow)=>r.recipient ?? (r.senders_pending ? null : r.trader);
  // A buy delivered to a pool or the pool manager moved no coins to any wallet (one hop of a route, coin-onboarding.ts):
  // it has no buyer to count.
  const undelivered=(r:SwapRow)=>{const b=buyerOf(r);return b!=null && poolHolders.has(rowHex(b));};
  for(let i=0;i<swapEnd && early(swaps[i]);i++){const r=swaps[i];if(Number(r.block)<launchBlock)continue;
    if(r.side===1){if(!undelivered(r))earlyRows.push(r);}else if(r.trader){const w=rowHex(r.trader);earlySold.set(w,(earlySold.get(w) ?? 0)+Number(r.amount_coin));}}
  const earlyWallets=[...new Set([...Object.keys(savedLifetime?.early ?? {}) as Address[],...earlyRows.map(buyerOf).filter((w):w is Uint8Array=>w!=null).map(rowHex)])];
  const wallets=[...(token.curve ? [rowHex(token.curve)] : []),deployer,...exSet,...[...poolHolders].map(w=>w as Address),...earlyWallets];
  if(!cache){holdings=await holdingsAt(db,coin,block);previousHoldings=priorBlock ? await holdingsAt(db,coin,Number(priorBlock.number)) : [];}
  const holderView=cache ? await cache.holderViewAt(coin,block,wallets,'now',poolHolders) : (()=>{const a=makeHolders(holdings);return {count:a.count,top10:a.top10(),burned:a.burned,inventory:a.inventory,amounts:new Map(wallets.map(wallet=>[wallet,a.amount(wallet)])),top:a.top(12,wallet=>poolHolders.has(wallet))};})();
  const previousCount=priorBlock ? cache ? (await cache.holderViewAt(coin,Number(priorBlock.number),[],'previous')).count : makeHolders(previousHoldings).count : 0;
  const scratch=cache ? undefined : new TradeAggregate(swaps);
  const trade=cache ? await cache.tradeAt(coin,block,asOfSec,exSet) : {...scratch!.advance(swapEnd,asOfSec),bought:scratch!.boughtFor(exSet)};
  const lifetime=savedLifetime ? structuredClone(savedLifetime) : undefined;
  if(lifetime)addLifetimeSwaps(lifetime,swaps.slice(0,swapEnd).map(r=>packSwap(r as unknown as Record<string,unknown>)),{
    deployer,firstBlock:launchBlock,createdSec:createdAtSec,pools:poolHolders,
    firstBlocks:CONFIG_V1.bundle_dump.firstBlocks,cohortSec:CONFIG_V1.bundle_dump.cohortSec});
  if(lifetime) {
    addLifetimeLiquidity(lifetime,events,token.launchpad ?? 'other',deployer);
    trade.count=lifetime.count; trade.usdComplete=lifetime.usdComplete; trade.hasEth=lifetime.hasEth;
    trade.curveVolume=lifetime.curveVolume; trade.curveProgress=Math.max(0,lifetime.curveNet);
    trade.attribution=gapFromTotals({totalCount:lifetime.count,unattributedCount:lifetime.missing,totalVolumeUsd:lifetime.volume,
      unattributedVolumeUsd:lifetime.missingVolume,unknownVolumeCount:lifetime.unknown},'launch_to_checkpoint');
    const last=lifetime.last ? prepareSwap(unpackSwap(lifetime.last)) : undefined;
    if(last && (!trade.last || Number(last.block)>=Number(trade.last.block)))trade.last=last;
    if(lifetime.lastPriced)trade.lastPriced=prepareSwap(unpackSwap(lifetime.lastPriced));
    if(last && last.sec!<=asOfSec-300 && !trade.previous5m)trade.previous5m=last;
    if(last && last.sec!<=asOfSec-3600 && !trade.previous1h)trade.previous1h=last;
  }
  const history=await historyAt(db,deployer,coin,block,cache);
  const s:LoadedSources={coin,deployer,asOfBlock:block,asOfSec,createdAtBlock:Number(token.first_block),createdAtSec,
    launchpad:token.launchpad ?? 'other',name:toUntrusted(token.name,120).text,symbol:toUntrusted(token.symbol,32).text,
    tokenText:[{ref:`${coin}:name`,raw:token.name},{ref:`${coin}:symbol`,raw:token.symbol}],token,swaps,holdings,previousHoldings,events,history,trade,
    ...(lifetime ? {lifetime}:{}),
    holderSummary:{count:holderView.count,previousCount,top10:holderView.top10,dev:!isSink(deployer,coin) && (!token.curve || deployer!==rowHex(token.curve)) ? Number(holderView.amounts.get(deployer) ?? 0n) : 0,burned:holderView.burned,inventory:holderView.inventory},
    blueChipHolderCount:holderView.count-[...poolHolders].filter(w=>!isSink(w as Address,coin) && (!token.curve || w!==rowHex(token.curve)) && (holderView.amounts.get(w as Address) ?? 0n)>0n).length,
    poolRefs:[],exemptionWallets:[...exSet],usdComplete:trade.usdComplete,sectionBlocks:{identity:Number(token.first_block)},...(priorBlock ? {previousHolderBlock:Number(priorBlock.number)} : {})};
  if(token.curve && s.launchpad==='pons') {
    if(token.graduated_block != null && Number(token.graduated_block)<=block) s.curvePct=100;
    else {
      const progress=cachedRows ? cachedRows.progress : curveProgress((await db.sql.query<PonsEventRow>(
        "SELECT block,kind,data FROM pons_events WHERE token=$1 AND block<=$2 AND kind IN ('launch','trade') ORDER BY block,log_index,tx_hash",[binary(coin),block])).rows,Number(token.first_block));
      s.curvePct=curveProgressAt(progress,block);
      if(lifetime) {
        const raw=(await db.sql.query<PonsEventRow>("SELECT block,kind,data FROM pons_events WHERE token=$1 AND block<=$2 AND kind IN ('launch','trade') ORDER BY block,log_index,tx_hash",[binary(coin),block])).rows;
        addLifetimePons(lifetime,raw,Number(token.first_block));
        const curve=lifetime.curve;
        s.curvePct=curve.valid && curve.threshold ? Math.min(100,Number(BigInt(curve.reserve)*10000n/BigInt(curve.threshold))/100) : undefined;
      }
    }
  }
  // Full historical arrays are materialized only for horizon outcomes/debug consumers.
  if(cache){let prefix:SwapRow[]|undefined,materialized=false,previousMaterialized=false;Object.defineProperty(s,'swaps',{enumerable:false,get:()=>prefix ??= swaps.slice(0,swapEnd)});Object.defineProperty(s,'holdings',{enumerable:false,get:()=>{if(!materialized){holdings=cache.materializeHoldings(coin,cachedRows!,block);materialized=true;}return holdings;}});Object.defineProperty(s,'previousHoldings',{enumerable:false,get:()=>{if(!previousMaterialized){previousHoldings=priorBlock ? cache.materializeHoldings(coin,cachedRows!,Number(priorBlock.number)) : [];previousMaterialized=true;}return previousHoldings;}});}

  if (token.curve && s.launchpad === 'pons') {
    s.profile=await ponsProfiles(db).read(coin,rowHex(token.curve),block,now.hash,client,clock);
    if (s.profile) {
      s.antiSnipeActive = s.profile.antiSnipeActive;
      // Getter amounts do not prove reconciled effective charges or immutability.
      // Validated effective fees and reachable powers live in the captured Guard profile path.
    }
  }
  // Do not read a future supply sample into historical cards. Mint/burn reconstruction is not assumed complete.
  if (token.total_supply != null && token.supply_block != null && Number(token.supply_block) <= block) {
    const total = BigInt(token.total_supply);
    const burned=holderView.burned,inventory=holderView.inventory;
    s.supply = { total, burned, circulating: total > burned + inventory ? total - burned - inventory : 0n, block: Number(token.supply_block) };
    s.sectionBlocks.supply = Math.min(block, s.supply.block);
  }
  if (s.supply && s.supply.total > 0n) {
    const total=Number(s.supply.total),bought=new Set<string>();
    let out=0,hour=0;
    for(let i=0;i<swapEnd;i++){const r=swaps[i],n=r.side*Number(r.amount_coin);out+=n;if(seconds(r.ts)>asOfSec-3600)hour+=n;if(r.side!==1)continue;if(r.recipient)bought.add(rowHex(r.recipient));if(r.trader)bought.add(rowHex(r.trader));}
    // Run-up (run_up): supply bought out of the launch curve net of sells, in all and in the last hour. Every trade of a
    // coin still on its curve is a curve trade; after graduation the measure does not apply.
    if(token.curve && s.launchpad==='pons' && !(token.graduated_block != null && Number(token.graduated_block)<=block))
      s.runUp={outShare:Math.max(0,out)/total,hourShare:Math.max(0,hour)/total,ageSec:asOfSec-createdAtSec,evidence:[{kind:'address',ref:rowHex(token.curve),label:'Launch curve'}]};
    // Holder concentration: the ten largest holders (pools skipped), the largest that is not the deployer, and what the
    // ten largest hold without ever having bought (transferred in). A buy the indexer could not attribute counts as unknown.
    const top=holderView.top.slice(0,10),unknownBuyer=swaps.slice(0,swapEnd).some(r=>r.side===1 && !r.recipient && (r.trader==null || r.senders_pending));
    const largest=top.find(h=>h.wallet!==deployer),transferred=top.filter(h=>h.wallet!==deployer && !bought.has(h.wallet));
    if(!unknownBuyer)s.holders={top10Share:top.reduce((n,h)=>n+h.amount,0)/total,largestShare:(largest?.amount ?? 0)/total,largest:largest?.wallet ?? null,
      transferredShare:transferred.reduce((n,h)=>n+h.amount,0)/total,transferredWallets:transferred.length,evidence:transferred.map(h=>({kind:'address',ref:h.wallet,label:'Holder that never bought'}))};
    // The deployer's own trades: USD in and out need every one of them priced, or the dump test cannot be made.
    const devRows=swaps.slice(0,swapEnd).filter(r=>r.trader!=null && !r.senders_pending && rowHex(r.trader)===deployer);
    if(devRows.every(r=>r.usd!=null)) {
      const sells=devRows.filter(r=>r.side===-1);
      s.dev={heldShare:s.holderSummary.dev/total,cashInUsd:devRows.filter(r=>r.side===1).reduce((n,r)=>n+r.usd!,0),cashOutUsd:sells.reduce((n,r)=>n+r.usd!,0),
        soldShare:sells.reduce((n,r)=>n+Number(r.amount_coin),0)/total,firstSellSec:sells.length ? seconds(sells[0].ts)-createdAtSec : null,evidence:sells.slice(0,5).map(r=>evidence(r,'Deployer sell'))};
    }
  }
  // Every early buy must name its buyer, or the cohort is not known and the check stays not run.
  if (s.supply && s.supply.total > 0n && earlyRows.every(r=>buyerOf(r)!=null)) {
    const total=Number(s.supply.total),cohort=new Set(earlyWallets),byWallet=new Map<string,SwapRow[]>();
    for(const r of earlyRows){const w=rowHex(buyerOf(r)!);byWallet.set(w,[...(byWallet.get(w) ?? []),r]);}
    // Selling into buyers: the wallet sold at least half of what it bought early while everyone else bought on net.
    let othersNet=0;const sold=new Map<string,number>(),earlySet=new Set(earlyRows);
    for(let i=0;i<swapEnd;i++){const r=swaps[i],seller=r.trader ? rowHex(r.trader) : null;
      if(r.side===-1 && seller && cohort.has(seller))sold.set(seller,(sold.get(seller) ?? 0)+Number(r.amount_coin));
      else if(!earlySet.has(r))othersNet+=r.side*Number(r.amount_coin);}
    s.earlyBuyers=[...byWallet].map(([wallet,rows])=>{
      const first=rows[0],gross=rows.reduce((n,r)=>n+Number(r.amount_coin),0),bought=Math.max(0,gross-(earlySold.get(wallet) ?? 0)),sec=seconds(first.ts);
      return {wallet:wallet as Address,funder:(first.trader ? rowHex(first.trader) : wallet) as Address,fundedAtSec:sec,buyAtSec:sec,buyBlock:Number(first.block),
        boughtShare:bought/total,heldShare:Number(holderView.amounts.get(wallet as Address) ?? 0n)/total,deployer:wallet===deployer || rows.some(r=>r.trader!=null && rowHex(r.trader)===deployer),
        sellingIntoNetInflow:(sold.get(wallet) ?? 0)>=gross*0.5 && othersNet>0,evidence:[evidence(first,'Early-block buy')]};
    });
  }
  if (s.supply && s.supply.total > 0n) {
    const ex: NonNullable<CardSources['pons']>['exemptions'] = [];
    for (const e of exemptions) {
      const rugs = (await db.sql.query<{ n: string }>(`SELECT count(DISTINCT d.coin) AS n FROM deployer_stats d JOIN outcomes o ON o.coin=d.coin
        WHERE d.deployer=$1 AND d.coin<>$2 AND d.valid_from_block<=$3 AND o.valid_from_block<=$3 AND o.outcome='rugged'`, [e.wallet, binary(coin), block])).rows[0];
      // TODO(spec): without crews, prior rugs use this exempt wallet's own deployer history only.
      ex.push({ wallet: rowHex(e.wallet), crewRugRuns: Number(rugs.n), log: evidence(e, 'Snipe-tax exemption') });
    }
    s.pons = { ...(s.profile ? { creatorTaxPct: s.profile.creatorTaxPct, feePct: s.profile.feePct } : {}), exemptions: ex,
      boughtShare: trade.bought / Number(s.supply.total),
      heldShare: [...exSet].sort().reduce((n,wallet)=>n+Number(holderView.amounts.get(wallet) ?? 0n),0) / Number(s.supply.total) };
  }
  const recent=trade.recent;
  // Wash trading reads the trailing hour. A Pons coin's curve check beside it needs every swap of its life priced; a
  // coin without a curve needs only that hour's (one old swap quoted in an unpriced token would otherwise hold it back).
  if (s.usdComplete || (s.launchpad!=='pons' && !token.curve && recent.every(r=>r.usd!=null))) {
    const trips: NonNullable<CardSources['wash']>['roundTrips'] = [];
    const cfg = CONFIG_V1.wash_to_trend;
    const actors=trade.actors;
    for (const [actor,{rows}] of actors) {
      const actorTrips: typeof trips = [];
      let open: SwapRow[] = [], net = 0, gross = 0;
      for (const r of rows) {
        if (open.length && r.sec! - open[0].sec! > cfg.roundTripSec) { open = []; net = 0; gross = 0; }
        open.push(r); net += r.side * Number(r.amount_coin); gross += r.side===1 ? Number(r.amount_coin) : 0;
        if (gross > 0 && open.some(r => r.side === -1) && Math.abs(net) / gross <= cfg.maxNetShare) {
          actorTrips.push({ actor, durationSec: r.sec! - open[0].sec!, netShare: net / gross,
            volumeUsd: open.reduce((n, r) => n + r.usd!, 0), evidence: open.map(r => evidence(r, 'Actor round trip')) });
          open = []; net = 0; gross = 0;
        }
      }
      if (actorTrips.length >= cfg.minRoundTripsPerActor) trips.push(...actorTrips);
    }
    const volumeUsd1h=trade.volumeUsd1h;
    s.wash = { volumeUsd1h, traders1h: actors.size, roundTrips: trips,
      washEstPct: volumeUsd1h > 0 ? 100 * trips.reduce((n, r) => n + r.volumeUsd, 0) / volumeUsd1h : 0 };
    if (token.curve) s.curve = { ageH: (asOfSec - createdAtSec) / 3600, volumeUsd: trade.curveVolume,
      progressUsd: trade.curveProgress, clusters: [], feeClaims: [] };
    // TODO(spec): dominant pair is the leading buy actor and leading sell actor's combined volume share.
    const leader=(side:number)=>{let best:{actor:Address;volume:number}|undefined;for(const [actor,values] of actors){const volume=side===1 ? values.buy : values.sell;if(!best || volume>best.volume || volume===best.volume && actor.localeCompare(best.actor)<0)best={actor,volume};}return best;};
    const buyer = leader(1), seller = leader(-1);
    if (buyer && seller && buyer.volume > 0 && seller.volume > 0) s.dominantPair = { buyer: buyer.actor, seller: seller.actor, share: (buyer.volume + seller.volume) / volumeUsd1h,
      evidence: recent.filter(r => (r.side === 1 ? buyer.actor : seller.actor) === r.traderHex!).map(r => evidence(r, 'Dominant actor')) };
  }
  const positions: (NonNullable<CardSources['liquidity']>['positions'][number] & { pool:string })[] = [];
  const weights = new Map<string, number>();
  // Per pool, for a coin that did not launch on Pons: each wallet's own liquidity over time (running total, its peak,
  // its removals), the wallet that paid in the pool's first liquidity, and the block of the pool's newest addition.
  const liquidityOf = new Map<string, { events: number; first?: Address; lastAdd: number;
    wallets: Map<Address, { held: bigint; peak: bigint; removals: EvidenceRef[]; lastRemoval: number }> }>();
  // A pool's events are found by key. Filtering every event for every pool was pools times events comparisons: a coin
  // paired in thousands of pools kept the engine in this loop from 11:24Z on 2026-10-13 (no rating was written for
  // any coin until it was restarted; 97% of its CPU profile was the comparison).
  const poolEvents = new Map<string, EventRow[]>();
  for (const e of events) { const key = rowHex(e.pool_id), list = poolEvents.get(key); if (list) list.push(e); else poolEvents.set(key, [e]); }
  for (const p of poolRows) {
    const pe = poolEvents.get(rowHex(p.id)) ?? [];
    const initial=savedLifetime?.liquidity?.[rowHex(p.id)];
    if(initial)liquidityOf.set(rowHex(p.id),{events:initial.events,first:initial.first as Address|undefined,lastAdd:initial.lastAdd,
      wallets:new Map(Object.entries(initial.wallets).map(([w,v])=>[w as Address,{held:BigInt(v.held),peak:BigInt(v.peak),removals:v.removals,lastRemoval:v.lastRemoval}]))});
    const owned = new Map<string, { actor: Address; amount: bigint; refs: EvidenceRef[] }>(Object.entries(initial?.positions ?? {}).map(([k,v])=>[k,{actor:v.actor as Address,amount:BigInt(v.amount),refs:v.refs}]));
    for (const e of pe) {
      if (!['Mint', 'Burn', 'ModifyLiquidity'].includes(e.kind)) continue;
      if(e.actor==null || e.senders_pending)continue;
      // The position is the one the event names (most are held through a position manager contract). For a coin that
      // did not launch on Pons its controller is the wallet that paid the coins in: the indexer names it from the
      // transaction's transfers (decode.ts), the first event of the position decides.
      const named = (e.data.owner ?? e.data.sender ?? rowHex(e.actor)).toLowerCase() as Address;
      const key = `${named}:${e.data.tickLower}:${e.data.tickUpper}:${e.data.salt ?? ''}`;
      const o = owned.get(key) ?? { actor: s.launchpad === 'pons' ? named : rowHex(e.actor), amount: 0n, refs: [] };
      const delta = BigInt(e.data.liquidityDelta ?? e.data.amount ?? '0'), change = e.kind === 'Burn' ? -delta : delta;
      o.amount += change; o.refs.push(evidence(e, 'Liquidity position')); owned.set(key, o);
      const pooled: NonNullable<ReturnType<typeof liquidityOf.get>> = liquidityOf.get(rowHex(p.id)) ?? { events: 0, lastAdd: -1, wallets: new Map() };
      pooled.events++;
      // A wallet's liquidity is what it paid in less what it took out, whichever position it sits in. Events count for
      // their own wallet only: positions held through a position manager share one key per range, so another
      // provider's removal from the same range is not this wallet's.
      if (s.launchpad !== 'pons') {
        const wallet = rowHex(e.actor), own = pooled.wallets.get(wallet) ?? { held: 0n, peak: 0n, removals: [], lastRemoval: -1 };
        own.held += change; if (own.held > own.peak) own.peak = own.held;
        if (change > 0n) { pooled.first ??= wallet; pooled.lastAdd = Math.max(pooled.lastAdd, Number(e.block)); }
        if (change < 0n) { own.removals.push(evidence(e, 'Liquidity removal')); own.lastRemoval = Math.max(own.lastRemoval, Number(e.block)); }
        pooled.wallets.set(wallet, own);
      }
      liquidityOf.set(rowHex(p.id), pooled);
    }
    const positive = [...owned.values()].filter(o => o.amount > 0n);
    const total = positive.reduce((n, o) => n + Number(o.amount), 0);
    const locked = token.graduated_pool && eq(p.id, token.graduated_pool) && Number(token.graduated_block) <= block;
    // A coin recorded with its own address as launch wallet was launched by a relayer or bot (coin-onboarding.ts): it has
    // no deployer wallet, and liquidity its own contract pays in is not a deployer's.
    for (const o of positive) positions.push({ owner: o.actor, controlledBy: o.actor === deployer && deployer !== coin ? 'deployer' : 'other', share: total ? Number(o.amount) / total : 0, pool:rowHex(p.id),
      status: locked ? 'pons_locked' : 'removable', evidence: o.refs });
    // Only address-based v3 pool token balances expose reserves; v4 PoolManager balances are shared.
    const reserve = p.venue === 'uniswap_v3' ? holderView.amounts.get(rowHex(p.id)) : undefined;
    const last=trade.lastPriced;
    const usd = reserve && last ? Number(reserve) * last.usd! / Number(last.amount_coin) * 2 : 0;
    weights.set(rowHex(p.id), usd);
    s.poolRefs.push({ id: rowHex(p.id), venue: p.venue, ...(p.id.length === 20 ? { address: rowHex(p.id) } : { poolId: rowHex(p.id) }),
      quote: rowHex(eq(p.currency0, token.address) ? p.currency1 : p.currency0), feeBps: p.fee / 100,
      ...(p.hooks ? { hooks: rowHex(p.hooks) } : {}), liquidityUsd: usd, executable: false });
  }
  // The pool the coin trades in: the one with most of its swaps in the last day (of all of them when none is that
  // recent). Anyone can open another pool with any hook for any coin, so only this pool's hook is the coin's.
  const perPool=new Map<string,number>(),count=(rows:readonly SwapRow[])=>{for(const r of rows)if(r.venue!=='pons_curve')perPool.set(r.poolHex!,(perPool.get(r.poolHex!) ?? 0)+1);};
  count(recentDay(swaps,swapEnd,asOfSec));
  if(!perPool.size) { if(lifetime)for(const [id,n] of Object.entries(lifetime.pools))perPool.set(id,n);
    else for(let i=0;i<swapEnd;i++)if(swaps[i].venue!=='pons_curve')perPool.set(swaps[i].poolHex!,(perPool.get(swaps[i].poolHex!) ?? 0)+1); }
  const busiest=[...perPool].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]))[0]?.[0],main=poolRows.find(p=>rowHex(p.id)===busiest) ?? (poolRows.length===1 ? poolRows[0] : undefined);
  if(main) {
    const hooks=main.hooks ? rowHex(main.hooks) : null;
    s.mainPool={id:rowHex(main.id),hooks};
    // What the hook may do is in its address (the low 14 bits; the low four let it change what a swap pays or receives).
    // The launchpad's own verified graduation hook is not a third party's.
    if(hooks && !/^0x0{40}$/.test(hooks) && hooks!==loadRegistry().addressOf('pons.v4Hook')?.toLowerCase()) {
      const bits=Number(BigInt(hooks) & 0x3fffn);
      s.hook={address:hooks,reviewed:false,sourceVerified:false,permissionBits:bits,returnDeltaPermissionBits:bits & 0xf,quoteSimGapPct:null,buyFeePct:null,sellFeePct:null,
        evidence:[{kind:'address',ref:rowHex(main.id),label:'Pool with this hook'}]};
    }
  }
  const reserveTotal = [...weights.values()].reduce((n,v) => n+v,0), maxReserve = Math.max(0,...weights.values());
  s.pools = poolRows.filter(p=>p.fee<0x800000).map(p => ({ id: rowHex(p.id), feeBps: p.fee / 100, liquidityShare: reserveTotal ? weights.get(rowHex(p.id))! / reserveTotal : 0,
    deepest: [...weights.values()].every(v=>v>0) && weights.get(rowHex(p.id)) === maxReserve,
    defaultRoute: !!token.graduated_pool && Number(token.graduated_block) <= block && eq(p.id, token.graduated_pool), evidence: (poolEvents.get(rowHex(p.id)) ?? []).map(e => evidence(e,'Pool liquidity')) }));
  // TODO(spec): aggregate LP shares across pools only when observed reserve USD supplies a denominator.
  // Single-pool ownership uses its actual position units; incomparable multi-pool units remain absent.
  // A coin that did not launch on Pons is read in the pool it trades in: who paid in the liquidity that is there now,
  // and whether the liquidity it launched with has been taken out (a pull leaves no position behind to find). Its
  // other pools, which anyone can open, do not hold the check back.
  const traded = s.launchpad !== 'pons' && main ? liquidityOf.get(rowHex(main.id)) : undefined;
  if (traded?.events) {
    const mine = positions.filter(p => p.pool === rowHex(main!.id));
    // The wallets whose removals are a pull: the deployer, where one is identified, and the wallet that paid in the
    // pool's first liquidity (a launch sent through a relayer has no deployer wallet, but its liquidity has a
    // provider). Never a pool or the pool manager, which stand in when an event names no wallet.
    const suspects = [...new Set([...(deployer !== coin ? [deployer] : []), ...(traded.first ? [traded.first] : [])])].filter(wallet => !poolHolders.has(wallet));
    let pulled: NonNullable<NonNullable<CardSources['liquidity']>['pulled']> | undefined, removedAt = -1;
    for (const wallet of suspects) {
      const own = traded.wallets.get(wallet);
      if (!own || own.peak <= 0n || !own.removals.length) continue;
      const share = 1 - Number(own.held > 0n ? own.held : 0n) / Number(own.peak);
      if (share > (pulled?.share ?? 0)) { pulled = { share, by: wallet === deployer && deployer !== coin ? 'deployer' : 'provider', wallet, evidence: own.removals.slice(-5) }; removedAt = own.lastRemoval; }
    }
    // Liquidity added to another pool of the coin at or after the removal is a move to that pool, not a pull.
    if (pulled && [...liquidityOf].some(([id, other]) => id !== rowHex(main!.id) && other.lastAdd >= removedAt)) pulled = undefined;
    s.liquidity = { positions: mine.map(({ pool: _pool, ...p }) => p), priorRemovals: [], ...(pulled ? { pulled } : {}) };
  } else if (s.launchpad === 'pons' && positions.length && (poolRows.length===1 || [...weights.values()].every(v=>v>0))) {
    s.liquidity = { positions:positions.map(({ pool,...p })=>({...p,share:p.share*(poolRows.length===1 ? 1 : weights.get(pool)!/reserveTotal)})), priorRemovals: [] };
  }
  if (s.liquidity) {
    const priorCoins = history.launches.map(p => p.coin);
    if (priorCoins.length) s.liquidity.priorRemovals = (await db.sql.query<EventRow>(`SELECT e.* FROM liquidity_events e JOIN pools p ON p.id=e.pool_id JOIN tokens t ON t.address=p.currency0 OR t.address=p.currency1
      WHERE t.deployer=$1 AND t.address<>$2 AND e.actor=$1 AND e.block<=$3 AND (e.kind='Burn' OR (e.kind='ModifyLiquidity' AND (e.data->>'liquidityDelta')::numeric<0)) ORDER BY e.block,e.log_index`, [binary(deployer), binary(coin), block])).rows.map(e => evidence(e, 'Prior liquidity removal'));
    const priorLifetime=(await db.sql.query<{data:import('@eko/db').Lifetime}>(`SELECT l.data FROM coin_lifetime l JOIN tokens t ON t.address=l.coin WHERE t.deployer=$1 AND t.address<>$2`,[binary(deployer),binary(coin)])).rows;
    s.liquidity.priorRemovalCount=s.liquidity.priorRemovals.length+priorLifetime.reduce((n,r)=>n+((r.data.priorRemovalLastBlock ?? Infinity)<=block ? r.data.priorRemovalCount ?? 0 : (r.data.priorRemovals ?? []).filter(e=>e.block<=block).length),0);
    s.liquidity.priorRemovals.push(...priorLifetime.flatMap(r=>(r.data.priorRemovals ?? []).filter(e=>e.block<=block)));
    s.sectionBlocks.liquidity = block;
  }
  if (token.graduated_block != null && Number(token.graduated_block) <= block) {
    const gb = Number(token.graduated_block);
    const gt = clock?.get(gb) ?? (await db.sql.query<{ ts: Date }>('SELECT ts FROM engine_block_times WHERE number=$1', [gb])).rows[0];
    const postBlock=upperBlock(swaps,gb-1);
    const candidates=cachedRows?.nonCurveSwaps ?? swaps.slice(0,swapEnd).filter(r=>r.venue!=='pons_curve');
    const candidate=candidates[upperBlock(candidates,gb-1)];
    const first=candidate && Number(candidate.block)<=block ? candidate : undefined;
    if (gt && first) {
      const atSec = seconds(gt.ts), insiders = new Set([deployer, ...exemptions.map(e => rowHex(e.wallet))]);
      const retainedOpening=(await db.sql.query<{graduation_holdings:Record<string,string>|null}>('SELECT graduation_holdings FROM coin_lifetime WHERE coin=$1',[binary(coin)])).rows[0]?.graduation_holdings;
      const held=retainedOpening ? [...insiders].reduce((n,w)=>n+Number(retainedOpening[w.slice(2)] ?? 0),0) : cache ? [...(await cache.holderViewAt(coin,gb-1,[...insiders],'graduation')).amounts].sort(([a],[b])=>a.localeCompare(b)).reduce((n,[,amount])=>n+Number(amount),0) : (await holdingsAt(db,coin,gb-1)).filter(r=>insiders.has(rowHex(r.holder))).reduce((n,r)=>n+Number(r.amount),0);
      const before=swaps[Math.min(postBlock,swapEnd)-1] ?? (savedLifetime?.last && Number(savedLifetime.last.block)<gb ? prepareSwap(unpackSwap(savedLifetime.last)) : undefined);
      s.graduation = { atSec, tx: evidence(first,'Graduation marker: first indexed pool swap'), insiderSells: held > 0 ? timeWindow(swaps,atSec-0.001,atSec+300,swapEnd,trade.monotonic).filter(r=>r.side===-1 && insiders.has(r.traderHex!) && r.usd!=null).map(r => ({
        atSec: r.sec!, soldShare: Number(r.amount_coin) / held,
        priceImpactShare: before?.usd != null ? Math.max(0,1 - (r.usd! / Number(r.amount_coin)) / (before.usd / Number(before.amount_coin))) : 0,
        evidence: [evidence(r,'Insider sell after graduation')] })) : [] };
    }
  }
  if(lifetime?.graduation && token.graduated_block!=null) {
    const g=lifetime.graduation,insiders=new Set([deployer,...exSet]);
    const opening=(await db.sql.query<{graduation_holdings:Record<string,string>|null}>('SELECT graduation_holdings FROM coin_lifetime WHERE coin=$1',[binary(coin)])).rows[0]?.graduation_holdings;
    const held=opening ? [...insiders].reduce((n,w)=>n+Number(opening[w.slice(2)] ?? 0),0) : (await holdingsAt(db,coin,g.block-1)).filter(r=>insiders.has(rowHex(r.holder))).reduce((n,r)=>n+Number(r.amount),0);
    s.graduation={atSec:g.atSec,tx:evidence(unpackSwap(g.first),'Graduation marker: first indexed pool swap'),insiderSells:held>0 ? Object.entries(g.actors).filter(([w])=>insiders.has(w as Address)).map(([,a])=>({
      atSec:a.atSec,soldShare:a.amount/held,priceImpactShare:g.before?.usd!=null ? Math.max(0,1-a.minPrice/(g.before.usd/Number(g.before.amount_coin))) : 0,
      evidence:a.refs.map(r=>evidence(unpackSwap(r),'Insider sell after graduation'))})) : []};
  }
  // TODO(spec): trend onset is not indexed; use the first priced trade in the preceding hourly window.
  // Retention saves this list before deleting swaps it reads (trending_snapshots), so it survives pruned coins.
  const trending=async():Promise<NonNullable<CardSources['trending']>>=> (await trendingAt(db,s.createdAtBlock,createdAtSec - 3600)).map((r,i) => ({ coin: r.coin as Address, name: toUntrusted(r.name,120).text, symbol: toUntrusted(r.symbol,32).text,
      rank: i+1, createdAtSec: seconds(r.created), trendStartedAtSec: seconds(r.started), evidence: [{ kind:'stat', ref:`${r.coin}:trending:${s.createdAtBlock}`, block:s.createdAtBlock, label:'Hourly USD volume rank', value:i+1 }] }));
  s.trending=cache ? await cache.trending(s.createdAtBlock,trending) : await trending();
  const ranked=cache ? await cache.ranked(block,asOfSec) : memo ? await sharedRanks(db,memo,block,asOfSec) : await liveRanks(db,block,asOfSec);
  const rank=ranked.get(coin);if(rank!=null)s.trendingRank=rank;
  const lifetimeGap=trade.attribution,hour=checkpoint?.data.checkpointHour ? gapFromTotals(checkpoint.data.checkpointHour,'trailing_1h') : attributionGap(trade.recent,'trailing_1h');
  const compactedLiquidity=Object.values(savedLifetime?.liquidity ?? {}).reduce((v,p)=>({events:v.events+p.events,missing:v.missing+p.missing}),{events:0,missing:0});
  const liquidityMissing=compactedLiquidity.missing+events.filter(e=>e.actor==null || e.senders_pending).length;
  const deferred=Number((await db.sql.query<{n:string}>(`SELECT count(*) AS n FROM pending_pool_events e JOIN pools p ON p.id=e.emitter
    WHERE (p.currency0=$1 OR p.currency1=$1) AND e.block<=$2`,[binary(coin),block])).rows[0].n);
  const liquidityGap:import('@eko/shared').AttributionCoverageGap={reason:'unattributed_liquidity',window:'pool_creation_to_checkpoint',status:liquidityMissing || deferred ? 'incomplete':'complete',
    threshold:0,totalCount:events.length+compactedLiquidity.events+deferred,unattributedCount:liquidityMissing+deferred,countShare:events.length+compactedLiquidity.events+deferred ? (liquidityMissing+deferred)/(events.length+compactedLiquidity.events+deferred):0,
    totalVolumeUsd:null,unattributedVolumeUsd:null,volumeShare:null,unknownVolumeCount:liquidityMissing+deferred};
  let graduationGap=lifetimeGap;
  if(lifetime?.graduation) {const g=lifetime.graduation;graduationGap=gapFromTotals({totalCount:g.count,unattributedCount:g.missing,totalVolumeUsd:g.volume,unattributedVolumeUsd:g.missingVolume,unknownVolumeCount:g.unknown},'graduation_to_5m');}
  else if(s.graduation)graduationGap=attributionGap(timeWindow(swaps,s.graduation.atSec-0.001,s.graduation.atSec+300,swapEnd,trade.monotonic),'graduation_to_5m');
  const coverage={holder_concentration:lifetimeGap,insider_sells:graduationGap,deployer_sells:lifetimeGap,bundles:lifetimeGap,fresh_wallet_share:lifetimeGap,
    wallet_flow:hour,wash_trading:hour,exempt_insiders:lifetimeGap,liquidity_ownership:liquidityGap};
  if(lifetime && s.supply && s.supply.total>0n) {
    const total=Number(s.supply.total),buyerSet=new Set(lifetime.buyers),top=holderView.top.slice(0,10);
    if(!lifetime.unknownBuyers) {
      const largest=top.find(h=>h.wallet!==deployer),transferred=top.filter(h=>h.wallet!==deployer && !buyerSet.has(h.wallet));
      s.holders={top10Share:top.reduce((n,h)=>n+h.amount,0)/total,largestShare:(largest?.amount ?? 0)/total,largest:largest?.wallet ?? null,
        transferredShare:transferred.reduce((n,h)=>n+h.amount,0)/total,transferredWallets:transferred.length,evidence:transferred.map(h=>({kind:'address',ref:h.wallet,label:'Holder that never bought'}))};
    }
    const dev=lifetime.devByActor?.[deployer] ?? lifetime.dev;
    if(dev.complete)s.dev={heldShare:s.holderSummary.dev/total,cashInUsd:dev.cashIn,cashOutUsd:dev.cashOut,soldShare:dev.sold/total,
      firstSellSec:dev.sells.length ? Date.parse(dev.sells[0].ts)/1000-createdAtSec : null,evidence:dev.sells.map(r=>evidence(unpackSwap(r),'Deployer sell'))};
    else delete s.dev;
    if(lifetime.earlyComplete) {
      const early=Object.entries(lifetime.early),othersNet=lifetime.net-early.reduce((n,[,e])=>n+e.gross-e.sold,0);
      s.earlyBuyers=early.map(([wallet,e])=>({wallet:wallet as Address,funder:(e.first.trader ?? wallet) as Address,
        fundedAtSec:Date.parse(e.first.ts)/1000,buyAtSec:Date.parse(e.first.ts)/1000,buyBlock:Number(e.first.block),
        boughtShare:Math.max(0,e.gross-e.soldEarly)/total,heldShare:Number(holderView.amounts.get(wallet as Address) ?? 0n)/total,
        deployer:e.deployer || wallet===deployer || (e.funders ?? []).includes(deployer),sellingIntoNetInflow:e.sold>=e.gross*0.5 && othersNet>0,evidence:[evidence(unpackSwap(e.first),'Early-block buy')]}));
    } else delete s.earlyBuyers;
    if(s.pons)s.pons.boughtShare=[...exSet].reduce((n,w)=>n+(lifetime.exemptBought[w] ?? 0),0)/total;
    if(s.runUp)s.runUp.outShare=Math.max(0,lifetime.net)/total;
    if(lifetime.usdComplete && s.curve) { s.curve.volumeUsd=lifetime.curveVolume;s.curve.progressUsd=Math.max(0,lifetime.curveNet); }
  }
  s.attributionCoverage=coverage;
  if(prune && (!savedLifetime || savedLifetime.legacyIncomplete)) {
    // Checks over the coin's whole life or early history lost their raw rows. Holdings stay exact (balances and
    // baselines) and the trailing-hour checks read only new activity, so those are still measured.
    if(prune.swaps)for(const key of ['deployer_sells','bundles','fresh_wallet_share','exempt_insiders'] as const)coverage[key]=prunedGap(prune.swaps,swapEnd);
    if(prune.liquidity)coverage.liquidity_ownership=prunedGap(prune.liquidity,events.length);
    if(token.graduated_block!=null && Number(token.graduated_block)<=prune.watermark && prune.transfers+prune.swaps>0)coverage.insider_sells=prunedGap(prune.transfers+prune.swaps,swapEnd);
    // Lifetime curve volume and progress come from the deleted swaps.
    if(prune.swaps)delete s.curve;
    if(prune.dangerBeforePrune)s.dangerBeforePrune=prune.dangerBeforePrune;
  }
  if(hour.status==='incomplete'){delete s.wash;delete s.dominantPair;}
  if(coverage.exempt_insiders.status==='incomplete')delete s.pons;
  if(coverage.insider_sells.status==='incomplete')delete s.graduation;
  if(coverage.liquidity_ownership.status==='incomplete')delete s.liquidity;
  await loadReferenceInputs(db,s,retrospective || cache!==undefined);
  if(!retrospective && cache===undefined)await loadSellCheckReference(db,s);
  return s;
}

async function unavailable(db:ChainDb,coin:Address,block:number,reason:string,retrospective=false):Promise<null> {
  const failure=(await db.sql.query<{attempts:string}>(`INSERT INTO engine_card_failures(coin,attempts,last_block,reason) VALUES($1,1,$2,$3)
    ON CONFLICT(coin) DO UPDATE SET attempts=engine_card_failures.attempts+1,last_block=excluded.last_block,reason=excluded.reason RETURNING attempts::text`,[binary(coin),block,reason])).rows[0];
  const firstRating=!(await db.sql.query('SELECT 1 FROM coin_card_latest WHERE coin=$1',[binary(coin)])).rows.length;
  await countEvaluations(db,[{path:retrospective?'replay':'sources',outcome:Number(failure.attempts)>1?'retry_failed':'failed',reason,firstRating,count:1}]);
  return null;
}
/** One hourly priced-swap read per (block, time) per poll, instead of one per evaluated coin. */
function sharedRanks(db:ChainDb,memo:SourceMemo,block:number,sec:number) {
  const key=`${block}:${sec}`;let found=memo.ranks.get(key);
  if(!found){found=liveRanks(db,block,sec);memo.ranks.set(key,found);found.catch(()=>memo.ranks.delete(key));
    // Tasks run in block order, so only the most recent few (block, time) pairs are reused.
    if(memo.ranks.size>8)memo.ranks.delete(memo.ranks.keys().next().value!);}
  return found;
}
export async function loadSources(db:ChainDb,coin:Address,block:number,client?:PonsProfileClient,clock?:ClockCache,cache?:ReplayCache,retrospective=false,memo?:SourceMemo) {
  try {
    if(!retrospective) {
      await recordFirstPlans(db,[coin],block,'sources');
      await db.sql.query(`UPDATE engine_first_scan_plans SET started_at=clock_timestamp(),sources_ready_at=NULL
        WHERE coin=$1 AND NOT EXISTS(SELECT 1 FROM coin_card_latest WHERE coin=$1)`,[binary(coin)]);
    }
    const revision=async()=> (await db.sql.query<{revision:string}>('SELECT revision::text FROM coin_lifetime WHERE coin=$1',[binary(coin)])).rows[0]?.revision ?? 'absent';
    for(let attempt=0;attempt<2;attempt++) {
      const before=await revision(),sources=await readSources(db,coin,block,client,clock,cache,retrospective,memo);
      if(before===await revision()) {
        if(sources && !retrospective)await db.sql.query('UPDATE engine_first_scan_plans SET sources_ready_at=clock_timestamp() WHERE coin=$1 AND started_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM coin_card_latest WHERE coin=$1)',[binary(coin)]);
        return sources;
      }
    }
    return unavailable(db,coin,block,'retention_in_progress',retrospective);
  }
  catch(error){await unavailable(db,coin,block,rpcStopReason(error) ?? (isRpcUnavailable(error)?'rpc_unavailable':'source_load_failed'),retrospective);throw error;}
}
