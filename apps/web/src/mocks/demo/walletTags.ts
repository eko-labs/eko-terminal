import { MOCK_HEAD_BLOCK } from '../head';
import { bucketStart } from '../../components/chart/coinMath';
import { COIN_EPOCH, coinMarkers, fixtureWallet } from './coin';
import { hashedTx } from './addresses';
import { blockAfter, LAUNCH_WINDOW } from './ledger';
import { DEMO_NATIVE_USD, demoMarket } from './positions';

/**
 * Offline wallet tags for a coin with a chart profile (the /v2/coins/:address/tags reply), in the shape and words the
 * edge serves, from the coin's ledger (ledger.ts): the
 * deployer and the wallet it paid, launch snipers, its bundles (one transaction or one block, and the wallets they passed
 * tokens to), three snipers one fresh wallet paid, the top 10 holders, and fresh wallets among the coin's own chart
 * trades. Markers are those wallets' buys and sells at the ledger's times and the chart's prices; a coin older than the
 * chart has its whole life drawn across the chart. Generated addresses only; deterministic per coin.
 */
type Tag = 'dev' | 'bundle' | 'sniper' | 'top10' | 'fresh';
const ORDER: Tag[] = ['dev', 'bundle', 'sniper', 'top10', 'fresh'];

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sniped = (blocks: number) => `Bought ${blocks === 0 ? 'in the launch block' : `${blocks} ${blocks === 1 ? 'block' : 'blocks'} after launch`} (first ${LAUNCH_WINDOW.sniperBlocks} blocks)`;
const others = (n: number, one: string, many: string) => `${n} other ${n === 1 ? one : many}`;
const sharePct = (v: number) => `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}%`;

export function demoWalletTags(address: string, from = COIN_EPOCH - 72 * 300, to = COIN_EPOCH) {
  const m = demoMarket(address);
  if (!m) return undefined;
  const { ledger } = m;
  // Ledger seconds on the chart: real times, or the coin's whole life across the chart's 72 candles when it is older.
  const first = bucketStart(to, '5m') - 71 * 300, span = to - first;
  const tsOf = (sec: number) => ledger.launchTs >= first ? ledger.launchTs + sec : Math.round(first + 20 + sec * (span - 40) / ledger.ageSec);
  const blockOf = (sec: number) => MOCK_HEAD_BLOCK - blockAfter(ledger.ageSec - sec);

  const wallets = new Map<string, { wallet: string; tags: Tag[]; why: Partial<Record<Tag, string>> }>();
  const tag = (w: string, t: Tag, why: string) => {
    const e = wallets.get(w) ?? { wallet: w, tags: [], why: {} };
    if (!e.tags.includes(t)) { e.tags.push(t); e.why[t] = why; }
    wallets.set(w, e);
  };

  tag(ledger.deployer, 'dev', 'Deployed this coin');
  for (const w of ledger.wallets) if (w.roles.includes('linked')) tag(w.wallet, 'dev', 'First funded by the deployer');
  for (const w of ledger.wallets) if ((w.roles.includes('sniper') || w.roles.includes('linked')) && w.firstBuySec !== null) tag(w.wallet, 'sniper', sniped(blockAfter(w.firstBuySec)));
  ledger.top10.forEach((t, i) => tag(t.wallet, 'top10', `Holder #${i + 1} · ${sharePct(t.pct)} of supply`));
  for (const g of ledger.groups) {
    if (g.kind !== 'bundle') continue;
    const size = g.wallets.length;
    g.wallets.forEach((w, i) => tag(w.wallet, 'bundle', w.via === 'rotation' ? `Received tokens a bundle bought at launch (a bundle of ${size})`
      : g.oneTx && i < g.oneTx.wallets ? `Bought in one transaction with ${others(g.oneTx.wallets - 1, 'wallet', 'wallets')} (a bundle of ${size})`
        : `Bought at launch in a bundle with ${others(size - 1, 'wallet', 'wallets')}`));
  }
  const { funder, wallets: funded, hoursBefore } = ledger.funded;
  funded.forEach((w, i) => {
    tag(w, 'bundle', `Funded by ${short(funder)} with ${others(funded.length - 1, 'early buyer', 'early buyers')}`);
    tag(w, 'fresh', `First funded ${hoursBefore[i]} h before its first buy`);
  });

  // The coin's own chart trades: the latest buyers and every fifth trade were funded minutes to hours before buying.
  // The twelve fixture wallets stay untagged.
  const fixtures = new Set(Array.from({ length: 12 }, (_, i) => fixtureWallet(i)));
  const chart = coinMarkers(address, from, to).filter(x => !fixtures.has(x.wallet));
  const byLate = [...chart].sort((a, b) => b.ts - a.ts), byTs = [...chart].sort((a, b) => a.ts - b.ts), minutes = [40, 12, 95, 4, 26, 150, 8, 61, 19, 230, 33, 7];
  [byLate[0], byLate[1], byLate[3], ...byTs.filter((_, n) => n % 5 === 2)].forEach((x, n) => {
    const min = minutes[n % minutes.length]!;
    if (x) tag(x.wallet, 'fresh', `First funded ${min < 60 ? `${min} min` : `${Math.round(min / 6) / 10} h`} before its first buy`);
  });
  // The edge looks up the funding of a coin's first buyers: among the ledger's later buyers, one in four was fresh.
  ledger.wallets.filter(w => w.kind === 'later' && w.firstBuySec !== null).sort((a, b) => a.firstBuySec! - b.firstBuySec!).slice(0, 80).forEach((w, n) => {
    const min = minutes[(n + 5) % minutes.length]!;
    if (n % 4 === 1) tag(w.wallet, 'fresh', `First funded ${min < 60 ? `${min} min` : `${Math.round(min / 6) / 10} h`} before its first buy`);
  });

  for (const e of wallets.values()) e.tags.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const byWallet = new Map(ledger.wallets.map(w => [w.wallet, w]));
  const chartTrade = new Map<string, (typeof chart)[number]>(chart.map(x => [x.wallet, x]));
  const markers = [...wallets.values()].flatMap(e => {
    const w = byWallet.get(e.wallet);
    const mine = (w?.events ?? []).filter(x => x.kind !== 'in').map(x => {
      const usd = Math.round(x.pct / 100 * m.supply * m.priceAt(x.sec) * 100) / 100;
      return { ts: tsOf(x.sec), block: blockOf(x.sec), side: x.kind as 'buy' | 'sell', usd };
    });
    const c = chartTrade.get(e.wallet);
    if (c) mine.push({ ts: c.ts, block: MOCK_HEAD_BLOCK - Math.round((to - c.ts) / LAUNCH_WINDOW.blockTimeSec), side: c.side, usd: c.sizeUsd });
    return mine.map(t => ({ ...t, native: Math.round(t.usd / DEMO_NATIVE_USD * 1e4) / 1e4, wallet: e.wallet, tags: e.tags, tx: hashedTx(`${e.wallet}:${t.ts}:${t.block}:${t.side}`) }));
  }).filter(x => x.ts >= from && x.ts <= to).sort((a, b) => a.ts - b.ts || a.block - b.block);
  const list = [...wallets.values()].sort((a, b) => ORDER.indexOf(a.tags[0]!) - ORDER.indexOf(b.tags[0]!) || a.wallet.localeCompare(b.wallet));
  return { version: 2 as const, coin: ledger.coin, asOfBlock: MOCK_HEAD_BLOCK, wallets: list, markers, truncated: false, unavailable: [] as string[] };
}
