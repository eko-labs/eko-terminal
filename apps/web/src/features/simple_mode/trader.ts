import type { Bar, CoinCard, Flow, FlowTrade, RadarRow, Verdict } from '@eko/shared';
import { canSell, hundredBack, SELL_WORDS, type AnswerKind, type Tone } from './model';

/**
 * Simple's coin page in the dense layout memecoin traders know (a stats strip, the chart, a flow box, holder stats and
 * a trades table), with EKO's answer on top. Everything here is pure: what each strip and box shows, from the coin card,
 * the radar row, the flows and the candles EKO already serves. A figure EKO did not measure is left out, never shown as
 * "not checked".
 */

/** The supporting line under the answer: what to do about it, in a few words. It never repeats the answer's word. */
export const STEER: Record<AnswerKind, string> = {
  ok: 'No warning signs EKO can see. Still, only put in what you can lose.',
  careful: 'Read the reasons before you buy, and keep it small.',
  dont: 'EKO thinks this one is a trap. Find a safer coin.',
  checking: 'EKO is still checking it. Wait a minute before you buy.',
};

/**
 * One compact number for the whole page, three significant figures with trailing zeros dropped: 1B, 420M, 1.23K, 840.
 * A value that rounds up to the next unit moves to it (999,999,999 is 1B, never 1000M).
 */
export function compact(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v), sign = v < 0 ? '−' : '';
  if (a < 1000) return `${sign}${a >= 100 ? Math.round(a) : Number(a.toPrecision(3))}`;
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const;
  for (let i = units.length - 1; i >= 0; i--) {
    const [unit, suffix] = units[i]!;
    const next = units[i - 1];
    if (next && a >= next[0]) continue;
    const n = Number((a / unit).toPrecision(3));
    if (n >= 1000 && next) return `${sign}${Number((a / next[0]).toPrecision(3))}${next[1]}`;
    return `${sign}${n}${suffix}`;
  }
  return `${sign}${a}`;
}
/** Dollars on the same scale: $20.8K, $1.9M, $840, and under a dollar "<$1". */
export const usdShort = (v: number): string => (v > 0 && v < 1 ? '<$1' : v < 0 ? `−${usdShort(-v)}` : v < 10 ? `$${v.toFixed(2)}` : v < 1000 ? `$${Math.round(v)}` : `$${compact(v)}`);
/** A count on the same scale: 436, 12.3K, 1B. */
export const countShort = (v: number) => (Math.abs(v) < 1000 ? Math.round(v).toLocaleString('en-US') : compact(v));
/** "+12.4%" / "−3.1%" with a real minus. */
export const signedPct = (v: number) => `${v >= 0.05 ? '+' : v <= -0.05 ? '−' : ''}${Math.abs(v) >= 100 ? Math.round(Math.abs(v)).toLocaleString('en-US') : Math.abs(v).toFixed(1)}%`;
/** A trade's age: 12s, 4m, 3h, 2d. */
export function ageShort(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

/** The coin's total supply in tokens: from the market cap and price when both are measured, else the circulating count. */
export function totalSupply(card: CoinCard | null | undefined, row: RadarRow | null | undefined): number | null {
  if (row && !row.unavailable?.includes('marketCap') && row.marketCapUsd && row.priceUsd > 0 && !row.priceUnavailable) return row.marketCapUsd / row.priceUsd;
  const c = Number(card?.supply.circulating);
  return Number.isFinite(c) && c > 0 ? c : null;
}

export interface Stat { id: string; label: string; value: string; tone?: Tone }
/**
 * The header strip's label-over-value stats: Price, Liq, 24h Vol, Supply, B. Curve (on its curve), Tax (buy / sell).
 * The market cap is drawn big on its own (`marketCap`).
 */
export function headerStats(card: CoinCard | null | undefined, row: RadarRow | null | undefined, flows: readonly Flow[], price: number | undefined, formatPrice: (v: number) => string): { marketCap: string | null; stats: Stat[] } {
  const stats: Stat[] = [];
  if (price !== undefined) stats.push({ id: 'price', label: 'Price', value: formatPrice(price) });
  if (row && !row.unavailable?.includes('liquidity')) stats.push({ id: 'liq', label: 'Liq', value: usdShort(row.liquidityUsd) });
  const day = flows.find(f => f.window === '24h')?.activity;
  const vol = row?.volume24hUsd !== undefined && !row.unavailable?.includes('volume') ? row.volume24hUsd : day ? day.buyUsd + day.sellUsd : undefined;
  if (vol !== undefined) stats.push({ id: 'vol', label: '24h Vol', value: usdShort(vol) });
  const supply = totalSupply(card, row);
  if (supply !== null) stats.push({ id: 'supply', label: 'Supply', value: countShort(supply) });
  const curve = (card?.identity.stage ?? row?.stage) === 'curve' ? card?.identity.curvePct ?? row?.curvePct : undefined;
  if (curve !== undefined) stats.push({ id: 'curve', label: 'B. Curve', value: `${curve >= 99.995 ? 100 : curve.toFixed(2)}%`, tone: curve >= 80 ? 'good' : 'neutral' });
  const t = card?.tradeability, taxMissing = card?.meta?.tradeability?.missing?.some(m => m === 'buyTaxPct' || m === 'sellTaxPct' || m === 'taxes');
  if (t && !card?.meta?.tradeability?.unavailable && !taxMissing) {
    const tax = (v: number) => `${Math.round(v * 10) / 10}%`;
    stats.push({ id: 'tax', label: 'Tax', value: `${tax(t.buyTaxPct)} / ${tax(t.sellTaxPct)}`, tone: Math.max(t.buyTaxPct, t.sellTaxPct) >= 10 ? 'bad' : Math.max(t.buyTaxPct, t.sellTaxPct) > 3 ? 'watch' : 'neutral' });
  }
  // The radar row's market cap, else the live price times the supply (a coin off the radar's first page has no row).
  const cap = row && !row.unavailable?.includes('marketCap') && row.marketCapUsd !== undefined ? row.marketCapUsd
    : price !== undefined && supply !== null ? price * supply : null;
  return { marketCap: cap === null ? null : usdShort(cap), stats };
}

/** The price move over the last `sec` seconds from candles: the newest close against the last close at or before then. */
export function changeFromBars(bars: readonly Bar[], sec: number): number | undefined {
  const last = bars.at(-1);
  if (!last || bars.length < 2) return undefined;
  const since = last.ts - sec;
  let before: Bar | undefined;
  for (let i = bars.length - 2; i >= 0; i--) if (bars[i]!.ts <= since) { before = bars[i]; break; }
  if (!before) return undefined;
  // The candles must reach back far enough: a gap of more than twice the span is not "the last 5 minutes".
  if (since - before.ts > sec * 2) return undefined;
  return before.c > 0 ? (last.c / before.c - 1) * 100 : undefined;
}
/** The change chips: 5m (from the candles), 1h and 24h (from the radar row). */
export function changeChips(row: RadarRow | null | undefined, bars: readonly Bar[]): { label: string; pct: number }[] {
  const out: { label: string; pct: number }[] = [];
  const five = changeFromBars(bars, 300);
  if (five !== undefined) out.push({ label: '5m', pct: five });
  if (row && !row.unavailable?.includes('change')) {
    out.push({ label: '1h', pct: row.change1hPct });
    if (row.change24hPct !== undefined) out.push({ label: '24h', pct: row.change24hPct });
  }
  return out;
}

/** A plain fact in EKO's strip: a short label, a value, a tone and a gauge where one reads at a glance. */
export interface Glance { id: string; label: string; value: string; tone: Tone; gauge?: number }
const ownTone = (pct: number, watch: number, bad: number): Tone => (pct >= bad ? 'bad' : pct >= watch ? 'watch' : 'good');
/** Whether a supply share was measured (not named missing, its section available, the coin followed from launch). */
function supplyMeasured(card: CoinCard, field: string): boolean {
  const m = card.meta?.supply;
  return !m?.unavailable && !m?.missing?.includes(field) && !(field !== 'devPct' && m?.flags?.includes('history_partial'));
}
/** The snipers finding, when the checks looked for it: a match is "Found", a clean look is "None". */
function snipers(verdict: Verdict | null | undefined): Glance | null {
  if (!verdict) return null;
  const match = verdict.playbooks.find(p => p.id === 'launch_snipers' && (p.level === 'danger' || p.level === 'monitor'));
  if (match) return { id: 'snipers', label: 'Snipers', value: 'Found', tone: match.level === 'danger' ? 'bad' : 'watch' };
  return verdict.evaluatedPlaybooks?.includes('launch_snipers') ? { id: 'snipers', label: 'Snipers', value: 'None', tone: 'good' } : null;
}
/**
 * EKO's strip facts: can you sell, $100 gets back, dev holds, top 10, snipers, bundles. `holdersFlagged`: a reason says a
 * few wallets hold a lot, so the Top 10 never reads as good news beside it.
 */
export function stripFacts(card: CoinCard | null | undefined, verdict: Verdict | null | undefined, holdersFlagged = false): Glance[] {
  const out: Glance[] = [];
  const sell = canSell(card);
  if (sell !== 'unknown') out.push({ id: 'sell', label: 'Can you sell?', value: SELL_WORDS[sell], tone: sell === 'yes' ? 'good' : sell === 'maybe' ? 'watch' : 'bad' });
  const back = hundredBack(card);
  if (back !== null) out.push({ id: 'back', label: '$100 gets back', value: `$${back}`, tone: back >= 90 ? 'good' : back >= 70 ? 'watch' : 'bad', gauge: back });
  if (card) {
    const s = card.supply;
    if (supplyMeasured(card, 'devPct')) out.push({ id: 'dev', label: 'Dev holds', value: `${round1(s.devPct)}%`, tone: ownTone(s.devPct, 5, 15), gauge: s.devPct });
    if (supplyMeasured(card, 'top10Pct')) out.push({ id: 'top10', label: 'Top 10', value: `${round1(s.top10Pct)}%`, tone: topTone(s.top10Pct, holdersFlagged), gauge: s.top10Pct });
  }
  const sn = snipers(verdict);
  if (sn) out.push(sn);
  if (card && supplyMeasured(card, 'bundlesHeldPct')) out.push({ id: 'bundles', label: 'Bundles', value: `${round1(card.supply.bundlesHeldPct)}%`, tone: ownTone(card.supply.bundlesHeldPct, 5, 15), gauge: card.supply.bundlesHeldPct });
  // When holder shares were not counted (EKO joined late), the owner's powers and the pool's lock still read at a glance.
  if (card && !card.meta?.control?.unavailable && card.control) {
    const c = card.control, hard = c.canMint || c.canPause || c.canBlacklist, any = hard || c.canChangeTax || c.upgradeable;
    out.push({ id: 'powers', label: 'Owner powers', value: !any ? 'None' : c.canMint ? 'Can mint' : c.canPause ? 'Can pause' : c.canBlacklist ? 'Can block' : c.canChangeTax ? 'Can tax' : 'Upgradeable', tone: hard ? 'bad' : any ? 'watch' : 'good' });
  }
  const lp = card?.liquidity?.lpStatus;
  if (lp && !card?.meta?.liquidity?.unavailable) out.push({ id: 'lp', label: 'Pool money', value: lp === 'removable' ? 'Can be pulled' : 'Locked', tone: lp === 'removable' ? 'bad' : 'good' });
  return out.slice(0, 6);
}
const topTone = (pct: number, flagged: boolean): Tone => { const t = ownTone(pct, 25, 50); return flagged && t === 'good' ? 'watch' : t; };
const round1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en-US');

/**
 * The holder stats grid under the trade panel: each share EKO measures, with a good or bad mark. Top 10, Dev, Bundlers,
 * Fresh wallets, Insiders (wallets that pay no tax) and Burned; snipers when the checks looked.
 */
export function holderStats(card: CoinCard | null | undefined, verdict: Verdict | null | undefined, holdersFlagged = false): Glance[] {
  if (!card) return [];
  const s = card.supply, out: Glance[] = [];
  const add = (id: string, label: string, field: keyof CoinCard['supply'] & string, tone: Tone) => {
    if (supplyMeasured(card, field)) out.push({ id, label, value: `${round1(s[field] as number)}%`, tone });
  };
  add('top10', 'Top 10', 'top10Pct', topTone(s.top10Pct, holdersFlagged));
  add('dev', 'Dev', 'devPct', ownTone(s.devPct, 5, 15));
  add('bundles', 'Bundlers', 'bundlesHeldPct', ownTone(s.bundlesHeldPct, 5, 15));
  add('fresh', 'Fresh wallets', 'freshWalletsPct', ownTone(s.freshWalletsPct, 10, 25));
  add('insiders', 'Insiders', 'exemptWalletsHeldPct', ownTone(s.exemptWalletsHeldPct, 3, 10));
  if (supplyMeasured(card, 'burnedPct') && s.burnedPct > 0) out.push({ id: 'burned', label: 'Burned', value: `${round1(s.burnedPct)}%`, tone: 'good' });
  const sn = snipers(verdict);
  if (sn) out.push(sn);
  return out;
}

export interface FlowBox { vol: number; buys: number; buyUsd: number; sells: number; sellUsd: number; net: number; buyers: number; sellers: number }
/** One window of the flow box, or null when that window's trading was not measured. */
export function flowBox(flows: readonly Flow[], window: Flow['window']): FlowBox | null {
  const a = flows.find(f => f.window === window)?.activity;
  if (!a) return null;
  return { vol: a.buyUsd + a.sellUsd, buys: a.buys, buyUsd: a.buyUsd, sells: a.sells, sellUsd: a.sellUsd, net: a.netUsd, buyers: a.buyers, sellers: a.sellers };
}

export interface TradeRow { key: string; ts: number; side: 'buy' | 'sell'; usd: number; tokens: number; mc: number | null; wallet?: string; tx: string; dev: boolean }
export type TradeFilter = 'all' | 'buy' | 'sell' | 'dev' | 'big';
export const TRADE_FILTERS: { id: TradeFilter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'buy', label: 'Buys' }, { id: 'sell', label: 'Sells' }, { id: 'dev', label: 'Dev' }, { id: 'big', label: '$1K+' }];
/**
 * The trades table: the latest trades of the 24h flow (newest first), each with its market cap at the time (its own
 * price times the supply) and whether the coin's deployer made it.
 */
export function tradeRows(flows: readonly Flow[], supply: number | null, deployer: string | undefined): TradeRow[] {
  const recent: FlowTrade[] = flows.find(f => f.window === '24h')?.activity?.recent ?? flows.find(f => f.window === '1h')?.activity?.recent ?? [];
  const dev = deployer?.toLowerCase();
  const seen = new Map<string, number>();
  return recent.map(t => {
    const base = `${t.tx}:${t.side}:${t.ts}`, n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: n ? `${base}:${n}` : base, ts: t.ts, side: t.side, usd: t.usd, tokens: t.tokens, mc: supply && t.tokens > 0 ? t.usd / t.tokens * supply : null,
      ...(t.wallet ? { wallet: t.wallet } : {}), tx: t.tx, dev: !!dev && t.wallet?.toLowerCase() === dev };
  });
}
export function filterTrades(rows: readonly TradeRow[], filter: TradeFilter): TradeRow[] {
  return filter === 'all' ? [...rows] : rows.filter(r => (filter === 'dev' ? r.dev : filter === 'big' ? r.usd >= 1000 : r.side === filter));
}
