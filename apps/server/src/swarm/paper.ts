import type { PersonaVote } from '@eko/shared';
import type { PonsResult, ReferenceResult } from '@eko/chain';
import { accountSpotFill, type SpotAccounting } from '../exec/position-accounting.js';

export type PaperStatus = 'pending' | 'open' | 'entry_failed' | 'closed';
export interface PaperPosition extends SpotAccounting {
  status: PaperStatus; vote: PersonaVote; dueMs: number; latestEntryMs: number; sizeUsd: number;
  tokens: string; decimals: number; entryMs: number | null; entryReference: string | null;
}
export interface PaperLeg {
  status: 'ok' | 'entry_failed' | 'exit_failed' | 'provider_failure' | 'state_unavailable' | 'missing_price' | 'missing_simulation';
  referenceId: string | null; tokens: string; quoteUsd: number; networkUsd: number; decimals: number;
  // Already contained in the balance deltas, never charged twice.
  buyTaxPct: number | null; sellTaxPct: number | null;
}
export interface PaperStep { position: PaperPosition; code: string; grade: { status: 'closed' | 'entry_failed'; realizedPnl: number; entryMs: number | null; exitMs: number; reason: string } | null }
/**
 * Return the deterministic two-to-ten-second delay for a nonnegative sample index. Pure scheduling
 * helper; callers supply a valid index.
 */
export const paperDelayMs = (sampleIndex: number) => 2000 + sampleIndex % 9 * 1000;
// TODO(spec): size buckets have no dollar mapping. Use existing reference sizes s=$100, m=$1k, l=$10k, never extrapolate.
/**
 * Map persona size buckets to the fixed reference sizes: none=0, s=100, m=1000, l=10000 USD. Pure
 * mapping; no extrapolation or trade sizing authority.
 */
export const paperSizeUsd = (size: PersonaVote['size_bucket']) => ({ none: 0, s: 100, m: 1000, l: 10000 })[size];
/**
 * Initialize a pending paper position using the vote, sample delay and recorded time, with a ten-
 * second latest-entry cutoff and zero accounting. Pure function; caller supplies validated
 * vote/index/time.
 */
export function initialPaperPosition(vote: PersonaVote, sampleIndex: number, recordedMs: number): PaperPosition {
  return { vote, status: 'pending', dueMs: recordedMs + paperDelayMs(sampleIndex), latestEntryMs: recordedMs + 10000,
    sizeUsd: paperSizeUsd(vote.size_bucket), tokens: '0', decimals: 18, entryMs: null, entryReference: null, quantity: 0, costBasis: 0, realizedPnl: 0 };
}
/**
 * Return max-hold, take-profit or stop-loss for an open position, or null when holding/non-open.
 * Missing/nonpositive marks cannot trigger price exits; max-hold still applies. Pure decision from
 * supplied paper state.
 */
export function paperExitReason(p: PaperPosition, nowMs: number, markUsd: number | null): string | null {
  if (p.status !== 'open') return null;
  if (nowMs >= p.entryMs! + p.vote.exit.max_hold_min * 60000) return 'max_hold';
  if (markUsd === null || !Number.isFinite(markUsd) || markUsd <= 0) return null;
  const changePct = (p.quantity * markUsd / p.costBasis - 1) * 100;
  return changePct >= p.vote.exit.tp_pct ? 'take_profit' : changePct <= -p.vote.exit.sl_pct ? 'stop_loss' : null;
}
/**
 * Advance supplied paper state with pinned time, mark and simulation leg. Entry misses/failures
 * become terminal; failed exits retain the position for retry. Apply spot accounting once per
 * valid fill and return an optional grade; no I/O or real orders occur, and malformed raw
 * quantities may throw.
 */
export function stepPaper(p: PaperPosition, nowMs: number, markUsd: number | null, leg: PaperLeg | null): PaperStep {
  const result = (position: PaperPosition, code: string, grade: PaperStep['grade'] = null) => ({ position, code, grade });
  if (p.status === 'closed' || p.status === 'entry_failed') return result(p, 'terminal');
  if (p.status === 'pending') {
    if (nowMs < p.dueMs) return result(p, 'delayed');
    const fail = (code: string) => result({ ...p, status: 'entry_failed' }, code,
      { status: 'entry_failed', realizedPnl: 0, entryMs: null, exitMs: nowMs, reason: code });
    if (nowMs > p.latestEntryMs) return fail('entry_window_missed');
    if (!leg || leg.status !== 'ok') return fail(leg?.status ?? 'missing_simulation');
    const quantity = Number(BigInt(leg.tokens)) / 10 ** leg.decimals;
    if (!(quantity > 0) || !Number.isFinite(quantity) || !(leg.quoteUsd > 0) || leg.networkUsd < 0 || !Number.isFinite(leg.quoteUsd + leg.networkUsd)) return fail('invalid_amounts');
    const accounting = accountSpotFill(p, 'buy', quantity, leg.quoteUsd, leg.networkUsd);
    return result({ ...p, ...accounting, status: 'open', tokens: leg.tokens, decimals: leg.decimals, entryMs: nowMs, entryReference: leg.referenceId }, 'entry_filled');
  }
  const reason = paperExitReason(p, nowMs, markUsd);
  if (!reason) return result(p, markUsd === null ? 'missing_price' : 'holding');
  // A failed exit retains the position and is retried on the next pinned cut. It is never graded as zero or silently dropped.
  if (!leg || leg.status !== 'ok') return result(p, leg?.status ?? 'missing_simulation');
  if (BigInt(leg.tokens) !== BigInt(p.tokens) || leg.decimals !== p.decimals) return result(p, 'quantity_mismatch');
  if (leg.quoteUsd < 0 || leg.networkUsd < 0 || !Number.isFinite(leg.quoteUsd + leg.networkUsd)) return result(p, 'invalid_amounts');
  const accounting = accountSpotFill(p, 'sell', p.quantity, leg.quoteUsd, leg.networkUsd);
  return result({ ...p, ...accounting, status: 'closed' }, 'exit_filled',
    { status: 'closed', realizedPnl: accounting.realizedPnl, entryMs: p.entryMs, exitMs: nowMs, reason });
}

/** Reuse measured balance deltas: taxes/venue/hook charges are already in spent/returned/tokens. */
export function referencePaperLeg(result: ReferenceResult | PonsResult, input: {
  side: 'buy' | 'sell'; position: PaperPosition; ethUsd: number | null; decimals: number; referenceId: string;
}): PaperLeg {
  const leg: PaperLeg = { status: 'missing_simulation', referenceId: input.referenceId, tokens: '0', quoteUsd: 0, networkUsd: 0, decimals: input.decimals, buyTaxPct: null, sellTaxPct: null };
  if (input.ethUsd === null || !Number.isFinite(input.ethUsd) || input.ethUsd <= 0) return { ...leg, status: 'missing_price' };
  if (result.status === 'provider_failure') return { ...leg, status: 'provider_failure' };
  const usd = (wei: string) => Number(BigInt(wei)) / 1e18 * input.ethUsd!;
  if (result.methodVersion === 'v3-reference-1') {
    if (input.side === 'sell') {
      // TODO(spec): 068 supplies fresh round trips, not held-position sells. Do not reuse a fresh buy's sell for a held position until a persistent-trajectory adapter exists.
      return { ...leg, status: 'state_unavailable' };
    }
    const probe = result.probe;
    if (!probe?.buyOk || BigInt(probe.tokens) <= 0n) return { ...leg, status: 'entry_failed' };
    // 068 does not measure network/L1 costs. Refuse an all-in grade until that evidence exists.
    return { ...leg, status: 'state_unavailable', tokens: probe.tokens, quoteUsd: usd(probe.spent), buyTaxPct: result.buyTaxPct, sellTaxPct: result.sellTaxPct };
  }
  const observations = result.observations.filter(o => o.accountClass === 'eoa' && o.mode === (input.side === 'buy' ? 'round_trip' : 'sell_only'));
  if (!observations.length) return leg;
  if (observations.some(o => o.status === 'provider_failure')) return { ...leg, status: 'provider_failure' };
  const o = observations[0];
  if (input.side === 'buy' && observations.every(o => !o.buyOk || BigInt(o.tokens) <= 0n)) return { ...leg, status: 'entry_failed' };
  if (input.side === 'sell' && observations.some(o => !o.sellOk)) return { ...leg, status: 'exit_failed' };
  // A successful entry must not depend on a later synthetic sell succeeding.
  if (input.side === 'buy' && observations.some(v => !v.buyOk || BigInt(v.tokens) <= 0n)) return { ...leg, status: 'state_unavailable' };
  if (input.side === 'sell' && observations.some(v => !v.fidelity || !v.validSellState || v.status !== 'ok')) return { ...leg, status: 'state_unavailable' };
  if (input.side === 'sell' && observations.some(v => BigInt(v.balanceBefore) < BigInt(input.position.tokens) || BigInt(v.tokens) !== BigInt(input.position.tokens))) return { ...leg, status: 'state_unavailable' };
  const network = input.side === 'buy' ? o.entryNetworkWei : o.exitNetworkWei;
  // Network cost in 040 already includes L1 and is not added again. Refunds are reflected in spent.
  if (network === null || BigInt(network) < 0n || observations.some(v => v.tokens !== o.tokens || (input.side === 'buy' ? v.spent !== o.spent : v.returned !== o.returned))) return { ...leg, status: 'state_unavailable' };
  return { ...leg, status: 'ok', tokens: o.tokens, quoteUsd: usd(input.side === 'buy' ? o.spent : o.returned), networkUsd: usd(network), buyTaxPct: o.buyTaxPct, sellTaxPct: o.sellTaxPct };
}
