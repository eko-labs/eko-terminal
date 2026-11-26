import type { EkoScore } from './contracts/coin.js';

/**
 * The EKO score: one 0-100 number that combines the verdict with the coin's setup. The verdict sets the band and the
 * band always matches it; the setup only places the coin inside its band, so a Danger coin can never outscore a coin
 * that Looks OK, and 72 always means "Looks OK, middling setup".
 *
 *   Danger 0-39 (a hard Danger: 0-10) · Be careful (Monitor) 40-69 · Looks OK (Clear) 70-100, at most 84 when Clear on
 *   part of the coin's history only · Pending: no score.
 *
 *   setup = .35 momentum + .25 money + .25 holders + .15 exit   (each part 0-100; a part without data counts as 50)
 *   value = bandLow + round(setup / 100 * (bandHigh - bandLow))
 *
 * Pure and cheap (a few arithmetic steps): the edge runs it for every Radar row and the web's demo data runs the same
 * function, so the two never disagree.
 */
export type EkoScoreBand = EkoScore['band'];
export type EkoScorePart = keyof EkoScore['parts'];

export const EKO_SCORE_WEIGHTS = Object.freeze({ momentum: 0.35, money: 0.25, holders: 0.25, exit: 0.15 });
export const EKO_SCORE_BANDS = Object.freeze({ danger: [0, 39], careful: [40, 69], ok: [70, 100] } as const);
/** A hard Danger (sell refused, honeypot, a finding no risk mode accepts) sits at the bottom of the Danger band. */
export const EKO_SCORE_HARD_DANGER_MAX = 10;
/** A Clear verdict graded on part of the coin's history only. */
export const EKO_SCORE_PARTIAL_MAX = 84;
const PARTS: readonly EkoScorePart[] = ['momentum', 'money', 'holders', 'exit'];

/** What each check is called on screen: in the words a trader uses, not the rule's internal name. */
export const PLAYBOOK_LABELS: Readonly<Record<string, string>> = Object.freeze({ honeypot: 'Honeypot', tax_trap: 'Tax trap', removable_liquidity: 'Liquidity can be pulled', fee_trap_pool: 'Fee-trap pool', stuck_at_bonding: 'Stuck on the curve', wash_to_trend: 'Fake volume', clone_swarm: 'Clone', exempt_insiders: 'Tax-free insiders', bundle_dump: 'Bundled launch', migration_dump: 'Dumped at bonding', malicious_hook: 'Malicious hook', agent_bait: 'Agent bait', serial_deployer: 'Bad dev history', holder_concentration: 'Top-heavy holders', dev_dump: 'Dev dump', run_up: 'Already ran', launch_snipers: 'Snipers', fake_mcap: 'Fake market cap' });
/** A playbook's display name at the level it matched (`malicious_hook` at Monitor is an unreviewed hook, not a measured one). */
export function playbookLabel(id: string, level?: string): string {
  if (id === 'malicious_hook' && level === 'monitor') return 'Unreviewed hook';
  return PLAYBOOK_LABELS[id] ?? id.replaceAll('_', ' ');
}

/** Everything the score reads. Every measurement is optional: absent means not measured, never zero. */
export interface EkoScoreInput {
  verdict: 'clear' | 'monitor' | 'danger' | 'pending';
  /** The verdict was graded on part of the coin's history only (Verdict.historyPartial). */
  historyPartial?: boolean;
  /** A Danger finding no risk mode accepts (CoinSummary.hardDanger). */
  hardDanger?: boolean;
  /** The live sell check: `refused` means the sell reverted or returned under 5% in simulation. */
  sellCheck?: 'sellable' | 'refused';
  /** The verdict's matches; the strongest Danger / Monitor one names why the score sits where it does. */
  playbooks?: readonly { id: string; level: string }[];
  // Momentum.
  change1hPct?: number;
  volume1hUsd?: number;
  /** Average volume per hour over the coin's earlier hours; absent under an hour of history. */
  volumeBaselineUsd?: number;
  /** The last hour's buy and sell flow (any unit; only their ratio is read). */
  buyUsd1h?: number;
  sellUsd1h?: number;
  // Money.
  liquidityUsd?: number;
  marketCapUsd?: number;
  /** A bonding-curve coin's way to graduation (0-100); its presence marks the coin as on a curve. */
  curvePct?: number;
  // Holders (percent of supply, 0-100).
  top10Pct?: number;
  devPct?: number;
  /** What the first minute's buyers still hold. */
  earlyHeldPct?: number;
  snipersHeldPct?: number;
  bundlesHeldPct?: number;
  // Exit.
  /** Round-trip cost of a $1K buy then sell, in %. */
  exitCost1kPct?: number;
}

const num = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * Momentum, 0-100: the mean of what is measured of
 *  - the 1h price move: 50 + 50·tanh(move / 25%)  (+25% → 88, 0 → 50, −25% → 12);
 *  - the hour's volume against its usual hour: 50 + 50·tanh(log2(ratio) / 2)  (4× → 88, 1× → 50, ¼× → 12);
 *  - the buy share of the hour's flow, as a percentage (60% buys → 60).
 */
export function momentumPart(i: EkoScoreInput): number | undefined {
  const parts: number[] = [];
  if (num(i.change1hPct)) parts.push(50 + 50 * Math.tanh(i.change1hPct / 25));
  if (num(i.volume1hUsd) && num(i.volumeBaselineUsd) && i.volumeBaselineUsd > 0) {
    const ratio = Math.max(i.volume1hUsd / i.volumeBaselineUsd, 1 / 1024);
    parts.push(50 + 50 * Math.tanh(Math.log2(ratio) / 2));
  }
  const buy = num(i.buyUsd1h) ? Math.max(0, i.buyUsd1h) : undefined, sell = num(i.sellUsd1h) ? Math.max(0, i.sellUsd1h) : undefined;
  if (buy !== undefined && sell !== undefined && buy + sell > 0) parts.push(100 * buy / (buy + sell));
  return parts.length ? clamp(mean(parts)) : undefined;
}

/** Liquidity depth, 0-100 on a log scale: $100 → 0, $1K → 33, $10K → 67, $100K and more → 100. */
const depth = (usd: number) => clamp(100 * Math.log10(Math.max(usd, 1) / 100) / 3);

/**
 * Money behind it, 0-100. In a pool: .6 · backing + .4 · depth, where backing = liquidity / market cap scored as
 * 100·b / (b + 8%) (8% → 50, 24% → 75). On a bonding curve: .6 · curve progress + .4 · depth. Without a market cap (or
 * curve progress) only depth counts; without liquidity the part is missing.
 */
export function moneyPart(i: EkoScoreInput): number | undefined {
  if (!num(i.liquidityUsd) || i.liquidityUsd < 0) return undefined;
  const d = depth(i.liquidityUsd);
  if (num(i.curvePct)) return clamp(0.6 * clamp(i.curvePct) + 0.4 * d);
  if (num(i.marketCapUsd) && i.marketCapUsd > 0) {
    const b = i.liquidityUsd / i.marketCapUsd;
    return clamp(0.6 * (100 * b / (b + 0.08)) + 0.4 * d);
  }
  return d;
}

/**
 * Holder spread, 0-100: 100, less a point for every point the top ten hold above 20%, 1.5 points per point the dev
 * holds, and a point per point of the largest of the early buyers', snipers' and bundles' holdings (these overlap, so
 * only the largest counts). Missing when none of them is measured.
 */
export function holdersPart(i: EkoScoreInput): number | undefined {
  const early = [i.earlyHeldPct, i.snipersHeldPct, i.bundlesHeldPct].filter(num);
  if (!num(i.top10Pct) && !num(i.devPct) && !early.length) return undefined;
  return clamp(100 - Math.max(0, (num(i.top10Pct) ? i.top10Pct : 20) - 20) - 1.5 * (num(i.devPct) ? i.devPct : 0)
    - (early.length ? Math.max(...early) : 0));
}

/** Easy to exit, 0-100: 100 − 2 × the $1K round-trip cost (0% → 100, 25% → 50, 50%+ → 0); a refused sell is 0. */
export function exitPart(i: EkoScoreInput): number | undefined {
  if (i.sellCheck === 'refused') return 0;
  return num(i.exitCost1kPct) ? clamp(100 - 2 * Math.max(0, i.exitCost1kPct)) : undefined;
}

/** True for a Danger the score pins to 0-10: the sell was refused, a honeypot matched, or no risk mode accepts it. */
export const scoreHardDanger = (i: EkoScoreInput) => i.verdict === 'danger'
  && (!!i.hardDanger || i.sellCheck === 'refused' || !!i.playbooks?.some(m => m.id === 'honeypot' && m.level === 'danger'));

/** Why the score sits in its band, in plain words: the verdict's strongest finding. */
function reasonOf(i: EkoScoreInput, hard: boolean): string | undefined {
  if (i.verdict === 'clear') return i.historyPartial ? 'Partly checked' : undefined;
  if (hard && i.sellCheck === 'refused') return 'Sell check refused';
  const want = i.verdict === 'danger' ? 'danger' : 'monitor';
  const top = i.playbooks?.find(m => m.level === want) ?? i.playbooks?.find(m => m.level === 'danger' || m.level === 'monitor');
  if (top) return playbookLabel(top.id, top.level);
  if (i.sellCheck === 'refused') return 'Sell check refused';
  return i.verdict === 'danger' ? 'A Danger finding' : 'Something to watch';
}

/** The score, or undefined while the verdict is pending. */
export function ekoScore(i: EkoScoreInput): EkoScore | undefined {
  if (i.verdict === 'pending') return undefined;
  const measured: Record<EkoScorePart, number | undefined> = { momentum: momentumPart(i), money: moneyPart(i), holders: holdersPart(i), exit: exitPart(i) };
  const missing = PARTS.filter(p => measured[p] === undefined);
  const parts = Object.fromEntries(PARTS.map(p => [p, Math.round(measured[p] ?? 50)])) as EkoScore['parts'];
  const setup = PARTS.reduce((s, p) => s + EKO_SCORE_WEIGHTS[p] * (measured[p] ?? 50), 0);
  const hard = scoreHardDanger(i);
  const band: EkoScoreBand = i.verdict === 'danger' ? 'danger' : i.verdict === 'monitor' ? 'careful' : 'ok';
  const [low, top] = EKO_SCORE_BANDS[band];
  const high = hard ? EKO_SCORE_HARD_DANGER_MAX : band === 'ok' && i.historyPartial ? EKO_SCORE_PARTIAL_MAX : top;
  // A sell refused on a coin not graded Danger (the checks disagree for a moment) sits at the bottom of its band.
  const place = i.sellCheck === 'refused' && !hard ? 0 : clamp(setup) / 100;
  const value = low + Math.round(place * (high - low));
  const cappedBy = reasonOf(i, hard);
  return { value, band, cap: high, parts, ...(missing.length ? { missing } : {}), ...(cappedBy ? { cappedBy } : {}) };
}

/** The band's word on screen. */
export const EKO_SCORE_BAND_LABEL: Readonly<Record<EkoScoreBand, string>> = Object.freeze({ danger: 'Danger', careful: 'Careful', ok: 'OK' });
