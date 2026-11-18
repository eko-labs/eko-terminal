import { CoinCardSchema, RadarRowSchema, type Bar, type CoinCard, type PlaybookMatch, type RadarRow, type Untrusted } from '@eko/shared';
import { createCoinCard } from '../fixtures';
import { MOCK_HEAD_BLOCK } from '../head';

/**
 * Offline data for the "Every launchpad" update (flag more_launchpads): three long.xyz coins quoted in a stock token,
 * WETH and USDG, as the edge shows them with the flag on. Invented coins and random addresses (no real contract); prices
 * and findings are shaped like the live checks (an unreviewed hook, holder concentration, no sell check on a token
 * pool). Update films show this data, so no visible text may read as placeholder data. Shown only when VITE_FLAGS names
 * the flag, like the offline config (responses.ts createConfig).
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
const HOOK = '0x51df1428b2baee9ef567d72720438b1d37c49a9e';
const untrusted = (text: string): Untrusted => ({ text, flags: [], truncated: false });
const HOOK_LABEL = 'long.xyz (Doppler) hook (not reviewed; sets the fee and can change what a swap returns)';
const hookFinding = (): PlaybookMatch => ({ id: 'malicious_hook', level: 'monitor', confidence: 0.8,
  evidence: [{ kind: 'address', ref: HOOK, label: HOOK_LABEL }], history: { deployerRuns: 0 } });

interface DemoCoin {
  n: number; symbol: string; name: string; quote: { kind: 'ETH' | 'USDG' | 'stock_token'; symbol: string };
  priceUsd: number; mcapUsd: number; liquidityUsd: number; change1h: number; change24h: number; ageSec: number;
  verdict: 'monitor' | 'danger'; summary: string; findings: PlaybookMatch[];
  supply: { top10: number; bundles: number };
}
const COINS: DemoCoin[] = [
  { n: 1, symbol: 'HRBR', name: 'Harbor Lights', quote: { kind: 'stock_token', symbol: 'TTWO' }, priceUsd: 0.0000482, mcapUsd: 48_200, liquidityUsd: 6_100,
    change1h: 12.4, change24h: 12.4, ageSec: 360, verdict: 'monitor', summary: 'Quoted in a stock token; checked, priced in USD from the stock\'s pool.',
    findings: [hookFinding(), { id: 'holder_concentration', level: 'monitor', confidence: 0.9,
      evidence: [{ kind: 'stat', ref: 'holders:top10', label: 'Top 10 wallets hold 27% of supply' }], history: { deployerRuns: 0 } }],
    supply: { top10: 27, bundles: 8 } },
  { n: 2, symbol: 'KITE', name: 'Copper Kite', quote: { kind: 'ETH', symbol: 'WETH' }, priceUsd: 0.0000964, mcapUsd: 96_400, liquidityUsd: 41,
    change1h: -3.1, change24h: -3.1, ageSec: 180, verdict: 'danger', summary: 'Ten wallets hold most of the supply three minutes after launch.',
    findings: [{ id: 'holder_concentration', level: 'danger', confidence: 0.9,
      evidence: [{ kind: 'stat', ref: 'holders:top10', label: 'Top 10 wallets hold 62% of supply' },
        { kind: 'stat', ref: 'holders:largest', label: 'One wallet holds 21% of supply' }], history: { deployerRuns: 0 } }, hookFinding()],
    supply: { top10: 62, bundles: 2 } },
  { n: 3, symbol: 'QMNT', name: 'Quiet Mint', quote: { kind: 'USDG', symbol: 'USDG' }, priceUsd: 0.0000217, mcapUsd: 21_700, liquidityUsd: 4_850,
    change1h: 5.2, change24h: 5.2, ageSec: 50, verdict: 'monitor', summary: 'Quoted in USDG; checked, priced at $1 a USDG.',
    findings: [hookFinding()], supply: { top10: 18, bundles: 4 } },
];
/** `points` prices ending exactly at the coin's price: a seeded random walk around the 24 h move (deterministic). */
const series = (c: DemoCoin, points = 40) => {
  let seed = c.n * 9973 + points;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const start = c.priceUsd / (1 + c.change24h / 100);
  let wander = 0;
  return Array.from({ length: points }, (_, i) => {
    const t = i / (points - 1);
    wander = wander * 0.7 + (rnd() - 0.5) * 0.08;
    return i === points - 1 ? c.priceUsd : (start + (c.priceUsd - start) * t) * (1 + wander);
  });
};

const demo = COINS.map((c) => {
  const seed = createCoinCard(), address = COIN_ADDRESSES[c.n - 1]!, quote = QUOTE_ADDRESSES[c.n - 1]!, pool = POOL_IDS[c.n - 1]!, hash = RECEIPT_HASHES[c.n - 1]!;
  const name = untrusted(c.name), symbol = untrusted(c.symbol);
  const flow = { window: '1h', agentPct: 0, crewPct: 0, humanPct: 0, washEstPct: 0, beta: true, confidence: 0 };
  const verdict = { ...seed.verdict, coin: address, level: c.verdict, reasons: [c.summary, ...c.findings.map((m) => m.evidence[0]!.label)],
    playbooks: c.findings, asOfBlock: MOCK_HEAD_BLOCK, schemaVersion: 'verdict-1', receipt: { id: `rcpt_${hash.slice(2, 18)}`, hash, status: 'pending', block: MOCK_HEAD_BLOCK } };
  delete verdict.beta;
  const missing = (fields: string[]) => ({ confidence: 0, asOfBlock: MOCK_HEAD_BLOCK, unavailable: true, missing: fields });
  const card: CoinCard = CoinCardSchema.parse({ ...seed,
    identity: { address, name, symbol, deployer: address, createdAt: new Date(Date.parse('2026-11-18T12:00:00Z') - c.ageSec * 1000).toISOString(),
      launchpad: 'longxyz', stage: 'curve', quoteAsset: c.quote.kind, quoteSymbol: c.quote.symbol,
      pools: [{ id: pool, venue: 'uniswap_v4', poolId: pool, hooks: HOOK, quote, feeBps: 0, liquidityUsd: c.liquidityUsd, executable: false }] },
    clone: { isClone: false },
    // No sell check on a token-quoted pool (it spends ETH): exit cost is named missing, never claimed.
    tradeability: { exitCostPct: { usd100: 0, usd1k: 0, usd10k: 0 }, buyTaxPct: 0, sellTaxPct: 0, honeypot: false },
    liquidity: { depthUsd: { pct2: 0, pct5: 0, pct10: 0 }, lpStatus: 'removable', feeTiers: [] },
    supply: { top10Pct: c.supply.top10, devPct: 0, bundlesHeldPct: c.supply.bundles, exemptWalletsHeldPct: 0, freshWalletsPct: 0, burnedPct: 0,
      circulating: '1000000000' },
    control: { canChangeTax: false, canBlacklist: false, canPause: false, canMint: false, upgradeable: false },
    flow, playbooks: c.findings, verdict, freshness: { block: MOCK_HEAD_BLOCK, ageSec: 3 },
    meta: { tradeability: missing(['exitCostPct']), liquidity: { confidence: 0, asOfBlock: MOCK_HEAD_BLOCK, missing: ['depthUsd', 'lpStatus'] },
      supply: { confidence: 1, asOfBlock: MOCK_HEAD_BLOCK, missing: ['freshWalletsPct', 'exemptWalletsHeldPct'], flags: ['early_cohort_not_funder_bundles'] },
      control: missing(['canChangeTax', 'canBlacklist', 'canPause', 'canMint', 'upgradeable']),
      flow: { ...missing(['agentPct', 'crewPct', 'humanPct', 'washEstPct']), flags: ['wallet_labels_unavailable'] } },
  });
  const row: RadarRow = RadarRowSchema.parse({ address, name, symbol, launchpad: 'longxyz', quoteSymbol: c.quote.symbol, stage: 'curve',
    priceUsd: c.priceUsd, change1hPct: c.change1h, change24hPct: c.change24h, liquidityUsd: c.liquidityUsd, marketCapUsd: c.mcapUsd,
    verdict: c.verdict, topPlaybook: c.findings[0]!.id, ageSec: c.ageSec, rank: 30 + c.n, flow, exitCost1kPct: 0,
    unavailable: ['flow', 'signal', 'exitCost'], spark8h: series(c) });
  return { row, card, coin: c };
});

/** The offline data's long.xyz coins quoted in a token (empty unless the flag is on). */
export const quotedRows = (on = moreLaunchpadsOn()): RadarRow[] => on ? structuredClone(demo.map((d) => d.row)) : [];
export const quotedCard = (address: string, on = moreLaunchpadsOn()): CoinCard | undefined => {
  const card = on ? demo.find((d) => d.row.address.toLowerCase() === address.toLowerCase())?.card : undefined;
  return card && structuredClone(card);
};
/** Whether a trade quote for this coin gets the edge's answer for a pool it checks but does not trade. */
export const isQuotedDemoCoin = (address: string, on = moreLaunchpadsOn()) => on && demo.some((d) => d.row.address.toLowerCase() === address.toLowerCase());
/** 72 deterministic bars ending at the coin's price, for its chart. */
export function quotedCandles(address: string, step: number, end: number, on = moreLaunchpadsOn()): Bar[] {
  const d = on ? demo.find((x) => x.row.address.toLowerCase() === address.toLowerCase()) : undefined;
  if (!d) return [];
  const prices = series(d.coin, 73);
  return prices.slice(1).map((c, i) => {
    const o = prices[i]!, wiggle = d.coin.priceUsd * 0.015;
    return { ts: end - (71 - i) * step, o, c, h: Math.max(o, c) + wiggle, l: Math.max(0, Math.min(o, c) - wiggle), vUsd: 120 + ((i * 37) % 11) * 45 };
  });
}
