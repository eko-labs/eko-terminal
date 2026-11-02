import { zeroAddress, type Address } from 'viem';
import { FlagNameSchema, findingsFirst, type CoinCard, type CoinSummary, type FeedItem, type PairRow, type PublicConfig, type RadarRow, type Verdict } from '@eko/shared';
import { toUntrusted, UNTRUSTED_LIMITS } from '@eko/untrusted';
import type { Assessment } from './assess.js';
import { changePct, spark } from './market.js';
import { graduationBps, HALF_WAY_BPS } from './graduation.js';
import type { CoinState, FeedEvent } from './tracker.js';

/**
 * Response builders: the shapes the EKO web app already validates (@eko/shared), filled from what the edge measures.
 * Anything not measured yet (wallet labels, holders, depth) is zero in the number field and named in `unavailable` /
 * `meta.*.missing`, never presented as an observation.
 */
export interface ViewContext { nowSec: number; head: number; hypeUsd: number | null;
  /** Base of the graduation line for launchpads without one (Tracker.openMcapHype). */
  openMcapHype?: number }

const NOT_YET = ['flow', 'signal'] as const;
const usd = (hype: number, ctx: ViewContext) => ctx.hypeUsd ? hype * ctx.hypeUsd : 0;
/** The pool's price after its last trade; before the first, a Montra pool's opening price (as Montra's own API shows it). */
const priceHype = (c: CoinState) => c.trades.at(-1)?.priceHype ?? (c.quote === zeroAddress ? c.openPrice : undefined) ?? 0;
const supplyTokens = (c: CoinState) => Number(c.supply) / 1e18;
const exitCost = (a: Assessment | undefined) => a?.probe?.exitCostPct ?? null;
const graduationPct = (c: CoinState, ctx: ViewContext) => { const bps = progressBps(c, ctx); return bps === null ? {} : { graduationPct: bps / 100 }; };
const levelOf = (a: Assessment | undefined): Verdict['level'] => a?.verdict.level ?? 'pending';
const pct = (share: number) => Math.min(100, Math.max(0, Math.round(share * 10_000) / 100));
/** What the first minute's buyers still hold. */
const earlyHeld = (a: Assessment) => a.stats.earlyBuyers.reduce((n, b) => n + b.heldShare, 0);

export function pendingVerdict(coin: CoinState, head: number): Verdict {
  const id = `pending:${coin.token.toLowerCase()}:${head}`;
  return { coin: coin.token, level: 'pending', reasons: [], playbooks: [], receipt: { id, hash: `0x${'0'.repeat(64)}`, status: 'pending' }, schemaVersion: 'verdict-1', asOfBlock: head };
}

export function coinSummary(c: CoinState, a: Assessment | undefined, ctx: ViewContext): CoinSummary {
  const top = a ? findingsFirst(a.verdict.playbooks)[0]?.id : undefined;
  const unavailable: NonNullable<CoinSummary['unavailable']> = [...NOT_YET];
  // No HYPE price, or a coin quoted in another token (its trades are not counted: tracker.ts).
  if (!ctx.hypeUsd || c.quote !== zeroAddress) unavailable.push('marketCap', 'volume');
  if (exitCost(a) === null) unavailable.push('exitCost');
  return {
    address: c.token, name: toUntrusted(a?.name ?? c.name ?? '', UNTRUSTED_LIMITS.name), symbol: toUntrusted(a?.symbol ?? c.symbol ?? '', UNTRUSTED_LIMITS.symbol),
    launchpad: c.launchpad, stage: c.graduated ? 'graduated' : 'curve', ...graduationPct(c, ctx),
    priceUsd: usd(priceHype(c), ctx), ...(ctx.hypeUsd && priceHype(c) ? {} : { priceUnavailable: true }),
    change1hPct: changePct(c.trades, ctx.nowSec - 3600), liquidityUsd: usd(Math.max(0, c.netHype), ctx),
    verdict: levelOf(a), ...(a ? { lastChecked: a.verdict.lastChecked, ratingAgeSec: Math.max(0, ctx.nowSec - Math.floor(Date.parse(a.at) / 1000)) } : {}),
    ...(top ? { topPlaybook: top } : {}), ageSec: Math.max(0, ctx.nowSec - c.ts), unavailable,
    verdictPending: levelOf(a) === 'pending', marketCapUsd: usd(priceHype(c) * supplyTokens(c), ctx),
    ...(a?.probe && a.probe.status !== 'unavailable' ? { sellCheck: { status: a.probe.status === 'sellable' ? 'sellable' as const : 'refused' as const, asOfBlock: a.block, checkedAt: a.at } } : {}),
    ...(a?.verdict.level === 'danger' && a.verdict.playbooks.some(m => m.id === 'honeypot' && m.level === 'danger') ? { hardDanger: true } : {}),
  };
}

/** Volume (HYPE) and trade count over the last hour. */
export function hourStats(c: CoinState, nowSec: number) {
  const lastHour = c.trades.filter(t => t.ts >= nowSec - 3600);
  return { volumeHype: lastHour.reduce((sum, t) => sum + t.hype, 0), trades: lastHour.length };
}

const emptyFlow = { window: '1h' as const, agentPct: 0, crewPct: 0, humanPct: 0, washEstPct: 0, beta: true, confidence: 0 };

export function radarRow(c: CoinState, a: Assessment | undefined, ctx: ViewContext, rank: number): RadarRow {
  const h = hourStats(c, ctx.nowSec);
  return { ...coinSummary(c, a, ctx), rank, flow: emptyFlow, exitCost1kPct: exitCost(a) ?? 0, spark8h: spark(c.trades, ctx.nowSec).map(p => p * (ctx.hypeUsd ?? 0)),
    volume1hUsd: usd(h.volumeHype, ctx), trades1h: h.trades };
}

export function pairRow(c: CoinState, a: Assessment | undefined, ctx: ViewContext): PairRow {
  const h = hourStats(c, ctx.nowSec);
  return { ...coinSummary(c, a, ctx), column: pairColumn(c, ctx), buyers: a?.stats.buyers ?? 0, exitCost100Pct: exitCost(a) ?? 0, flow: emptyFlow,
    ...(a?.antiSnipe ? { antiSnipe: a.antiSnipe } : {}), verdictPending: levelOf(a) === 'pending',
    ...(a ? { top10Pct: pct(a.stats.holders.top10Share), devPct: pct(a.stats.dev.heldShare), earlyHeldPct: pct(earlyHeld(a)) } : {}),
    spark8h: spark(c.trades, ctx.nowSec).map(p => p * (ctx.hypeUsd ?? 0)), volume1hUsd: usd(h.volumeHype, ctx), trades1h: h.trades };
}

/** Graduation progress in basis points, or null when it cannot be measured (graduation.ts). */
export const progressBps = (c: CoinState, ctx: ViewContext) => graduationBps(c, ctx.openMcapHype);

/**
 * Montra's three columns (graduation.ts): New, under half way to the line; About to graduate (near_grad), half way or
 * more; Graduated (migrated), past the line. Nothing migrates on Elysium: the column ids are the shared contract's.
 */
export function pairColumn(c: CoinState, ctx: ViewContext): PairRow['column'] {
  if (c.graduated) return 'migrated';
  return (progressBps(c, ctx) ?? 0) >= HALF_WAY_BPS ? 'near_grad' : 'new';
}

export function coinCard(c: CoinState, a: Assessment | undefined, ctx: ViewContext): CoinCard {
  const verdict = a?.verdict ?? pendingVerdict(c, ctx.head);
  const feeBps = a?.config ? a.config.totalFeePips / 100 : 0;
  const cost = exitCost(a);
  const block = a?.block ?? ctx.head;
  const meta = (missing: string[], extra: object = {}) => ({ confidence: 0, asOfBlock: block, unavailable: true, missing, ...extra });
  return {
    identity: { address: c.token, name: toUntrusted(a?.name ?? c.name ?? '', UNTRUSTED_LIMITS.name), symbol: toUntrusted(a?.symbol ?? c.symbol ?? '', UNTRUSTED_LIMITS.symbol),
      deployer: c.creator, createdAt: new Date(c.ts * 1000).toISOString(), launchpad: c.launchpad, stage: c.graduated ? 'graduated' : 'curve',
      quoteAsset: c.quote === zeroAddress ? 'HYPE' : 'other',
      pools: [{ id: c.poolId, venue: 'uniswap_v4', poolId: c.poolId, ...(a?.key ? { hooks: a.key.hooks } : {}), quote: c.quote, feeBps,
        liquidityUsd: usd(Math.max(0, c.netHype), ctx), executable: false }] },
    // The probe runs at about $1,000: the $100 and $10k figures are not measured (named in meta.tradeability.missing).
    tradeability: { exitCostPct: { usd100: cost ?? 0, usd1k: cost ?? 0, usd10k: cost ?? 0 }, buyTaxPct: a?.taxPct?.buy ?? 0, sellTaxPct: a?.taxPct?.sell ?? 0,
      honeypot: verdict.playbooks.some(m => m.id === 'honeypot' && m.level === 'danger'),
      ...(a?.config ? { hookFeePct: a.config.totalFeePips / 1e4 } : {}), ...(a?.antiSnipe ? { antiSnipe: a.antiSnipe } : {}) },
    // Montra, HyperForge and tax-launchpad liquidity cannot be removed (docs and verified source); the Flaunch fork's hook
    // is unverified, so its status is named missing below rather than claimed.
    liquidity: { depthUsd: { pct2: 0, pct5: 0, pct10: 0 }, lpStatus: c.launchpad === 'flaunch' ? 'removable' : 'locked', feeTiers: a?.config ? [feeBps] : [] },
    supply: { top10Pct: a ? pct(a.stats.holders.top10Share) : 0, devPct: a ? pct(a.stats.dev.heldShare) : 0, bundlesHeldPct: a ? pct(earlyHeld(a)) : 0,
      exemptWalletsHeldPct: 0, freshWalletsPct: 0, burnedPct: 0, circulating: c.supply.toString() },
    // Montra launches are clones of the factory's token master: no owner, tax, blacklist, pause, mint or upgrade. Other
    // launchpads' tokens are not reviewed: their owner powers are named unavailable in meta.control.
    control: { canChangeTax: false, canBlacklist: false, canPause: false, canMint: false, upgradeable: false },
    flow: { ...emptyFlow },
    playbooks: verdict.playbooks, verdict,
    meta: {
      tradeability: { confidence: cost === null ? 0 : 1, asOfBlock: block, ...(cost === null ? { unavailable: true, missing: ['exitCostPct'] } : { missing: ['exitCostPct.usd100', 'exitCostPct.usd10k'] }),
        flags: [`probe_usd_${Math.round(a?.probeUsd ?? 1000)}`] },
      liquidity: { confidence: a?.config ? 1 : 0, asOfBlock: block, missing: c.launchpad === 'flaunch' ? ['depthUsd', 'lpStatus'] : ['depthUsd'] },
      // bundlesHeldPct here is what the first minute's buyers still hold (funding is not traced, so no same-funder bundles).
      supply: a ? { confidence: 1, asOfBlock: block, missing: ['freshWalletsPct', 'exemptWalletsHeldPct'], flags: ['early_cohort_not_funder_bundles'] } : meta(['top10Pct', 'devPct', 'bundlesHeldPct', 'freshWalletsPct']),
      control: c.launchpad === 'montra' ? { confidence: 1, asOfBlock: block, flags: ['montra_factory_clone'] } : meta(['canChangeTax', 'canBlacklist', 'canPause', 'canMint', 'upgradeable']),
      flow: meta(['agentPct', 'crewPct', 'humanPct', 'washEstPct']),
    },
    freshness: { block, ageSec: Math.max(0, ctx.nowSec - Math.floor(Date.parse(a?.at ?? new Date(ctx.nowSec * 1000).toISOString()) / 1000)) },
  };
}

export function feedItem(e: FeedEvent, a: Assessment | undefined, c?: CoinState): FeedItem {
  return { id: e.id, ts: e.ts * 1000, block: e.block, kind: e.kind, coin: e.coin, symbol: toUntrusted(a?.symbol ?? c?.symbol ?? '', UNTRUSTED_LIMITS.symbol),
    ...(a ? { level: a.verdict.level === 'pending' ? undefined : a.verdict.level === 'clear' ? 'info' : a.verdict.level } : {}),
    ...(e.side ? { side: e.side } : {}), ...(e.wallet ? { wallet: e.wallet } : {}) } as FeedItem;
}

export function publicConfig(trading?: { router: Address; permit2: Address; maxTradeUsd: number }, features: { accounts?: boolean; flags?: ReadonlySet<string> } = {}): PublicConfig {
  // With accounts open, Mission Control's approvals are served; other features are on when EKO_FLAGS names them (flags.ts).
  const on = new Set<string>([...(features.accounts ? ['approvals'] : []), ...(features.flags ?? [])]);
  return {
    phase: 'launch_week', flags: Object.fromEntries(FlagNameSchema.options.map(f => [f, on.has(f)])) as PublicConfig['flags'],
    tiers: (['listener', 'reader', 'oracle', 'source'] as const).map(tier => ({ tier, minBalance: null, feeBps: 0,
      limits: { agents: 1, deepResearchPerDay: 0, loopBacktestsPerDay: 0, realtime: true }, perks: [] })),
    // Wallet trading through Uniswap's Universal Router when enabled (no fee); no receipts contract, burn or dev wallet.
    trading: trading ? { liveEnabled: true, maxTradeUsd: trading.maxTradeUsd, routers: [trading.router], spenders: [trading.permit2], permit2: trading.permit2 }
      : { liveEnabled: false, maxTradeUsd: 0, routers: [], spenders: [] },
    contracts: { receiptsRegistry: zeroAddress }, wallets: { burn: zeroAddress, dev: zeroAddress },
    burnBoard: { heroPctSupply: 0, heroUsd24h: 0 }, drops: [], loops: { maxBars: 10000, syncMaxBars: 2000 }, exampleScans: [] as Address[],
  };
}
