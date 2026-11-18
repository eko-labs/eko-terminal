/**
 * Run-up score, 0-100: how far a Pons coin's price would fall if it went back to its launch curve's starting price.
 * Curve progress p (percent of the graduation reserve raised) puts the price at (1 + p/40)^2 times the start. Measured on
 * Robinhood Chain, 2026-10-12: progress = 40 x s/(1-s) for s = share of supply bought, on every curve size (median 40.0
 * over 59 live cards), and the median price change 24 hours after a rating matched the fall to the start within four
 * points at every 5-point step of s (-12% at 5-10% bought, -30% at 15-20%, -54% at 30-35%, -85% at 60-65%; 29,608
 * ratings). It is a distance, not a forecast. Undefined after graduation and without curve progress.
 */
export function runUpScore(row: { stage?: string; curvePct?: number }): number | undefined {
  if (row.stage !== 'curve' || row.curvePct == null || !Number.isFinite(row.curvePct) || row.curvePct < 0) return undefined;
  return Math.round(100 * (1 - 1 / runUpMultiple(row.curvePct)));
}
/** The price as a multiple of the curve's starting price at this curve progress. */
export const runUpMultiple = (curvePct: number) => (1 + curvePct / 40) ** 2;
