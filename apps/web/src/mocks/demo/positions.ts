import { CHAIN_KEY } from '../../lib/chain';
import { coinCandles } from './coin';
import { coinLedger, type LedgerRole } from './ledger';
import { createRadarCard, createRadarRows } from './radar';

/**
 * Offline positions for a coin with a chart: the coin's ledger (ledger.ts: who bought it, when, what they sold, what they
 * were sent and what they hold now) booked in dollars at the coin's own chart prices, supply and sell tax. Pages that read wallets' positions in
 * mock mode build their example replies from this one book, so they agree with each other and with the coin page
 * (price, supply, the deployer's and bundles' shares in the Supply panel). Generated addresses, deterministic per coin.
 *
 * Costs follow the edge (apps/edge/src/positions.ts): average cost over a wallet's buys; tokens it was sent have no
 * known cost; a sell or a send takes out bought and sent tokens in proportion.
 */
export type DemoRole = 'dev' | 'sniper' | 'bundle';
export interface DemoPosition {
  wallet: string; roles: DemoRole[];
  /** USD paid in buys and got back in sells (after the coin's sell tax). */
  spentUsd: number; receivedUsd: number;
  buys: number; sells: number;
  /** Seconds after launch of its first buy; null when it never bought. */
  firstBuySec: number | null;
  /** Whole tokens. */
  bought: number; sold: number; transferredIn: number; transferredOut: number; balance: number;
  /** The bought tokens it still holds, and what they cost (USD). */
  costed: number; costUsd: number;
  /** Sells beyond the average cost of the bought tokens they sold (USD). */
  realizedUsd: number;
  /** Average buy price over its buys, and average cost of the bought tokens it holds (USD per token). */
  entryUsd: number | null; costBasisUsd: number | null;
}
export interface DemoBook {
  coin: string; priceUsd: number; nativeUsd: number; supply: number; launchTs: number;
  wallets: DemoPosition[];
}

/** The native coin's USD price in the demo (ETH on Robinhood Chain, HYPE on Elysium), as the other demos use it. */
export const DEMO_NATIVE_USD = CHAIN_KEY === 'robinhood' ? 3150 : 38;
type Event = { sec: number; kind: 'buy' | 'sell' | 'in' | 'out'; tokens: number };

/** One wallet's events, in time order, booked the edge's way. */
function book(wallet: string, roles: DemoRole[], events: Event[], priceAt: (sec: number) => number, sellTax: number): DemoPosition {
  const p: DemoPosition = { wallet, roles, spentUsd: 0, receivedUsd: 0, buys: 0, sells: 0, firstBuySec: null, bought: 0, sold: 0, transferredIn: 0, transferredOut: 0,
    balance: 0, costed: 0, costUsd: 0, realizedUsd: 0, entryUsd: null, costBasisUsd: null };
  let uncosted = 0;
  const takeOut = (n: number) => {
    const known = p.costed + uncosted, part = known > 0 ? Math.min(p.costed, n * p.costed / known) : 0;
    const cost = p.costed > 0 ? p.costUsd * part / p.costed : 0;
    p.costed -= part; p.costUsd -= cost; uncosted = Math.max(0, uncosted - (n - part));
    return { part, cost };
  };
  for (const e of [...events].sort((a, b) => a.sec - b.sec)) {
    if (e.kind === 'buy') {
      const usd = e.tokens * priceAt(e.sec);
      p.spentUsd += usd; p.bought += e.tokens; p.buys++; p.costed += e.tokens; p.costUsd += usd; p.balance += e.tokens; p.firstBuySec ??= e.sec;
    } else if (e.kind === 'in') {
      p.transferredIn += e.tokens; uncosted += e.tokens; p.balance += e.tokens;
    } else if (e.kind === 'sell') {
      const usd = e.tokens * priceAt(e.sec) * (1 - sellTax), { part, cost } = takeOut(e.tokens);
      p.receivedUsd += usd; p.sold += e.tokens; p.sells++; p.balance -= e.tokens; p.realizedUsd += usd * part / e.tokens - cost;
    } else {
      takeOut(e.tokens); p.transferredOut += e.tokens; p.balance -= e.tokens;
    }
  }
  // Sold or sent out in full: no float dust left behind.
  if (p.balance < p.bought * 1e-9 + p.transferredIn * 1e-9) { p.balance = 0; p.costed = 0; p.costUsd = 0; }
  p.entryUsd = p.bought > 0 ? p.spentUsd / p.bought : null;
  p.costBasisUsd = p.costed > 0 ? p.costUsd / p.costed : null;
  return p;
}

const memo = new Map<string, DemoBook>();

/** The coin's price after launch (USD per token), its supply and sell tax: the chart's 5-minute closes, and before the chart a climb from the opening price. */
export function demoMarket(address: string) {
  const ledger = coinLedger(address), row = createRadarRows().find(r => r.address.toLowerCase() === address.toLowerCase()), card = createRadarCard(address);
  const bars = coinCandles(address, '5m');
  if (!ledger || !row || !card || !bars.length || !row.priceUsd || !row.marketCapUsd) return undefined;
  const priceUsd = row.priceUsd, supply = row.marketCapUsd / priceUsd, chartStart = bars[0]!.ts, launchTs = ledger.launchTs;
  const openUsd = launchTs < chartStart ? Math.min(bars[0]!.o * 0.6, Math.max(6_000, Math.min(60_000, row.marketCapUsd / 30)) / supply) : bars[Math.min(bars.length - 1, Math.floor((launchTs - chartStart) / 300))]!.o;
  const priceAt = (sec: number) => {
    const ts = launchTs + sec;
    if (ts < chartStart) { const f = Math.max(0, sec) / Math.max(1, chartStart - launchTs); return openUsd * (bars[0]!.o / openUsd) ** (f ** 0.7); }
    const bar = bars[Math.min(bars.length - 1, Math.floor((ts - chartStart) / 300))]!, f = ((ts - chartStart) % 300) / 300;
    return bar.o + (bar.c - bar.o) * f;
  };
  return { ledger, priceUsd, supply, launchTs, priceAt, sellTax: (card.tradeability.sellTaxPct ?? 0) / 100 };
}

/** The positions' roles: the edge's top traders mark the deployer, launch snipers and bundle wallets. */
const rolesOf = (roles: readonly LedgerRole[]): DemoRole[] => (['dev', 'bundle', 'sniper'] as const).filter(r => roles.includes(r) || (r === 'sniper' && roles.includes('linked')));

export function demoPositions(address: string): DemoBook | undefined {
  const key = address.toLowerCase(), hit = memo.get(key);
  if (hit) return hit;
  const m = demoMarket(address);
  if (!m) return undefined;
  const tokens = (pct: number) => m.supply * pct / 100;
  const wallets = m.ledger.wallets.map(w => book(w.wallet, rolesOf(w.roles), w.events.map(e => ({ sec: e.sec, kind: e.kind, tokens: tokens(e.pct) })), m.priceAt, m.sellTax));
  const value: DemoBook = { coin: m.ledger.coin, priceUsd: m.priceUsd, nativeUsd: DEMO_NATIVE_USD, supply: m.supply, launchTs: m.launchTs, wallets };
  memo.set(key, value);
  return value;
}

/** A position's profit at the coin's price now (USD): realized, plus what its bought tokens are worth less their cost. */
export const demoProfit = (p: DemoPosition, priceUsd: number) => p.realizedUsd + p.costed * priceUsd - p.costUsd;
