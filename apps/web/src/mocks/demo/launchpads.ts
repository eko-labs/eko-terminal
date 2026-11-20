import { CoinCardSchema, findingsFirst, FlowSchema, RadarRowSchema, type Bar, type CoinCard, type EvidenceRef, type Flow, type FlowActivity, type FlowTrade, type PlaybookId, type PlaybookMatch, type RadarRow, type Untrusted } from '@eko/shared';
import { createCoinCard } from '../fixtures';
import { MOCK_HEAD_BLOCK } from '../head';
import { hashedAddress, hashedTx } from './addresses';

/**
 * Offline data for the "Every launchpad" update (flag more_launchpads): three long.xyz coins quoted in a stock token,
 * WETH and USDG, shaped field by field like the edge's own card for such a coin (apps/edge/src/views.ts with the
 * Robinhood adapter, checked against real TTWO-, USDG- and WETH-quoted launches):
 * - measured: price, market cap, volume, liquidity paid into the pool, buy and sell flow per window with the largest
 *   wallets and latest trades, holders (top 10, dev, early buyers), and the findings those run (holders, snipers);
 * - the sell check: a round trip of about $1,000 in the pool's own quote (V4TokenProbe), so exit cost at $1K is
 *   measured, as live on stock-token and USDG pools (3.0-4.0%). Where EKO has no balance reading for the quote yet
 *   (WETH, live), it is named not available (tradeability flag sell_check_not_available) and the verdict is graded
 *   from the checks that did run;
 * - the hook: Doppler's, counted reviewed when the pool's fee module is one of the three with verified source; a pool
 *   on the fourth keeps the "unreviewed hook" Monitor (malicious_hook), as live;
 * - not run, named missing exactly as the edge does: exit cost at $100 and $10K, depth, LP status, owner powers, fresh
 *   and exempt wallets, and who the wallets are (labels). EKO checks these coins but does not trade them.
 * Invented coins and random addresses (no real contract). Update films show this data, so no visible text may read as
 * placeholder data. Shown only when VITE_FLAGS names the flag, like the offline config (responses.ts createConfig).
 */
export const moreLaunchpadsOn = (preset: string | undefined = import.meta.env.VITE_FLAGS) =>
  (preset ?? '').split(',').map((v: string) => v.trim()).includes('more_launchpads');

/** Random hex (crypto.randomBytes, once): coins, their quote tokens, pool ids and receipt hashes. No real contract. */
const COIN_ADDRESSES = ['0x411756d1c31f5daf13ae81f0244f9e06588d374c', '0xc40c3cd9766765a3bec7b0b65f05bf05c731b484', '0xbe56588104c75375db561084e786a64feea662e2'] as const;
const QUOTE_ADDRESSES = ['0xa9a00fb482c574806e0abd7c23b4966318743db8', '0x4344bb4f127ff68b6e633772fcd8f722cb940b86', '0xf7660b1ac8fc3d044ef6920015698ed13e5f5d0a'] as const;
const POOL_IDS = ['0x129ad2562cd0525e9f791fc0450ab10e10f9ee0f08d2766605239cb6d813eb23', '0x9dc720c582359e66e1a5f81b263aa88811f60a26f6b671c90907be814d7664d3',
  '0x561c7cf8ab082178f0908e801ed1da62200fb41d02d19f788b3cfb42509f0389'] as const;
const RECEIPT_HASHES = ['0xdadbebc389b20aa57ef926ae28b984376bd16e69cc00926b6ce843e5869d1597', '0x058e7a29767f3d35c117a5b1be82d3debccc465cff5671956ff4b607c9d73c11',
  '0x67422b296459d662e171052df55923cafdfa5bb144834455b6761a91ab2ec9b3'] as const;
/** A v4 hook's address carries its permissions: the low 14 bits here are long.xyz's hook's (0x2544, return delta 4). */
const HOOK = '0x51df1428b2baee9ef567d72720438b1d37c4e544';
const HOOK_BITS = 0x2544, HOOK_DELTA_BITS = 4;
/** Playbooks the edge lists as evaluated when no sell check ran (assess.ts judge). */
const WITHOUT_SELL_CHECK: PlaybookId[] = ['agent_bait', 'malicious_hook', 'fee_trap_pool', 'removable_liquidity'];
const NOW_SEC = Math.floor(Date.now() / 1000);
const untrusted = (text: string): Untrusted => ({ text, flags: [], truncated: false });

interface DemoCoin {
  n: number; symbol: string; name: string; quote: { kind: 'ETH' | 'USDG' | 'stock_token'; symbol: string };
  priceUsd: number; mcapUsd: number; liquidityUsd: number; change1h: number; ageSec: number;
  /** Trades since launch, the share of them that are buys, and how many wallets traded. */
  trades: number; buyShare: number; wallets: number;
  /** Supply shares (0..1): top 10 holders, the largest non-deployer holder, the deployer, what the first minute's buyers still hold. */
  holders: { top10: number; largest: number; dev: number; early: number };
  /** Wallets that bought in the launch second, what they bought and what they still hold (launch_snipers). */
  snipers?: { wallets: number; bought: number; held: number };
  /** Whether the pool's fee module is one EKO reviewed (no hook finding), and the sell check's round trip (null: not available). */
  hookReviewed: boolean; roundTripPct: number | null;
  /** The quote token in dollars, for Exit check's amounts. */
  quoteUsd: number;
}
const COINS: DemoCoin[] = [
  { n: 1, symbol: 'HRBR', name: 'Harbor Lights', quote: { kind: 'stock_token', symbol: 'TTWO' }, priceUsd: 0.0000482, mcapUsd: 48_200, liquidityUsd: 6_100,
    change1h: 12.4, ageSec: 360, trades: 64, buyShare: 0.62, wallets: 31, holders: { top10: 0.27, largest: 0.064, dev: 0, early: 0.081 },
    snipers: { wallets: 3, bought: 0.142, held: 0.116 }, hookReviewed: true, roundTripPct: 2.99, quoteUsd: 214.6 },
  { n: 2, symbol: 'COPR', name: 'Copper Kite', quote: { kind: 'ETH', symbol: 'WETH' }, priceUsd: 0.0000964, mcapUsd: 96_400, liquidityUsd: 7_900,
    change1h: -3.1, ageSec: 180, trades: 27, buyShare: 0.7, wallets: 12, holders: { top10: 0.62, largest: 0.21, dev: 0.018, early: 0.024 }, hookReviewed: true, roundTripPct: null, quoteUsd: 3150 },
  { n: 3, symbol: 'QMNT', name: 'Quiet Mint', quote: { kind: 'USDG', symbol: 'USDG' }, priceUsd: 0.0000217, mcapUsd: 21_700, liquidityUsd: 4_850,
    change1h: 5.2, ageSec: 50, trades: 13, buyShare: 0.7, wallets: 9, holders: { top10: 0.18, largest: 0.052, dev: 0, early: 0.043 }, hookReviewed: false, roundTripPct: 3.98, quoteUsd: 1 },
];

const seeded = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
/** `points` prices ending exactly at the coin's price: a seeded random walk from its opening price (deterministic). */
const series = (c: DemoCoin, points = 40) => {
  const rnd = seeded(c.n * 9973 + points);
  const start = c.priceUsd / (1 + c.change1h / 100);
  let wander = 0;
  return Array.from({ length: points }, (_, i) => {
    const t = i / (points - 1);
    wander = wander * 0.7 + (rnd() - 0.5) * 0.08;
    return i === points - 1 ? c.priceUsd : (start + (c.priceUsd - start) * t) * (1 + wander);
  });
};

/** Every trade since launch, oldest first: ages, sizes and wallets seeded, sizes scaled so the net paid in is the pool's liquidity. */
interface Trade { ts: number; side: 'buy' | 'sell'; usd: number; tokens: number; tx: string; wallet?: string }
function tradesOf(c: DemoCoin): Trade[] {
  const rnd = seeded(c.n * 7919 + 17), prices = series(c, c.trades), launch = NOW_SEC - c.ageSec;
  const wallets = Array.from({ length: c.wallets }, (_, i) => hashedAddress(`lx:${c.symbol}:w${i}`));
  const snipers = c.snipers?.wallets ?? 0;
  const raw = prices.map((price, i) => {
    // The launch second's buyers first (the snipers), then trades spread over the coin's life.
    const sniping = i < snipers, ts = sniping ? launch : Math.min(NOW_SEC - 2, launch + Math.round(c.ageSec * (i + rnd() * 0.8) / c.trades));
    const side: Trade['side'] = sniping || i < snipers + 2 || rnd() < c.buyShare ? 'buy' : 'sell';
    const size = sniping ? 30 + rnd() * 25 : Math.exp(rnd() * 3.4);
    const wallet = sniping ? wallets[i] : rnd() < 0.12 ? undefined : wallets[snipers + Math.floor(rnd() * (wallets.length - snipers))];
    return { ts, side, usd: size, price, tx: hashedTx(`lx:${c.symbol}:t${i}`), ...(wallet ? { wallet } : {}) };
  });
  const bought = raw.filter(t => t.side === 'buy').reduce((n, t) => n + t.usd, 0), sold = raw.filter(t => t.side === 'sell').reduce((n, t) => n + t.usd, 0);
  // Every size in dollars at one scale, so the net paid in (buys less sells) is the pool's liquidity.
  const k = c.liquidityUsd / (bought - sold);
  return raw.map(({ price, ...t }) => { const usd = t.usd * k; return { ...t, usd, tokens: usd / price }; });
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const WINDOW_SEC = { '5m': 300, '1h': 3600, '24h': 86400 } as const;
type Window = keyof typeof WINDOW_SEC;
/** A window's buy and sell activity as the edge measures it (flow-stats.ts); with `detail`, the largest wallets and latest trades. */
function activityOf(trades: Trade[], window: Window, detail = false): FlowActivity {
  const inWindow = trades.filter(t => t.ts >= NOW_SEC - WINDOW_SEC[window]);
  const buys = inWindow.filter(t => t.side === 'buy'), sells = inWindow.filter(t => t.side === 'sell');
  const sum = (ts: Trade[]) => ts.reduce((n, t) => n + t.usd, 0), who = (ts: Trade[]) => new Set(ts.flatMap(t => t.wallet ? [t.wallet] : [])).size;
  const activity: FlowActivity = { buyUsd: round2(sum(buys)), sellUsd: round2(sum(sells)), netUsd: round2(sum(buys) - sum(sells)), buys: buys.length, sells: sells.length,
    buyers: who(buys), sellers: who(sells), unattributed: inWindow.filter(t => !t.wallet).length };
  if (!detail) return activity;
  const totals = new Map<string, { wallet: string; side: Trade['side']; usd: number; trades: number; lastTs: number }>();
  for (const t of inWindow) {
    if (!t.wallet) continue;
    const key = `${t.side}:${t.wallet}`, e = totals.get(key) ?? { wallet: t.wallet, side: t.side, usd: 0, trades: 0, lastTs: t.ts };
    e.usd += t.usd; e.trades++; e.lastTs = Math.max(e.lastTs, t.ts);
    totals.set(key, e);
  }
  const top = (side: Trade['side']) => [...totals.values()].filter(w => w.side === side).sort((a, b) => b.usd - a.usd).slice(0, 5).map(w => ({ ...w, usd: round2(w.usd) }));
  const recent: FlowTrade[] = inWindow.slice(-50).reverse().map(t => ({ ts: t.ts, side: t.side, usd: round2(t.usd), tokens: t.tokens, tx: t.tx, ...(t.wallet ? { wallet: t.wallet as `0x${string}` } : {}) }));
  return { ...activity, largest: [...top('buy'), ...top('sell')], recent } as FlowActivity;
}

/** Findings as the playbooks write them (packages/playbooks rules.ts), with the reasons verdict.ts gives them. */
function findingsOf(c: DemoCoin, address: string, trades: Trade[]) {
  const stat = (id: PlaybookId, key: string, label: string, value: number | string): EvidenceRef => ({ kind: 'stat', ref: `${address}:${id}:${key}`, block: MOCK_HEAD_BLOCK, label, value });
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
  const found: { match: PlaybookMatch; reason: string }[] = [];
  // In the playbooks' own order (rules.ts): malicious_hook, holder_concentration, launch_snipers.
  if (!c.hookReviewed) found.push({ match: { id: 'malicious_hook', level: 'monitor', confidence: 1, history: { deployerRuns: 0 }, evidence: [
    { kind: 'address', ref: HOOK, label: 'v4 hook' }, stat('malicious_hook', 'bits', 'Hook permission bits', HOOK_BITS),
    stat('malicious_hook', 'deltaBits', 'Return-delta permission bits', HOOK_DELTA_BITS), stat('malicious_hook', 'gap', 'Quote versus simulation gap (%)', 'unavailable'),
    stat('malicious_hook', 'asymmetry', 'Sell minus buy fee (pp)', 'unavailable'),
    { kind: 'address', ref: HOOK, label: 'long.xyz (Doppler) hook (its fee module is not reviewed; sets the fee and can change what a swap returns)' }] },
  reason: 'This coin trades in a pool whose hook may change what a swap pays or receives; EKO has not reviewed the hook.' });
  const h = c.holders;
  const top10 = h.top10 >= 0.5 ? 'danger' : h.top10 >= 0.2 || h.largest >= 0.1 ? 'monitor' : null;
  if (top10) {
    const largest = hashedAddress(`lx:${c.symbol}:holder`);
    found.push({ match: { id: 'holder_concentration', level: top10, confidence: 1, history: { deployerRuns: 0 }, evidence: [
      stat('holder_concentration', 'top10', 'Top 10 holders supply share', h.top10), stat('holder_concentration', 'largest', 'Largest non-deployer holder supply share', h.largest),
      stat('holder_concentration', 'transferred', 'Supply held by top holders that never bought', 0), stat('holder_concentration', 'transferredWallets', 'Top holders that never bought', 0),
      { kind: 'address', ref: largest, label: 'Largest non-deployer holder' }] },
    reason: `The top 10 holders own ${pct(h.top10)} of supply${h.largest >= 0.1 ? `; one wallet other than the deployer owns ${pct(h.largest)}` : ''}.` });
  }
  const s = c.snipers;
  if (s && s.held >= 0.1) {
    const first = trades.slice(0, s.wallets);
    found.push({ match: { id: 'launch_snipers', level: s.held >= 0.25 ? 'danger' : 'monitor', confidence: 1, history: { deployerRuns: 0 }, evidence: [
      stat('launch_snipers', 'wallets', 'Launch snipers', s.wallets), stat('launch_snipers', 'bought', 'Snipers bought supply share', s.bought),
      stat('launch_snipers', 'held', 'Snipers still hold supply share', s.held),
      ...first.flatMap((t): EvidenceRef[] => [{ kind: 'address', ref: t.wallet!, label: 'Launch sniper' }, { kind: 'tx', ref: t.tx, block: MOCK_HEAD_BLOCK - c.ageSec * 10, label: 'Sniper buy' }])] },
    reason: `${s.wallets} wallets bought ${pct(s.bought)} of supply within a second of launch; they still hold ${pct(s.held)}.` });
  }
  return findingsFirst(found.map(f => ({ ...f, level: f.match.level })));
}

const demo = COINS.map((c) => {
  const seed = createCoinCard(), address = COIN_ADDRESSES[c.n - 1]!, quote = QUOTE_ADDRESSES[c.n - 1]!, pool = POOL_IDS[c.n - 1]!, hash = RECEIPT_HASHES[c.n - 1]!;
  const name = untrusted(c.name), symbol = untrusted(c.symbol), trades = tradesOf(c), findings = findingsOf(c, address, trades);
  const playbooks = findings.map(f => f.match), checkedAt = new Date((NOW_SEC - 4) * 1000).toISOString();
  // Graded from the checks that ran (assess.ts judge): Danger wins, then Monitor; with nothing found, Clear once the sell
  // check ran, pending while it could not.
  const sold = c.roundTripPct !== null;
  const level = playbooks.some(m => m.level === 'danger') ? 'danger' as const : playbooks.length ? 'monitor' as const : sold ? 'clear' as const : 'pending' as const;
  const flow = { window: '1h' as const, agentPct: 0, crewPct: 0, humanPct: 0, washEstPct: 0, beta: true, confidence: 0, activity: activityOf(trades, '1h') };
  const verdict = { ...seed.verdict, coin: address, level, reasons: findings.map(f => f.reason), playbooks, asOfBlock: MOCK_HEAD_BLOCK, schemaVersion: 'verdict-1',
    receipt: { id: `rcpt_${hash.slice(2, 18)}`, hash, status: 'pending', block: MOCK_HEAD_BLOCK }, lastChecked: { block: MOCK_HEAD_BLOCK, at: checkedAt },
    ...(sold ? {} : { evaluatedPlaybooks: WITHOUT_SELL_CHECK }) };
  delete verdict.beta;
  if (sold) delete (verdict as { evaluatedPlaybooks?: unknown }).evaluatedPlaybooks;
  const missing = (fields: string[], extra: object = {}) => ({ confidence: 0, asOfBlock: MOCK_HEAD_BLOCK, unavailable: true, missing: fields, ...extra });
  const pct = (share: number) => Math.round(share * 10_000) / 100;
  const card: CoinCard = CoinCardSchema.parse({ ...seed,
    identity: { address, name, symbol, deployer: hashedAddress(`lx:${c.symbol}:deployer`), createdAt: new Date((NOW_SEC - c.ageSec) * 1000).toISOString(),
      launchpad: 'longxyz', stage: 'curve', quoteAsset: c.quote.kind, quoteSymbol: c.quote.symbol,
      pools: [{ id: pool, venue: 'uniswap_v4', poolId: pool, hooks: HOOK, quote, feeBps: 0, liquidityUsd: c.liquidityUsd, executable: false }] },
    clone: { isClone: false },
    // The sell check's round trip at about $1,000 (the $100 and $10K sizes are not run); without it, named missing.
    tradeability: { exitCostPct: sold ? { usd100: c.roundTripPct!, usd1k: c.roundTripPct!, usd10k: c.roundTripPct! } : { usd100: 0, usd1k: 0, usd10k: 0 }, buyTaxPct: 0, sellTaxPct: 0, honeypot: false },
    // The launch position sits with long.xyz's unreviewed contracts: depth and LP status named missing; the dynamic fee has no tier.
    liquidity: { depthUsd: { pct2: 0, pct5: 0, pct10: 0 }, lpStatus: 'removable', feeTiers: [] },
    supply: { top10Pct: pct(c.holders.top10), devPct: pct(c.holders.dev), bundlesHeldPct: pct(c.holders.early), exemptWalletsHeldPct: 0, freshWalletsPct: 0, burnedPct: 0,
      circulating: '1000000000' },
    control: { canChangeTax: false, canBlacklist: false, canPause: false, canMint: false, upgradeable: false },
    flow, playbooks, verdict, freshness: { block: MOCK_HEAD_BLOCK, ageSec: 4 },
    meta: { tradeability: sold ? { confidence: 1, asOfBlock: MOCK_HEAD_BLOCK, missing: ['exitCostPct.usd100', 'exitCostPct.usd10k'], flags: ['probe_usd_1000'] }
      : missing(['exitCostPct'], { flags: ['probe_usd_1000', 'sell_check_not_available'] }), liquidity: { confidence: 0, asOfBlock: MOCK_HEAD_BLOCK, missing: ['depthUsd', 'lpStatus'] },
      supply: { confidence: 1, asOfBlock: MOCK_HEAD_BLOCK, missing: ['freshWalletsPct', 'exemptWalletsHeldPct'], flags: ['early_cohort_not_funder_bundles'] },
      control: missing(['canChangeTax', 'canBlacklist', 'canPause', 'canMint', 'upgradeable']),
      flow: missing(['agentPct', 'crewPct', 'humanPct', 'washEstPct'], { flags: ['activity_measured', 'wallet_labels_unavailable'] }) },
  });
  const volume = trades.reduce((n, t) => n + t.usd, 0);
  const row: RadarRow = RadarRowSchema.parse({ address, name, symbol, launchpad: 'longxyz', quoteSymbol: c.quote.symbol, stage: 'curve',
    priceUsd: c.priceUsd, change1hPct: c.change1h, change24hPct: c.change1h, liquidityUsd: c.liquidityUsd, marketCapUsd: c.mcapUsd,
    verdict: level, verdictPending: level === 'pending', lastChecked: verdict.lastChecked, ratingAgeSec: 4, ...(playbooks[0] ? { topPlaybook: playbooks[0].id } : {}), ageSec: c.ageSec, rank: 30 + c.n,
    flow, exitCost1kPct: c.roundTripPct ?? 0, unavailable: sold ? ['flow', 'signal'] : ['flow', 'signal', 'exitCost'], spark8h: series(c),
    ...(sold ? { sellCheck: { status: 'sellable', asOfBlock: MOCK_HEAD_BLOCK, checkedAt } } : {}),
    volume1hUsd: volume, trades1h: trades.length, volume24hUsd: volume, trades24h: trades.length });
  // New pairs adds what the holder check measured (views.ts pairRow).
  const pair = { buyers: new Set(trades.flatMap(t => t.side === 'buy' && t.wallet ? [t.wallet] : [])).size, verdictPending: false,
    top10Pct: pct(c.holders.top10), devPct: pct(c.holders.dev), earlyHeldPct: pct(c.holders.early) };
  return { row, card, coin: c, trades, pair };
});
const find = (address: string, on: boolean) => on ? demo.find((d) => d.row.address.toLowerCase() === address.toLowerCase()) : undefined;

/** The offline data's long.xyz coins quoted in a token (empty unless the flag is on). */
export const quotedRows = (on = moreLaunchpadsOn()): RadarRow[] => on ? structuredClone(demo.map((d) => d.row)) : [];
export const quotedCard = (address: string, on = moreLaunchpadsOn()): CoinCard | undefined => {
  const card = find(address, on)?.card;
  return card && structuredClone(card);
};
/** New pairs' own fields for one of these coins (createPairRows), or undefined for any other coin. */
export const quotedPairFields = (address: string, on = moreLaunchpadsOn()) => { const d = find(address, on); return d && { ...d.pair }; };
/** GET /coins/:address/flow?window= for one of these coins, as the edge's flowView serves it (labels unavailable, activity measured). */
export function quotedFlow(address: string, window: Window, on = moreLaunchpadsOn()): Flow | undefined {
  const d = find(address, on);
  if (!d) return undefined;
  return FlowSchema.parse({ ...d.card.flow, window, activity: activityOf(d.trades, window, true),
    meta: { confidence: 1, asOfBlock: MOCK_HEAD_BLOCK, unavailable: true, missing: ['agentPct', 'crewPct', 'humanPct', 'washEstPct'], flags: ['activity_measured', 'wallet_labels_unavailable'] } });
}
/** Whether a trade quote for this coin gets the edge's answer for a pool it checks but does not trade. */
export const isQuotedDemoCoin = (address: string, on = moreLaunchpadsOn()) => !!find(address, on);
/** What Exit check needs of one of these coins: whether its hook is reviewed, and its quote (symbol, kind, dollars per unit). */
export function quotedExitFacts(address: string, on = moreLaunchpadsOn()) {
  const d = find(address, on);
  return d && { hookReviewed: d.coin.hookReviewed, quote: { symbol: d.coin.quote.symbol, kind: d.coin.quote.kind === 'ETH' ? 'ETH' as const : d.coin.quote.kind, usd: d.coin.quoteUsd } };
}
/** 72 deterministic bars ending at the coin's price, for its chart. */
export function quotedCandles(address: string, step: number, end: number, on = moreLaunchpadsOn()): Bar[] {
  const d = find(address, on);
  if (!d) return [];
  const prices = series(d.coin, 73);
  return prices.slice(1).map((c, i) => {
    const o = prices[i]!, wiggle = d.coin.priceUsd * 0.015;
    return { ts: end - (71 - i) * step, o, c, h: Math.max(o, c) + wiggle, l: Math.max(0, Math.min(o, c) - wiggle), vUsd: 120 + ((i * 37) % 11) * 45 };
  });
}
