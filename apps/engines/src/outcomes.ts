import { binary, unpackSwap, type ChainDb } from '@eko/db';
import type { Address, EvidenceRef, PlaybookMatch } from '@eko/shared';
import { RULES_VERSION, type PriorLaunch } from '@eko/playbooks';
import type { ClockCache } from './activity.js';
import type { ReplayCache } from './replay-cache.js';
import { rowHex } from './aggregates.js';
import { evidence, holdingsAt, loadSources, seconds } from './sources.js';

export async function materializeHistory(db: ChainDb, coin: Address, block: number,cache?:ReplayCache) {
  const cachedToken=cache?.tokens.get(coin);
  const token = cachedToken ? {...cachedToken,ts:cache!.clock.get(Number(cachedToken.first_block))!.ts} : (await db.sql.query<{ deployer: Uint8Array; first_block: string; ts: Date }>('SELECT t.deployer,t.first_block,b.ts FROM tokens t JOIN engine_block_times b ON b.number=t.first_block WHERE t.address=$1', [binary(coin)])).rows[0];
  if (!token?.deployer) return;
  const matches = cache ? cache.matchesAt(coin,block) : (await db.sql.query<{ data: PlaybookMatch }>('SELECT data FROM (SELECT data,valid_from_block,playbook_id FROM playbook_matches WHERE coin=$1 AND valid_from_block<=$2 AND rules_version=$3 UNION ALL SELECT jsonb_build_object(\'id\',playbook_id,\'level\',level),first_block,playbook_id FROM coin_match_lifetime WHERE coin=$1 AND first_block<=$2 AND rules_version=$3) m ORDER BY valid_from_block,playbook_id', [binary(coin),block,RULES_VERSION])).rows.map(r => r.data);
  const strongest = new Map<string,Pick<PlaybookMatch,'id'|'level'>>();
  const level = { danger:3,monitor:2,info:1,clear:0 };
  for (const m of matches) if (!strongest.has(m.id) || level[m.level]>level[strongest.get(m.id)!.level]) strongest.set(m.id,m);
  const outcomes = cache ? cache.outcomesAt(coin,block) : (await db.sql.query<{ valid_from_block: string; horizon: '1h'|'24h'|'7d'; outcome: PriorLaunch['outcomes'][number]['outcome']; data: { evidence: EvidenceRef[] } }>('SELECT horizon,outcome,data,valid_from_block FROM outcomes WHERE coin=$1 AND valid_from_block<=$2 ORDER BY horizon', [binary(coin),block])).rows;
  const data: PriorLaunch = { coin,createdAtSec:seconds(token.ts),relation:'deployer',matches:[...strongest.values()].map(m => ({ id:m.id,level:m.level })),
    outcomes:outcomes.map(r => ({ horizon:r.horizon,outcome:r.outcome,validFromBlock:Number(r.valid_from_block),evidence:r.data.evidence })),evidence:[{ kind:'address',ref:coin,block:Number(token.first_block),label:'Prior deployer launch' }] };
  await db.sql.query('INSERT INTO deployer_stats VALUES($1,$2,$3,$4,$5) ON CONFLICT(deployer,coin,valid_from_block,rules_version) DO UPDATE SET data=excluded.data', [token.deployer,binary(coin),block,JSON.stringify(data),RULES_VERSION]);
  cache?.recordHistory(rowHex(token.deployer),block,data);
}
/** A live engine retries a skipped outcome (no end block, no trades, no price yet) at most this often. */
export const OUTCOME_SKIP_RETRY_SEC = 1800;
/** Horizon evaluations (a full source load each) a live write may make before it commits; the rest wait for later writes. */
export const OUTCOME_LOADS_PER_WRITE = 8;
/** Bounds one updateOutcomes call: `loads` horizon evaluations may still start; `used` counts the ones started. */
export interface OutcomeBudget { loads: number; used: number }
/**
 * Live: the due launches one call read, kept for the following calls of a poll until a call has tried every one. The
 * query reads every launch (about 8 s in production on 2026-10-09) and ran on every card write while outcomes were
 * behind, so it took most of each write.
 */
export interface OutcomeQueue { rows?: { address: Uint8Array; ts: Date; done: string[] }[] }
/**
 * `skips` (live mode) remembers outcomes that could not be decided yet. Without it, every coin that never traded was
 * reloaded on every write while the engine held its write lock, so evaluations slowed to minutes each.
 *
 * `budget` (live mode) bounds the horizon evaluations of one call, oldest launches first, and the call returns false
 * when it stopped with evaluations left; the caller calls again on a later write. Unbounded, the first write after an
 * outage evaluated every launch's passed horizons (production 2026-10-09: about 34,000 coins, hours) inside its write
 * transaction before any card committed. Replay (`cache`) is never bounded. Returns true when every due horizon was
 * tried.
 */
export async function updateOutcomes(db: ChainDb, block: number, nowSec: number, clock?:ClockCache,cache?:ReplayCache,skips?:Map<string,number>,budget?:OutcomeBudget,queue?:OutcomeQueue) {
  // Live: only launches with a passed horizon that has no outcome yet, with the horizons they have. A token without a
  // deployer never loads sources (WETH and other non-launchpad tokens: 21,000 of 38,000 in production), so it has none.
  const tokens = cache ? [...cache.tokens.values()].filter(t=>t.deployer!=null && Number(t.first_block)<=block && seconds(cache.clock.get(Number(t.first_block))!.ts)<=nowSec-3600 && cache.outcomesAt(rowHex(t.address),Infinity).length<3).sort((a,b)=>Number(a.first_block)-Number(b.first_block) || rowHex(a.address).localeCompare(rowHex(b.address))).map(t=>({address:t.address,ts:cache.clock.get(Number(t.first_block))!.ts,done:undefined as string[] | undefined})) : queue?.rows ?? (await db.sql.query<{ address: Uint8Array; ts: Date; done: string[] }>(`SELECT t.address,b.ts,
      coalesce((SELECT array_agg(o.horizon) FROM outcomes o WHERE o.coin=t.address),'{}') AS done FROM tokens t JOIN engine_block_times b ON b.number=t.first_block
    WHERE t.deployer IS NOT NULL AND t.first_block<=$1 AND b.ts<=to_timestamp($2-3600) AND EXISTS(SELECT 1 FROM (VALUES ('1h',3600),('24h',86400),('7d',604800)) h(horizon,sec)
      WHERE b.ts<=to_timestamp($2-h.sec) AND NOT EXISTS(SELECT 1 FROM outcomes o WHERE o.coin=t.address AND o.horizon=h.horizon)) ORDER BY t.first_block,t.address`, [block,nowSec])).rows;
  if(queue && !cache)queue.rows=tokens as OutcomeQueue['rows'];
  for (const token of tokens) for (const [horizon,duration] of [['1h',3600],['24h',86400],['7d',604800]] as const) {
    if (nowSec<seconds(token.ts)+duration) continue;
    const coin=rowHex(token.address);
    const attempt=`${coin}:${horizon}`;
    if(!cache && skips && (skips.get(attempt) ?? -Infinity)>nowSec-OUTCOME_SKIP_RETRY_SEC)continue;
    const skip=()=>{skips?.set(attempt,nowSec);};
    if(cache ? cache.outcomesAt(coin,Infinity).some(o=>o.horizon===horizon) || cache.outcomeAttempts.has(attempt) : token.done?.includes(horizon)) continue;
    if(budget && budget.loads<=0)return false;
    const end = cache ? cache.endBlock(seconds(token.ts)+duration,block) : (await db.sql.query<{ number:string; ts:Date }>('SELECT number,ts FROM engine_block_times WHERE ts>=to_timestamp($2) AND number<=$1 ORDER BY ts,number LIMIT 1', [block,seconds(token.ts)+duration])).rows[0];
    // Block times never decrease with height, so the earliest time at or after the horizon is its first block; this
    // order uses the (ts, number) index instead of scanning every earlier block.
    if (!end) { skip(); continue; }
    cache?.outcomeAttempts.add(attempt);
    if(budget){budget.loads--;budget.used++;}
    const s=await loadSources(db,coin,Number(end.number),undefined,clock,cache,true);
    if (!s || !(s.lifetime?.count ?? s.swaps.length)) { skip(); continue; }
    const insiders=new Set([s.deployer,...s.exemptionWallets]);
    const buys=s.lifetime ? [...insiders].reduce((n,w)=>n+(s.lifetime!.firstHourBuys[w] ?? 0),0) : s.swaps.filter(r=>r.side===1 && r.trader!=null && !r.senders_pending && insiders.has(rowHex(r.trader)) && seconds(r.ts)<=s.createdAtSec+3600).reduce((n,r)=>n+Number(r.amount_coin),0);
    const sells=s.swaps.filter(r=>r.side===-1 && r.trader!=null && !r.senders_pending && insiders.has(rowHex(r.trader)));
    const firstHourSold=s.lifetime ? [...insiders].reduce((n,w)=>n+(s.lifetime!.firstHourSells[w] ?? 0),0) : sells.filter(r=>seconds(r.ts)<=s.createdAtSec+3600).reduce((n,r)=>n+Number(r.amount_coin),0);
    const opening=await holdingsAt(db,coin,s.createdAtBlock,cache,'outcome-opening');
    const retainedOpening=(await db.sql.query<{opening_holdings:Record<string,string>|null}>('SELECT opening_holdings FROM coin_lifetime WHERE coin=$1',[token.address])).rows[0]?.opening_holdings;
    const initialHeld=retainedOpening ? [...insiders].reduce((n,w)=>n+Number(retainedOpening[w.slice(2)] ?? 0),0) : opening.filter(r=>insiders.has(rowHex(r.holder))).reduce((n,r)=>n+Number(r.amount),0);
    const denominator=Math.max(initialHeld,buys);
    const first=s.lifetime?.firstPriced ?? s.swaps.find(r=>r.usd!=null && Number(r.amount_coin)>0),last=s.lifetime?.lastPriced ?? s.swaps.filter(r=>r.usd!=null && Number(r.amount_coin)>0).at(-1);
    const sellsCount=s.lifetime ? [...insiders].reduce((n,w)=>n+(s.lifetime!.sellCounts[w] ?? 0),0) : sells.length;
    const drop=first && last ? 1-(last.usd!/Number(last.amount_coin))/(first.usd!/Number(first.amount_coin)) : null;
    // Liquidity decline uses the same pool's observed position units, never compares unlike pools.
    let liquidityRug=false,liquidityObserved=false;
    for (const pool of new Set((s.lifetime ? [] : s.events).map(e=>rowHex(e.pool_id)))) {
      let amount=0n, peak=0n;
      for (const e of s.events.filter(e=>rowHex(e.pool_id)===pool)) {
        if (!['Mint','Burn','ModifyLiquidity'].includes(e.kind)) continue;
        const delta=BigInt(e.data.liquidityDelta ?? e.data.amount ?? '0');
        amount+=e.kind==='Burn' ? -delta : delta; if (amount>peak) peak=amount;
      }
      if (peak>0n) { liquidityObserved=true; if (Number(amount)/Number(peak)<=0.2) liquidityRug=true; }
    }
    if(s.lifetime)for(const pool of Object.values(s.lifetime.liquidity ?? {}))if(BigInt(pool.peak)>0n) {liquidityObserved=true;if(Number(pool.held)/Number(pool.peak)<=0.2)liquidityRug=true;}
    const matches=cache ? cache.matchesAt(coin,Number(end.number)) : (await db.sql.query<{ data:PlaybookMatch }>('SELECT data FROM playbook_matches WHERE coin=$1 AND valid_from_block<=$2 AND rules_version=$3 UNION ALL SELECT jsonb_build_object(\'id\',playbook_id,\'level\',level) FROM coin_match_lifetime WHERE coin=$1 AND first_block<=$2 AND rules_version=$3', [token.address,end.number,RULES_VERSION])).rows.map(r=>r.data);
    // TODO(spec): survived requires an observed price or liquidity series. It records that outcome only;
    // it does not assert unperformed simulation/owner checks passed.
    if (drop==null && !liquidityObserved && !matches.some(m=>m.id==='honeypot' && m.level==='danger')) { skip(); continue; }
    const outcome = matches.some(m=>m.id==='honeypot' && m.level==='danger') ? 'honeypot' :
      liquidityRug || (drop!=null && drop>=0.9 && sellsCount>0) ? 'rugged' :
      denominator>0 && firstHourSold/denominator>0.5 ? 'dumped' : 'survived';
    if(outcome==='survived' && Object.values(s.attributionCoverage ?? {}).some(g=>g.status==='incomplete')){ skip(); continue; }
    const firstSample=s.lifetime?.first ? unpackSwap(s.lifetime.first) : s.swaps[0];
    const lastSample=s.lifetime?.last ? unpackSwap(s.lifetime.last) : s.swaps.at(-1);
    // Five canonical insider examples suffice for evidence links, alongside the exact aggregate counts.
    const sellSamples=(s.lifetime ? [...insiders].flatMap(w=>(s.lifetime!.sellEvidence[w] ?? []).map(unpackSwap)) : sells)
      .sort((a,b)=>Number(a.block)-Number(b.block)||a.log_index-b.log_index||rowHex(a.tx_hash).localeCompare(rowHex(b.tx_hash))).slice(0,5);
    const refs: EvidenceRef[]=[...(firstSample ? [evidence(firstSample,'Outcome initial price')] : []),
      ...(lastSample ? [evidence(lastSample,'Outcome horizon price')] : []),...sellSamples.map(r=>evidence(r,'Outcome insider sell'))];
    const data={ evidence:refs,attributionCoverage:s.attributionCoverage,priceDrop:drop,liquidityRug,firstHourSoldShare:denominator ? firstHourSold/denominator : null };
    await db.sql.query('INSERT INTO outcomes VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [token.address,horizon,end.number,outcome,JSON.stringify(data)]);
    if(!cache)token.done=[...token.done ?? [],horizon];
    skips?.delete(attempt);
    cache?.recordOutcome(coin,{horizon,valid_from_block:String(end.number),outcome,data});
    await materializeHistory(db,coin,block,cache);
  }
  if(queue)queue.rows=undefined;
  return true;
}
