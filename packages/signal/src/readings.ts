import type { SignalInput } from './types.js';

const clamp = (value: number): number => Math.max(0, Math.min(100, value));

function finite(value: number, name: string, min = -Infinity, max = Infinity): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be finite and between ${min} and ${max}`);
  }
  return value;
}

/** TODO(spec): equal thirds, tanh scales of 10 pp (5m), 25 pp (1h), and a volume doubling.
 * Log1p volumes make zero/zero neutral and a zero prior hour finite, without a division by zero.
 * Every input increases the score continuously; larger prior volume decreases it.
 */
export function momentumReading(input: Pick<SignalInput,
  'priceChange5mPct' | 'priceChange1hPct' | 'buyVolumeUsd1h' | 'buyVolumeUsdPrevious1h'>): number {
  const short = Math.tanh(finite(input.priceChange5mPct, 'priceChange5mPct') / 10);
  const hour = Math.tanh(finite(input.priceChange1hPct, 'priceChange1hPct') / 25);
  const growth = Math.tanh((Math.log1p(finite(input.buyVolumeUsd1h, 'buyVolumeUsd1h', 0))
    - Math.log1p(finite(input.buyVolumeUsdPrevious1h, 'buyVolumeUsdPrevious1h', 0))) / Math.LN2);
  return clamp(50 + 50 * (short + hour + growth) / 3);
}

/** TODO(spec): interpolate linearly in log1p(depth) between the anchors (0,0), (2k,20), (50k,70), (250k,95),
 * capped at 95 thereafter, so every extra dollar of depth moves the reading (no flat spots at the anchors).
 * Exit costs above 5% subtract 2 points per extra percentage point, then clamp to 0–100.
 */
export function liquidityReading(input: Pick<SignalInput, 'depth2Usd' | 'exitCost1kPct'>): number {
  const depth = finite(input.depth2Usd, 'depth2Usd', 0);
  const cost = finite(input.exitCost1kPct, 'exitCost1kPct');
  const anchors = [[0, 0], [2000, 20], [50000, 70], [250000, 95]] as const;
  let score = 95;
  for (let i = 1; i < anchors.length; i++) {
    const [lowDepth, lowScore] = anchors[i - 1];
    const [highDepth, highScore] = anchors[i];
    if (depth <= highDepth) {
      const t = (Math.log1p(depth) - Math.log1p(lowDepth)) / (Math.log1p(highDepth) - Math.log1p(lowDepth));
      score = lowScore + (highScore - lowScore) * t;
      break;
    }
  }
  return clamp(score - 2 * Math.max(0, cost - 5));
}

/** TODO(spec): holder log1p growth uses tanh with a 25% growth scale around 50.
 * Top-10, fresh-wallet and bundle shares subtract 0.3, 0.2 and 0.5 points per pp.
 * Equal counts without concentrations are neutral; zero counts use the same finite curve.
 */
export function holdersReading(input: Pick<SignalInput,
  'holdersNow' | 'holdersPrevious1h' | 'top10Pct' | 'freshWalletsPct' | 'bundlesHeldPct'>): number {
  const growth = Math.tanh((Math.log1p(finite(input.holdersNow, 'holdersNow', 0))
    - Math.log1p(finite(input.holdersPrevious1h, 'holdersPrevious1h', 0))) / Math.log(1.25));
  return clamp(50 + 50 * growth
    - 0.3 * finite(input.top10Pct, 'top10Pct', 0, 100)
    - 0.2 * finite(input.freshWalletsPct, 'freshWalletsPct', 0, 100)
    - 0.5 * finite(input.bundlesHeldPct, 'bundlesHeldPct', 0, 100));
}

export interface NarrativeReading { score: number; lowData: boolean }

/** TODO(spec): mean of available components: rank 100/(1+(rank−1)/20) (rank 21 → 50),
 * agent-buy percentage directly (50% → 50), X pace 100*p/(p+10) (10 mentions/h → 50).
 * Missing components are omitted; measured zero contributes zero. No observations → neutral.
 */
export function narrativeReading(input: Pick<SignalInput, 'trendingRank' | 'agentBuyPct' | 'xMentionPace'>): NarrativeReading {
  const scores: number[] = [];
  if (input.trendingRank !== undefined) {
    scores.push(100 / (1 + (finite(input.trendingRank, 'trendingRank', 1) - 1) / 20));
  }
  if (input.agentBuyPct !== undefined) scores.push(finite(input.agentBuyPct, 'agentBuyPct', 0, 100));
  if (input.xMentionPace !== undefined) {
    const pace = finite(input.xMentionPace, 'xMentionPace', 0);
    scores.push(100 * (pace / (pace + 10)));
  }
  return { score: scores.length ? clamp(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 50,
    lowData: scores.length === 0 };
}

/** BACKEND §7.7: Danger overrides all deductions; Info/Clear do not deduct.
 * TODO(spec): interpret “a Monitor match −25” per match, accumulating across matches.
 */
export function riskReading(input: Pick<SignalInput, 'playbooks' | 'control' | 'lpStatus'>): number {
  if (input.playbooks.some((match) => match.level === 'danger')) return 0;
  const monitors = input.playbooks.filter((match) => match.level === 'monitor').length;
  const powers = Number(input.control.canChangeTax) + Number(input.control.canBlacklist) + Number(input.control.canMint);
  return clamp(100 - 25 * monitors - 10 * powers - (input.lpStatus === 'removable' ? 15 : 0));
}
