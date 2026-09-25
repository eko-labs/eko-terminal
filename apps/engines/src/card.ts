import { canonicalize } from '@eko/policy';
import { loadRegistry } from '@eko/chain';
import { CONFIG_V1, cloneFromMatches, rules } from '@eko/playbooks';
import { computeSignal, compositeFromReadings, type SignalInput } from '@eko/signal';
import { toUntrusted } from '@eko/untrusted';
import type { CoinCard, PlaybookId, Verdict } from '@eko/shared';
import { ZERO } from './aggregates.js';
import { keccak256, stringToHex } from 'viem';
import { type LoadedSources } from './sources.js';

/** Checks with no input source yet. Clear does not wait for them; the verdict names them (worker.ts). */
/** Checks with no input source; Clear does not wait for them. None since 2026-10-12, when bundle_dump was sourced. */
export const UNSOURCED_PLAYBOOKS: readonly PlaybookId[] = [];
const zeroHook = /^0x0{40}$/i;
let ponsHook: string | undefined | null;
/** The launchpad's own graduation hook (registry pons.v4Hook, code verified), which every graduated Pons pool uses. */
const isPonsHook = (hook: string) => { if (ponsHook === undefined) ponsHook = loadRegistry().addressOf('pons.v4Hook')?.toLowerCase() ?? null; return !!ponsHook && hook.toLowerCase() === ponsHook; };
/**
 * A check counts as evaluated when its input was read, or when the coin's structure means it cannot apply at this
 * block: no migration dump before graduation, no removable LP while liquidity sits in the Pons curve or the locked
 * graduation pool, no stuck curve after graduation, no hook abuse on a coin whose pools have no hook or only the
 * launchpad's own verified graduation hook (187 graduated Pons coins on 2026-10-11). Before 2026-10-10
 * these counted as not run, so no Pons coin could ever be Clear.
 * A coin that never had a Pons curve (it launched in a Uniswap pool) has no curve to be stuck on, no graduation to dump
 * into and no snipe-tax exemptions; its hook check reads the pool it trades in, not every pool anyone opened for it.
 */
export function evaluatedPlaybooks(s: LoadedSources): PlaybookId[] {
  const pons = s.launchpad === 'pons';
  const graduated = s.token.graduated_block != null && Number(s.token.graduated_block) <= s.asOfBlock;
  const curveOnly = pons && !graduated && s.poolRefs.length === 0;
  const available: Partial<Record<PlaybookId, boolean>> = {
    honeypot: [100,1000].every(size=>s.referenceResults?.some(r=>r.sizeUsd===size && r.complete)) || s.sellCheckReference != null || s.observedSellers != null,
    agent_bait: true, serial_deployer: true, clone_swarm: s.trending != null,
    wash_to_trend: s.wash != null, fee_trap_pool: s.pools != null,
    exempt_insiders: s.pons != null || !pons, tax_trap: s.taxes != null && (s.launchpad!=='pons' || s.antiSnipeActive === false),
    removable_liquidity: s.liquidity != null || curveOnly || (pons && graduated),
    migration_dump: s.graduation != null || (pons && !graduated) || (!pons && !s.token.curve),
    stuck_at_bonding: s.curve != null || (pons && graduated) || (!pons && !s.token.curve),
    malicious_hook: s.hook != null || s.poolRefs.every(p => !p.hooks || zeroHook.test(p.hooks) || isPonsHook(p.hooks))
      || (s.mainPool != null && (!s.mainPool.hooks || zeroHook.test(s.mainPool.hooks) || isPonsHook(s.mainPool.hooks))),
    // Every buy in the early window named its buyer (sources.ts); an empty cohort is a check that ran and found none.
    bundle_dump: s.earlyBuyers != null,
    holder_concentration: s.holders != null, dev_dump: s.dev != null,
    // Measured from the trades of a Pons coin still on its curve; nothing to measure once it has graduated or off Pons.
    run_up: s.runUp != null || !pons || graduated,
    // Elysium-only (priority-fee launch auctions, measured by apps/edge); the Robinhood Chain engine has nothing to measure.
    launch_snipers: s.snipers != null || s.launchpad !== 'montra',
  };
  return (Object.keys(rules) as PlaybookId[]).filter(id => available[id]).sort();
}
/** Percent of supply the early cohort (bundle_dump's window, the deployer included) holds at the card's block; 0 when not measured. */
export function earlyHeldPct(s: LoadedSources): number {
  const window = CONFIG_V1.bundle_dump.cohortSec, seen = new Set<string>();
  let held = 0;
  for (const b of s.earlyBuyers ?? []) {
    if (b.buyAtSec - s.createdAtSec >= window || seen.has(b.wallet.toLowerCase())) continue;
    seen.add(b.wallet.toLowerCase()); held += b.heldShare;
  }
  return Math.min(100, Math.max(0, held * 100));
}
export function assembleCard(s: LoadedSources, verdict: Verdict): CoinCard {
  const denominator = s.supply ? Number(s.supply.total) : 0;
  const pct = (n: number) => denominator ? Math.min(100, 100 * n / denominator) : 0;
  const graduated = (s.token.graduated_block != null && Number(s.token.graduated_block) <= s.asOfBlock) || (!s.token.curve && s.poolRefs.length>0);
  const liquidityStatus = graduated && s.launchpad === 'pons' ? 'pons_locked' : s.liquidity?.positions.some(p => p.status === 'removable') ? 'removable' : 'locked';
  const references=s.referenceResults ?? [];
  const referenceComplete=[100,1000].every(size=>references.some(r=>r.sizeUsd===size && r.complete && r.status!=='contract_restricted')) && references.some(r=>r.probe?.buyOk);
  const primary=references.filter(r=>r.sizeUsd!==10000 && r.exitCostPct!==null).sort((a,b)=>(b.exitCostPct ?? -Infinity)-(a.exitCostPct ?? -Infinity) || a.sizeUsd-b.sizeUsd)[0];
  const missingReferences=[100,1000,10000].filter(size=>!references.some(r=>r.sizeUsd===size && r.exitCostPct!==null)).map(size=>`referenceUsd${size}`);
  if(primary?.buyTaxPct==null)missingReferences.push('buyTax');
  if(primary?.sellTaxPct==null)missingReferences.push('sellTax');
  const meta: NonNullable<CoinCard['meta']> = {
    identity: { confidence: 1, asOfBlock: s.sectionBlocks.identity },
    tradeability: { confidence: referenceComplete ? 1 : 0, asOfBlock: s.asOfBlock, unavailable: !referenceComplete, flags:references.filter(r=>r.status==='entry_limited').map(r=>`entry_limited_usd${r.sizeUsd}`), missing: referenceComplete ? missingReferences : ['simulations', 'exitCosts', 'antiSnipeTiming', ...missingReferences, ...(!s.taxes ? ['taxes'] : [])] },
    liquidity: { confidence: s.liquidity ? 0.5 : 0, asOfBlock: s.sectionBlocks.liquidity ?? s.asOfBlock, unavailable: !s.liquidity, missing: ['depthUsd', 'routing', 'completeLpOwnership', ...(s.poolRefs.some(p=>p.feeBps>=0x800000/100) ? ['dynamicPoolFees'] : [])] },
    supply: { confidence: s.supply ? 0.5 : 0, asOfBlock: s.sectionBlocks.supply ?? s.asOfBlock, unavailable: !s.supply,
      missing: ['knownLocksAndVesting', ...(s.earlyBuyers ? [] : ['bundlesHeldPct']), 'freshWalletsPct', ...(!s.supply ? ['circulating', 'totalSupply'] : [])] },
    // Owner powers read from the token's bytecode (pons-profile.ts ownerPowers); not analysed without that read.
    control: s.profile?.powers ? { confidence: 0.5, asOfBlock: s.asOfBlock } : { confidence: 0, asOfBlock: s.asOfBlock, unavailable: true, missing: ['ownerPowerAnalysis'] },
    flow: { confidence: 0, asOfBlock: s.asOfBlock, unavailable: true, missing: ['agentPct', 'crewPct', 'humanPct'] },
    playbooks: { confidence: evaluatedPlaybooks(s).length / Object.keys(rules).length, asOfBlock: s.asOfBlock, missing: (Object.keys(rules) as PlaybookId[]).filter(id => !evaluatedPlaybooks(s).includes(id)) },
  };
  const coverage=s.attributionCoverage ?? {};
  const attach=(section:keyof typeof meta,keys:string[])=>{
    const gaps=Object.fromEntries(keys.filter(key=>coverage[key]).map(key=>[key,coverage[key]]));
    const m=meta[section]!;m.coverageGaps=gaps;
    m.missing=[...new Set([...(m.missing ?? []),...Object.entries(gaps).filter(([,gap])=>gap.unattributedCount>0).map(([key])=>`${key}:unattributed`)])];
    if(Object.values(gaps).some(gap=>gap.status==='incomplete'))m.flags=[...(m.flags ?? []),'attribution_incomplete'];
  };
  attach('supply',['holder_concentration','bundles','fresh_wallet_share']);
  attach('flow',['wallet_flow','wash_trading']);
  attach('liquidity',['liquidity_ownership']);
  attach('playbooks',['insider_sells','deployer_sells','exempt_insiders','wash_trading']);
  // TODO(spec): legacy CoinCard requires numeric/boolean fields for unavailable checks.
  // Structural zero/false values below are masked by meta, never supplied to a rule or claimed as observations.
  const card: CoinCard = {
    identity: { address: s.coin, name: toUntrusted(s.token.name!,120), symbol: toUntrusted(s.token.symbol!,32), deployer: s.deployer,
      createdAt: new Date(s.createdAtSec * 1000).toISOString(), launchpad: s.launchpad, stage: graduated ? 'graduated' : 'curve',
      ...(s.curvePct==null ? {} : {curvePct:s.curvePct}), quoteAsset: s.poolRefs.some(p=>p.quote===ZERO) || s.trade.hasEth ? 'ETH' : 'other', pools: s.poolRefs },
    clone: cloneFromMatches(verdict.playbooks),
    tradeability: { exitCostPct: { usd100:references.find(r=>r.sizeUsd===100)?.exitCostPct ?? 0,usd1k:references.find(r=>r.sizeUsd===1000)?.exitCostPct ?? 0,usd10k:references.find(r=>r.sizeUsd===10000)?.exitCostPct ?? 0 }, buyTaxPct:primary?.buyTaxPct ?? s.taxes?.buyPct ?? 0, sellTaxPct:primary?.sellTaxPct ?? s.taxes?.sellPct ?? 0, honeypot:references.some(r=>r.honeypotConfirmed) },
    liquidity: { depthUsd: { pct2:0,pct5:0,pct10:0 }, lpStatus:liquidityStatus, feeTiers:s.pools?.map(p => p.feeBps / 100) ?? [] },
    supply: { top10Pct:pct(s.holderSummary.top10),
      devPct:pct(s.holderSummary.dev), bundlesHeldPct:earlyHeldPct(s),
      exemptWalletsHeldPct:(s.pons?.heldShare ?? 0)*100, freshWalletsPct:0, burnedPct:pct(Number(s.supply?.burned ?? 0n)),
      circulating: s.supply && s.token.decimals != null ? units(s.supply.circulating,s.token.decimals) : '' },
    control: { canChangeTax:false,canBlacklist:s.profile?.powers?.blacklist ?? false,canPause:s.profile?.powers?.pause ?? false,canMint:s.profile?.powers?.mint ?? false,upgradeable:s.profile?.powers?.upgrade ?? false },
    flow: { window:'1h',agentPct:0,crewPct:0,humanPct:0,washEstPct:s.wash?.washEstPct ?? 0,beta:true,confidence:0 },
    playbooks:verdict.playbooks,verdict,meta,
    freshness: { block:Math.min(...Object.values(meta).filter(m => !m.unavailable).map(m => m.asOfBlock)), ageSec:0 },
  };
  const price=s.trade.lastPriced;
  if (price && s.supply && s.asOfSec - s.createdAtSec < 7*86400 && price.usd! / Number(price.amount_coin) * Number(s.supply.circulating) > 1e10) meta.supply!.flags = ['supply_anomaly'];
  const change=(prev:LoadedSources['trade']['last'])=>{const last=s.trade.last;return last && prev && prev.price_quote>0 ? 100*(last.price_quote/prev.price_quote-1) : 0;};
  const rank=s.trendingRank;
  const input: SignalInput = { priceChange5mPct:change(s.trade.previous5m),priceChange1hPct:change(s.trade.previous1h),
    buyVolumeUsd1h:s.trade.buy1h,buyVolumeUsdPrevious1h:s.trade.buyPrevious1h,
    depth2Usd:0,exitCost1kPct:0,holdersNow:s.holderSummary.count,holdersPrevious1h:s.holderSummary.previousCount,
    top10Pct:card.supply.top10Pct,freshWalletsPct:0,bundlesHeldPct:card.supply.bundlesHeldPct,trendingRank:rank,
    playbooks:verdict.playbooks,control:card.control,lpStatus:card.liquidity.lpStatus,asOfBlock:s.asOfBlock };
  const signal = computeSignal(input);
  signal.readings.liquidity = 50;
  if (s.previousHolderBlock==null || !s.supply) signal.readings.holders=50;
  signal.lowData = [...new Set([...(signal.lowData ?? []), 'liquidity', 'holders', 'risk'] as const)];
  if (!s.usdComplete || !s.trade.count) { signal.readings.momentum = 50; signal.lowData.push('momentum'); }
  signal.composite = compositeFromReadings(signal.readings);
  card.signal = signal;
  return roundCard(card);
}
const units = (n: bigint, decimals: number) => decimals ? `${n / 10n**BigInt(decimals)}.${(n % 10n**BigInt(decimals)).toString().padStart(decimals,'0')}`.replace(/\.?0+$/,'') : n.toString();
export const digest = (value: unknown) => keccak256(stringToHex(canonicalize(value)));
function transform(value: unknown, hash: boolean, key = ''): unknown {
  if (Array.isArray(value)) return value.map(v => transform(v,hash,key));
  if (value && typeof value==='object') {
    const stat=value as { kind?:string;label?:string;value?:number };
    if (stat.kind==='stat' && typeof stat.value==='number') {
      let rounded=stat.value;
      if (/%|tax|gap/i.test(stat.label ?? '')) rounded=Math.round(rounded*2)/2;
      else if (/share|holdings sold/i.test(stat.label ?? '')) rounded=Math.round(rounded*200)/200;
      else if (/usd/i.test(stat.label ?? '') && rounded!==0) rounded=Number(rounded.toPrecision(2));
      value={...value,value:rounded};
    }
    return Object.fromEntries(Object.entries(value as object).filter(([k]) => !hash || !['freshness','asOfBlock','block','receipt','lastChecked'].includes(k)).map(([k,v]) => [k,transform(v,hash,k)]));
  }
  if (typeof value==='number') {
    if (key==='curvePct') return Math.round(value*100)/100;
    if (/pct/i.test(key)) return Math.round(value*2)/2;
    if (/share/i.test(key)) return Math.round(value*200)/200;
    if (/usd/i.test(key) && value!==0) return Number(value.toPrecision(2));
  }
  return value;
}
export const roundCard = (card: CoinCard) => transform(card,false) as CoinCard;
/** TODO(spec): hash scope excludes block stamps and receipt identity do not create content versions; the latest view carries their freshness. */
export const cardHash = (card: CoinCard) => digest(transform(card,true));
