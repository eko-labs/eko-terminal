import { z } from 'zod';

/** Indexed swap USD per raw coin unit, exactly the grade-outcome price source. */
export const RatingPriceMoveSchema = z.object({
  downFromPeakPct: z.number().min(0).max(100).optional(),
  downSinceRatedPct: z.number().min(0).max(100).optional(),
});
export type RatingPriceMove = z.infer<typeof RatingPriceMoveSchema>;
const valid = (price: number | null | undefined): price is number => price != null && Number.isFinite(price) && price > 0;
/** One trigger definition. The peak event is acknowledged once; later records require another halving. */
export function ratingPriceMove(current: number | null, full: number | null, peak: number | null, peakRecorded = false) {
  const since = valid(current) && valid(full) ? Math.max(0, 100 * (1 - current / full)) : 0;
  const fromPeak = valid(current) && valid(peak) ? Math.max(0, 100 * (1 - current / peak)) : 0;
  const halved = valid(current) && valid(full) && current <= full * 0.5;
  const belowPeak = valid(current) && valid(peak) && current <= peak * 0.2;
  return { force: halved || (belowPeak && !peakRecorded), belowPeak,
    fact: { ...(halved ? { downSinceRatedPct: since } : {}), ...(belowPeak ? { downFromPeakPct: fromPeak } : {}) } satisfies RatingPriceMove };
}
export function ratingPriceFact(move?: RatingPriceMove): string | undefined {
  if (move?.downFromPeakPct != null) return `Down ${Math.floor(move.downFromPeakPct)}% from peak`;
  if (move?.downSinceRatedPct != null) return `Down ${Math.floor(move.downSinceRatedPct)}% since rated`;
  return undefined;
}
