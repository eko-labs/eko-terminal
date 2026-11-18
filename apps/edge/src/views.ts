import { zeroAddress, type Address } from 'viem';
import { FlagNameSchema, findingsFirst, type CoinCard, type CoinSummary, type FeedItem, type Flow, type PairRow, type PublicConfig, type RadarRow, type Verdict } from '@eko/shared';
import { toUntrusted, UNTRUSTED_LIMITS } from '@eko/untrusted';
import type { Assessment } from './assess.js';
import { changePct, spark } from './market.js';
import { graduationBps, HALF_WAY_BPS } from './graduation.js';
import type { CoinState, FeedEvent } from './tracker.js';
import { flowActivity, WINDOW_SEC, type FlowWindow } from './flow-stats.js';
import { ELYSIUM_PROFILE } from './chains/profiles.js';
import type { ChainProfile } from './chains/types.js';

/**
 * Response builders: the shapes the EKO web app already validates (@eko/shared), filled from what the edge measures.
 * Anything not measured yet (wallet labels, holders, depth) is zero in the number field and named in `unavailable` /
 * `meta.*.missing`, never presented as an observation.
 */
/** hypeUsd is the chain's native coin in USD (HYPE on Elysium, ETH on Robinhood Chain), and every *Hype amount is in it. */
export interface ViewContext { nowSec: number; head: number; hypeUsd: number | null;
  /** Base of the graduation line for launchpads without one (Tracker.openMcapHype). */
  openMcapHype?: number;
  /** The native coin's symbol (default HYPE). */
  native?: 'HYPE' | 'ETH';
  /** Where About to graduate starts, in basis points of the way to graduation (the chain's; default half way). */
  nearGradBps?: number }

const NOT_YET = ['flow', 'signal'] as const;
const usd = (hype: number, ctx: ViewContext) => ctx.hypeUsd ? hype * ctx.hypeUsd : 0;
/** The pool's price after its last trade; before the first, a Montra pool's opening price (as Montra's own API shows it). */
const priceHype = (c: CoinState) => c.trades.at(-1)?.priceHype ?? (inNative(c) ? c.openPrice : undefined) ?? 0;
/** Its trades are in native currency: quoted in it, or in a token the chain converts (CoinState.quoteConverted). */
const inNative = (c: CoinState) => c.quote === zeroAddress || !!c.quoteConverted;
/** The quote token's ticker for a coin quoted in a token, only when it is plain letters, digits and dots. */
const quoteSymbol = (c: CoinState) => {
  const symbol = c.quote !== zeroAddress ? c.quoteConverted?.symbol : undefined;
  return symbol && /^[A-Za-z0-9.]{1,16}$/.test(symbol) ? { quoteSymbol: symbol } : {};
};
const supplyTokens = (c: CoinState) => Number(c.supply) / 1e18;
/** Price per whole token from the 18-decimal-unit price: a coin with 9 decimals has 10^9 more tokens per 1e18 base units. */
export const unitScale = (c: Pick<CoinState, 'decimals'>) => 10 ** ((c.decimals ?? 18) - 18);
const exitCost = (a: Assessment | undefined) => a?.probe?.exitCostPct ?? null;
/** A bonding-curve coin's way to graduation in % (the New pairs card's Curve bar, the radar's run-up hint). */
const curvePct = (c: CoinState, ctx: ViewContext) => { if (!c.curve || c.graduated) return {}; const bps = progressBps(c, ctx); return bps === null ? {} : { curvePct: bps / 100 }; };
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
  // No HYPE price, or a coin quoted in a token the chain does not convert (its trades are not counted: tracker.ts).
  if (!ctx.hypeUsd || !inNative(c)) unavailable.push('marketCap', 'volume');
  if (exitCost(a) === null) unavailable.push('exitCost');
  return {
    address: c.token, name: toUntrusted(a?.name ?? c.name ?? '', UNTRUSTED_LIMITS.name), symbol: toUntrusted(a?.symbol ?? c.symbol ?? '', UNTRUSTED_LIMITS.symbol),
    launchpad: c.launchpad, ...quoteSymbol(c), stage: c.graduated ? 'graduated' : 'curve', ...graduationPct(c, ctx), ...curvePct(c, ctx),
    priceUsd: usd(priceHype(c) * unitScale(c), ctx), ...(ctx.hypeUsd && priceHype(c) ? {} : { priceUnavailable: true }),
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
  return tradeStats(c, nowSec - WINDOW_SEC['1h']);
}

function tradeStats(c: CoinState, since: number) {
  let volumeHype = 0, trades = 0;
  for (const trade of c.trades) {
    if (trade.ts < since) continue;
    volumeHype += trade.hype;
    trades++;
  }
  return { volumeHype, trades };
}

const emptyFlow = { window: '1h' as const, agentPct: 0, crewPct: 0, humanPct: 0, washEstPct: 0, beta: true, confidence: 0 };
/** Wallet labels are not computed by the edge: the agent / crew / human split stays named missing. */
const LABEL_FIELDS = ['agentPct', 'crewPct', 'humanPct', 'washEstPct'];

/**
 * A window's flow: the measured buy / sell activity (flow-stats.ts) beside the label split, which stays zero and named
 * missing. With `detail` (the flow endpoint), the largest buyers and sellers and the latest trades come too.
 */
function flowOf(c: CoinState, ctx: ViewContext, window: FlowWindow = '1h', opts: { detail?: boolean; excluded?: readonly string[] } = {}) {
  const activity = inNative(c) ? flowActivity(c, window, ctx, opts) : null;
  return { ...emptyFlow, window, ...(activity ? { activity } : {}) };
}

/** GET /v1/coins/:address/flow?window=: one window's flow, with its largest wallets and latest trades. */
export function flowView(c: CoinState, ctx: ViewContext, window: FlowWindow, excluded: readonly string[] = []): Flow {
  const flow = flowOf(c, ctx, window, { detail: true, excluded });
  return { ...flow, meta: { confidence: flow.activity ? 1 : 0, asOfBlock: ctx.head, unavailable: true, missing: LABEL_FIELDS,
    flags: flow.activity ? ['activity_measured', 'wallet_labels_unavailable'] : ['wallet_labels_unavailable'] } };
}

export function radarRow(c: CoinState, a: Assessment | undefined, ctx: ViewContext, rank: number): RadarRow {
  const h = hourStats(c, ctx.nowSec);
  const dayStart = ctx.nowSec - WINDOW_SEC['24h'];
  const day = tradeStats(c, dayStart);
  return { ...coinSummary(c, a, ctx), rank, flow: flowOf(c, ctx), exitCost1kPct: exitCost(a) ?? 0, spark8h: spark(c.trades, ctx.nowSec).map(p => p * (ctx.hypeUsd ?? 0)),
    volume1hUsd: usd(h.volumeHype, ctx), trades1h: h.trades,
    volume24hUsd: usd(day.volumeHype, ctx), change24hPct: changePct(c.trades, dayStart), trades24h: day.trades };
}

export function pairRow(c: CoinState, a: Assessment | undefined, ctx: ViewContext): PairRow {
  const h = hourStats(c, ctx.nowSec);
  return { ...coinSummary(c, a, ctx), column: pairColumn(c, ctx), buyers: a?.stats.buyers ?? 0, exitCost100Pct: exitCost(a) ?? 0, flow: flowOf(c, ctx),
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
  return (progressBps(c, ctx) ?? 0) >= (ctx.nearGradBps ?? HALF_WAY_BPS) ? 'near_grad' : 'new';
}

/** Robinhood Chain coins launched straight into their own v4 pool (Pangea, long.xyz, the unbranded launcher). */
const robinhoodPoolLaunch = (c: CoinState) => c.launchpad === 'pangea' || c.launchpad === 'longxyz' || !!c.launchPosition;
/** A Pons coin's curve holds its reserves until graduation; after it, the lock is claimed only once the probe proved it. */
const unprovenPonsLock = (c: CoinState, a: Assessment | undefined) => c.launchpad === 'pons' && c.graduated && a?.lp !== 'locked';

export function coinCard(c: CoinState, a: Assessment | undefined, ctx: ViewContext): CoinCard {
  const verdict = a?.verdict ?? pendingVerdict(c, ctx.head);
  const feeBps = a?.config ? a.config.totalFeePips / 100 : 0;
  const cost = exitCost(a);
  const block = a?.block ?? ctx.head;
  const meta = (missing: string[], extra: object = {}) => ({ confidence: 0, asOfBlock: block, unavailable: true, missing, ...extra });
  return {
    identity: { address: c.token, name: toUntrusted(a?.name ?? c.name ?? '', UNTRUSTED_LIMITS.name), symbol: toUntrusted(a?.symbol ?? c.symbol ?? '', UNTRUSTED_LIMITS.symbol),
      deployer: c.creator, createdAt: new Date(c.ts * 1000).toISOString(), launchpad: c.launchpad, stage: c.graduated ? 'graduated' : 'curve',
      // A bonding-curve coin's way to graduation, in %, as the coin page's Venue row shows it ("curve 42.1%").
      ...(c.curve && !c.graduated ? (bps => bps === null ? {} : { curvePct: bps / 100 })(progressBps(c, ctx)) : {}),
      quoteAsset: c.quote === zeroAddress ? ctx.native ?? 'HYPE' : c.quoteConverted?.kind ?? 'other', ...quoteSymbol(c),
      // Before graduation a bonding-curve coin trades on its curve (no v4 pool yet).
      pools: [c.curve && !c.graduated ? { id: c.curve.address, venue: 'pons_curve', address: c.curve.address, quote: c.quote, feeBps, liquidityUsd: usd(Math.max(0, c.netHype), ctx), executable: false }
        : { id: c.poolId, venue: 'uniswap_v4', poolId: c.poolId, ...(a?.key ? { hooks: a.key.hooks } : {}), quote: c.quote, feeBps,
          liquidityUsd: usd(Math.max(0, c.netHype), ctx), executable: false }] },
    // The probe runs at about $1,000: the $100 and $10k figures are not measured (named in meta.tradeability.missing).
    tradeability: { exitCostPct: { usd100: cost ?? 0, usd1k: cost ?? 0, usd10k: cost ?? 0 }, buyTaxPct: a?.taxPct?.buy ?? 0, sellTaxPct: a?.taxPct?.sell ?? 0,
      honeypot: verdict.playbooks.some(m => m.id === 'honeypot' && m.level === 'danger'),
      ...(a?.config ? { hookFeePct: a.config.totalFeePips / 1e4 } : {}), ...(a?.antiSnipe ? { antiSnipe: a.antiSnipe } : {}) },
    // Montra, HyperForge and tax-launchpad liquidity cannot be removed (docs and verified source); the Flaunch fork's hook
    // is unverified, so its status is named missing below rather than claimed.
    // Pangea's and long.xyz's launch positions sit with their own unreviewed contracts: named missing, never claimed. The
    // unbranded launcher hands its position to the creator: removable, claimed once a check has said so.
    liquidity: { depthUsd: { pct2: 0, pct5: 0, pct10: 0 }, lpStatus: c.launchpad === 'flaunch' || robinhoodPoolLaunch(c) ? 'removable' : c.launchpad === 'pons' ? 'pons_locked' : 'locked', feeTiers: a?.config ? [feeBps] : [] },
    supply: { top10Pct: a ? pct(a.stats.holders.top10Share) : 0, devPct: a ? pct(a.stats.dev.heldShare) : 0, bundlesHeldPct: a ? pct(earlyHeld(a)) : 0,
      exemptWalletsHeldPct: 0, freshWalletsPct: 0, burnedPct: 0, circulating: (c.supply / 10n ** BigInt(c.decimals ?? 18)).toString() }, // whole tokens at the coin's own decimals, not base units
    // Montra launches are clones of the factory's token master: no owner, tax, blacklist, pause, mint or upgrade. Other
    // launchpads' tokens are not reviewed: their owner powers are named unavailable in meta.control.
    control: { canChangeTax: false, canBlacklist: false, canPause: false, canMint: false, upgradeable: false },
    flow: flowOf(c, ctx),
    playbooks: verdict.playbooks, verdict,
    meta: {
      tradeability: { confidence: cost === null ? 0 : 1, asOfBlock: block, ...(cost === null ? { unavailable: true, missing: ['exitCostPct'] } : { missing: ['exitCostPct.usd100', 'exitCostPct.usd10k'] }),
        flags: [`probe_usd_${Math.round(a?.probeUsd ?? 1000)}`] },
      liquidity: { confidence: a?.config ? 1 : 0, asOfBlock: block, missing: c.launchpad === 'flaunch' || (robinhoodPoolLaunch(c) && a?.lp !== 'removable') || unprovenPonsLock(c, a) ? ['depthUsd', 'lpStatus'] : ['depthUsd'] },
      // bundlesHeldPct here is what the first minute's buyers still hold (funding is not traced, so no same-funder bundles).
      supply: a ? { confidence: 1, asOfBlock: block, missing: ['freshWalletsPct', 'exemptWalletsHeldPct'], flags: ['early_cohort_not_funder_bundles'] } : meta(['top10Pct', 'devPct', 'bundlesHeldPct', 'freshWalletsPct']),
      control: c.launchpad === 'montra' ? { confidence: 1, asOfBlock: block, flags: ['montra_factory_clone'] } : meta(['canChangeTax', 'canBlacklist', 'canPause', 'canMint', 'upgradeable']),
      // The label split is not measured (unavailable); flow.activity, when present, is (flags).
      flow: meta(LABEL_FIELDS, { flags: inNative(c) && ctx.hypeUsd ? ['activity_measured', 'wallet_labels_unavailable'] : ['wallet_labels_unavailable'] }),
    },
    freshness: { block, ageSec: Math.max(0, ctx.nowSec - Math.floor(Date.parse(a?.at ?? new Date(ctx.nowSec * 1000).toISOString()) / 1000)) },
  };
}

export function feedItem(e: FeedEvent, a: Assessment | undefined, c?: CoinState): FeedItem {
  return { id: e.id, ts: e.ts * 1000, block: e.block, kind: e.kind, coin: e.coin, symbol: toUntrusted(a?.symbol ?? c?.symbol ?? '', UNTRUSTED_LIMITS.symbol),
    ...(a ? { level: a.verdict.level === 'pending' ? undefined : a.verdict.level === 'clear' ? 'info' : a.verdict.level } : {}),
    ...(e.side ? { side: e.side } : {}), ...(e.wallet ? { wallet: e.wallet } : {}) } as FeedItem;
}

/**
 * What the web reads at boot. `chain` is the deployment's (EKO_CHAIN). Trading lists the contracts the wallet may call
 * (routers) and approve (spenders) on this chain; a Pons curve is named per quote instead (its route's poolId), since
 * every coin has its own.
 */
export function publicConfig(trading?: { routers: readonly Address[]; spenders: readonly Address[]; permit2: Address; maxTradeUsd: number }, features: { accounts?: boolean; flags?: ReadonlySet<string> } = {},
  chain: ChainProfile = ELYSIUM_PROFILE): PublicConfig {
  // With accounts open, Mission Control's approvals are served; other features are on when EKO_FLAGS names them (flags.ts).
  const on = new Set<string>([...(features.accounts ? ['approvals'] : []), ...(features.flags ?? [])]);
  return {
    chain: { key: chain.key, id: chain.id, name: chain.name, native: chain.native, explorerUrl: chain.explorerUrl, publicRpcUrl: chain.publicRpc },
    phase: 'launch_week', flags: Object.fromEntries(FlagNameSchema.options.map(f => [f, on.has(f)])) as PublicConfig['flags'],
    tiers: (['listener', 'reader', 'oracle', 'source'] as const).map(tier => ({ tier, minBalance: null, feeBps: 0,
      limits: { agents: 1, deepResearchPerDay: 0, loopBacktestsPerDay: 0, realtime: true }, perks: [] })),
    // Wallet trading when enabled (no fee); no receipts contract, burn or dev wallet.
    trading: trading ? { liveEnabled: true, maxTradeUsd: trading.maxTradeUsd, routers: [...trading.routers], spenders: [...trading.spenders], permit2: trading.permit2 }
      : { liveEnabled: false, maxTradeUsd: 0, routers: [], spenders: [] },
    contracts: { receiptsRegistry: zeroAddress }, wallets: { burn: zeroAddress, dev: zeroAddress },
    burnBoard: { heroPctSupply: 0, heroUsd24h: 0 }, drops: [], loops: { maxBars: 10000, syncMaxBars: 2000 }, exampleScans: [] as Address[],
  };
}
