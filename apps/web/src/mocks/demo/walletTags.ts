import { MOCK_HEAD_BLOCK } from '../head';
import { bucketStart } from '../../components/chart/coinMath';
import { COIN_EPOCH, coinMarkers, fixtureWallet } from './coin';
import { hashedAddress, hashedTx } from './addresses';
import { CHAIN_KEY } from '../../lib/chain';
import { createRadarCard } from './radar';

/**
 * Offline wallet tags for a coin with a chart profile (the /v2/coins/:address/tags reply, flag wallet_tags), in the shape
 * the edge serves, for the chain this build serves: the deployer, launch snipers, two bundles (one block; one funder), top holders and fresh wallets, with
 * reasons as if funding history were traced. Tagged wallets include the coin's own demo trades, so the Flow and Trades
 * tabs show the same tags. Example values and generated addresses only; deterministic per coin.
 */
type Tag = 'dev' | 'bundle' | 'sniper' | 'top10' | 'fresh';
const ORDER: Tag[] = ['dev', 'bundle', 'sniper', 'top10', 'fresh'];
interface Trade { i: number; k: number; side: 'buy' | 'sell'; usd: number }

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** Per chain: blocks in a 5-minute candle (Robinhood about four a second, Elysium about ten), the launch-sniper
 *  window (ChainProfile.sniperBlocks), the snipers' blocks after launch, and the native coin's USD price. */
const CHAIN = CHAIN_KEY === 'robinhood'
  ? { blocksPerCandle: 1200, sniperBlocks: 35, snipedAt: [1, 2, 6, 19], late: 4, nativeUsd: 3150 }
  : { blocksPerCandle: 3060, sniperBlocks: 10, snipedAt: [1, 2, 4, 7], late: 3, nativeUsd: 38 };
const BLOCKS_PER_CANDLE = CHAIN.blocksPerCandle;
const after = (blocks: number) => `Bought ${blocks} ${blocks === 1 ? 'block' : 'blocks'} after launch (first ${CHAIN.sniperBlocks} blocks)`;

export function demoWalletTags(address: string, from = COIN_EPOCH - 72 * 300, to = COIN_EPOCH) {
  const card = createRadarCard(address);
  if (!card) return undefined;
  // On the demo chart's own 5-minute candles (coinCandles: 72, the last one holding `to`), a few seconds in.
  const slot = (to - from) / 72, first = bucketStart(to, '5m') - 71 * 300, launchBlock = MOCK_HEAD_BLOCK - 72 * BLOCKS_PER_CANDLE;
  const at = (i: number, k: number) => Math.min(to, first + i * 300 + 20 + k);
  const candleOf = (ts: number) => Math.min(71, Math.max(0, Math.floor((ts - from) / slot)));
  const blockAt = (i: number, k: number) => launchBlock + i * BLOCKS_PER_CANDLE + k;
  const gen = (label: string) => hashedAddress(`${address.toLowerCase()}:${label}`);

  const wallets = new Map<string, { wallet: string; tags: Tag[]; why: Partial<Record<Tag, string>> }>();
  const trades = new Map<string, Trade[]>();
  const tag = (w: string, t: Tag, why: string) => {
    const e = wallets.get(w) ?? { wallet: w, tags: [], why: {} };
    if (!e.tags.includes(t)) { e.tags.push(t); e.why[t] = why; }
    wallets.set(w, e);
  };
  const trade = (w: string, t: Trade) => trades.set(w, [...(trades.get(w) ?? []), t]);

  // The deployer: buys at launch, sells twice later.
  const dev = card.identity.deployer;
  tag(dev, 'dev', 'Deployed this coin');
  trade(dev, { i: 0, k: 0, side: 'buy', usd: 2400 }); trade(dev, { i: 38, k: 4, side: 'sell', usd: 910 }); trade(dev, { i: 61, k: 9, side: 'sell', usd: 1750 });

  // Launch snipers: four wallets in the first blocks; two sell into later candles.
  const snipers = [1, 2, 3, 4].map(n => gen(`sniper${n}`));
  snipers.forEach((w, n) => {
    tag(w, 'sniper', after(CHAIN.snipedAt[n]!));
    trade(w, { i: 0, k: 1 + n, side: 'buy', usd: [1820, 960, 640, 410][n]! });
  });
  trade(snipers[0]!, { i: 9, k: 3, side: 'sell', usd: 2210 }); trade(snipers[1]!, { i: 24, k: 7, side: 'sell', usd: 1180 });

  // Bundle one: three wallets one transaction bought for (the second block after launch).
  const sameBlock = [1, 2, 3].map(n => gen(`block${n}`));
  sameBlock.forEach((w, n) => {
    tag(w, 'bundle', 'Bought in one transaction with 2 other wallets (a bundle of 3)');
    tag(w, 'sniper', after(2));
    trade(w, { i: 0, k: 5 + n, side: 'buy', usd: [1290, 1310, 1275][n]! });
  });
  trade(sameBlock[0]!, { i: 17, k: 2, side: 'sell', usd: 1460 }); trade(sameBlock[2]!, { i: 33, k: 6, side: 'sell', usd: 1390 });

  // Bundle two: three early buyers paid by one fresh funder hours before launch.
  const funder = gen('funder'), funded = [1, 2, 3].map(n => gen(`funded${n}`));
  funded.forEach((w, n) => {
    tag(w, 'bundle', `Funded by ${short(funder)} with 3 other early buyers`);
    tag(w, 'fresh', `First funded ${[3, 2.8, 3.1][n]} h before its first buy`);
    trade(w, { i: 1, k: 2 + n, side: 'buy', usd: [720, 690, 705][n]! });
  });
  trade(funded[1]!, { i: 46, k: 3, side: 'sell', usd: 980 });

  // The coin's own demo trades: the largest buyers hold the most; the latest ones are freshly funded; one was paid by
  // the deployer. The twelve fixture wallets stay untagged.
  const fixtures = new Set(Array.from({ length: 12 }, (_, i) => fixtureWallet(i)));
  const own = coinMarkers(address, from, to).filter(m => !fixtures.has(m.wallet));
  const ownTrade = new Map<string, (typeof own)[number]>(own.map(m => [m.wallet, m]));
  const byLate = [...own].sort((a, b) => b.ts - a.ts), byBuy = own.filter(m => m.side === 'buy').sort((a, b) => b.sizeUsd - a.sizeUsd);
  // Two of the coin's own late sellers bought at launch: one sniped, one is the funded bundle's fourth wallet, so the
  // Trades tab shows those tags too.
  const lateSellers = byLate.slice(0, 20).filter(m => m.side === 'sell');
  if (lateSellers[0]) { tag(lateSellers[0].wallet, 'sniper', after(CHAIN.late)); trade(lateSellers[0].wallet, { i: 0, k: 11, side: 'buy', usd: 530 }); }
  if (lateSellers[1]) {
    tag(lateSellers[1].wallet, 'bundle', `Funded by ${short(funder)} with 3 other early buyers`);
    trade(lateSellers[1].wallet, { i: 1, k: 6, side: 'buy', usd: 715 });
  }
  const holders = [byBuy[0]?.wallet, snipers[0], byBuy[1]?.wallet, dev, sameBlock[1], byBuy[2]?.wallet, funded[0], byBuy[3]?.wallet, byLate[2]?.wallet, byBuy[4]?.wallet]
    .filter((w, n, all): w is string => !!w && all.indexOf(w) === n);
  const shares = [8.4, 6.1, 4.9, 4.2, 3.6, 3.1, 2.7, 2.2, 1.9, 1.6];
  holders.slice(0, 10).forEach((w, n) => tag(w, 'top10', `Holder #${n + 1} · ${shares[n]}% of supply`));
  // Fresh: the two latest buyers, and every fifth trade across the chart (funded minutes to hours before buying).
  const byTs = [...own].sort((a, b) => a.ts - b.ts), minutes = [40, 12, 95, 4, 26, 150, 8, 61, 19, 230, 33, 7];
  [byLate[0], byLate[3], ...byTs.filter((_, n) => n % 5 === 2)].forEach((m, n) => {
    const min = minutes[n % minutes.length]!;
    if (m) tag(m.wallet, 'fresh', `First funded ${min < 60 ? `${min} min` : `${Math.round(min / 6) / 10} h`} before its first buy`);
  });
  if (byLate[1]) tag(byLate[1].wallet, 'dev', 'First funded by the deployer');

  for (const e of wallets.values()) e.tags.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const markers = [...wallets.values()].flatMap(e => {
    const mine = trades.get(e.wallet)?.map(t => ({ ts: at(t.i, t.k), block: blockAt(t.i, t.k), side: t.side, usd: t.usd })) ?? [];
    const m = ownTrade.get(e.wallet);
    if (m) { const i = candleOf(m.ts); mine.push({ ts: at(i, 40), block: blockAt(i, 160), side: m.side, usd: m.sizeUsd }); }
    return mine.map(t => ({ ...t, native: Math.round(t.usd / CHAIN.nativeUsd * 1e4) / 1e4, wallet: e.wallet, tags: e.tags, tx: hashedTx(`${e.wallet}:${t.ts}:${t.side}`) }));
  }).filter(m => m.ts >= from && m.ts <= to).sort((a, b) => a.ts - b.ts || a.block - b.block);
  const list = [...wallets.values()].sort((a, b) => ORDER.indexOf(a.tags[0]!) - ORDER.indexOf(b.tags[0]!) || a.wallet.localeCompare(b.wallet));
  return { version: 2 as const, coin: card.identity.address, asOfBlock: MOCK_HEAD_BLOCK, wallets: list, markers, truncated: false, unavailable: [] as string[] };
}
