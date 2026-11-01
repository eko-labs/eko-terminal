import { zeroAddress } from 'viem';
import type { CoinState } from './tracker.js';

/**
 * Graduation on Elysium. Nothing migrates here: Montra marks a line in the token's own pool (its default configuration
 * puts it 28,200 ticks above the opening price, 16.8×) so that a terminal's New / About to graduate / Graduated
 * columns work as they do on a bonding-curve chain (montramarkets.xyz/docs/build, "No bonding curve, no migration").
 * - Progress is the quote the seed position has collected over what it holds at the line. The seed is one position from
 *   the opening price up, so that is (√(price / opening) − 1) / (√line − 1). Checked against Montra's API on 2026-11-12:
 *   7,204 and 6,054 here for its 7,211 and 6,059.
 * - About to graduate is half way or more (Montra's own board cuts there); graduated is the hook's Graduated event.
 * - The other launchpads on Elysium (the Flaunch fork, HyperForge, the tax launchpad, the unbranded launcher) have no
 *   graduation. They are measured against the same line in market cap: Montra's opening market cap times the line, so
 *   a column means the same market cap (about 710 HYPE at the line) whatever launched the coin. Crossing it is sticky.
 */
export const LINE_TICKS = 28_200;
export const LINE_MULTIPLE = 1.0001 ** LINE_TICKS;
export const HALF_WAY_BPS = 5000;
/** Montra's opening market cap in HYPE on its default configuration (1e9 supply at 4.2272e-8 HYPE, 2026-11-12). */
export const DEFAULT_OPEN_MCAP_HYPE = 42.2716;

/** HYPE per token at a Montra pool's opening tick (native HYPE is always currency0; both sides 18 decimals). */
export function openPriceAt(startTick: number, quoteIsCurrency0: boolean) {
  return 1.0001 ** (quoteIsCurrency0 ? -startTick : startTick);
}

const progressOf = (multiple: number) => {
  if (!(multiple > 1)) return 0;
  return Math.min(10_000, Math.max(0, Math.round(10_000 * (Math.sqrt(multiple) - 1) / (Math.sqrt(LINE_MULTIPLE) - 1))));
};

/**
 * Basis points of the way to the line (0 to 10,000), or null when it cannot be measured: a Montra coin quoted in
 * something other than native HYPE (its price here is in HYPE), or one whose opening price was not seen.
 */
export function graduationBps(c: CoinState, openMcapHype = DEFAULT_OPEN_MCAP_HYPE): number | null {
  if (c.graduated) return 10_000;
  const price = c.trades.at(-1)?.priceHype ?? 0;
  if (c.launchpad === 'montra') {
    if (c.quote !== zeroAddress || !c.openPrice) return null;
    return progressOf(price / c.openPrice);
  }
  const supply = Number(c.supply) / 1e18;
  return progressOf((price * supply) / openMcapHype);
}
