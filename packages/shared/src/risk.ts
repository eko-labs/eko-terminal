export interface PositionSizeInput {
  accountSize: number;
  riskPct: number;
  entry: number;
  stop: number;
  feeBps?: number;
}

export interface PositionSizeResult {
  riskAmount: number;
  perUnitRisk: number;
  quantity: number;
  notional: number;
  /** Whether the full risk-based size exceeded the account and was capped. */
  capped: boolean;
  leverageImplied: number;
  error: string | null;
}

/** Fixed-fractional position sizing for a spot long (stop below entry). */
export function positionSize(i: PositionSizeInput): PositionSizeResult {
  const empty = { riskAmount: 0, perUnitRisk: 0, quantity: 0, notional: 0, capped: false, leverageImplied: 0 };
  if (!(i.accountSize > 0)) return { ...empty, error: 'Account size must be positive' };
  if (!(i.riskPct > 0 && i.riskPct <= 100)) return { ...empty, error: 'Risk % must be between 0 and 100' };
  if (!(i.entry > 0) || !(i.stop > 0)) return { ...empty, error: 'Entry and stop must be positive' };
  if (i.stop >= i.entry) return { ...empty, error: 'For a spot long the stop must be below entry' };
  const fee = (i.feeBps ?? 0) / 10_000;
  const riskAmount = (i.accountSize * i.riskPct) / 100;
  // Round-trip fees add to per-unit risk.
  const perUnitRisk = i.entry - i.stop + (i.entry + i.stop) * fee;
  let quantity = riskAmount / perUnitRisk;
  let notional = quantity * i.entry;
  let capped = false;
  if (notional > i.accountSize) {
    capped = true;
    notional = i.accountSize;
    quantity = notional / i.entry;
  }
  return { riskAmount, perUnitRisk, quantity, notional, capped, leverageImplied: notional / i.accountSize, error: null };
}

export interface RiskRewardInput {
  entry: number;
  stop: number;
  target: number;
  feeBps?: number;
}

export interface RiskRewardResult {
  risk: number;
  reward: number;
  ratio: number;
  /** Win rate needed to break even at this R:R after fees. */
  breakevenWinRate: number;
  riskPct: number;
  rewardPct: number;
  error: string | null;
}

export function riskReward(i: RiskRewardInput): RiskRewardResult {
  const empty = { risk: 0, reward: 0, ratio: 0, breakevenWinRate: 0, riskPct: 0, rewardPct: 0 };
  if (!(i.entry > 0 && i.stop > 0 && i.target > 0)) return { ...empty, error: 'All prices must be positive' };
  if (!(i.stop < i.entry && i.target > i.entry)) return { ...empty, error: 'Spot long requires stop < entry < target' };
  const fee = (i.feeBps ?? 0) / 10_000;
  const risk = i.entry - i.stop + (i.entry + i.stop) * fee;
  const reward = i.target - i.entry - (i.entry + i.target) * fee;
  if (reward <= 0) return { ...empty, risk, reward, error: 'Fees exceed the distance to target' };
  const ratio = reward / risk;
  return {
    risk,
    reward,
    ratio,
    breakevenWinRate: 1 / (1 + ratio),
    riskPct: (risk / i.entry) * 100,
    rewardPct: (reward / i.entry) * 100,
    error: null,
  };
}

/**
 * One-tap sell sizing: the base quantity worth `usd` at `bid`, floored to `decimals`, capped at
 * `held`. When that would take the whole holding — it's worth less than `usd`, or the remainder
 * would be under one unit of precision — it sells everything (`all`). `usd = Infinity` means
 * "sell all". `qty` is 0 when nothing is held or `usd` is less than one unit's worth.
 */
export function sellQuantity(usd: number, bid: number, held: number, decimals: number): { qty: number; all: boolean } {
  if (!(held > 0) || !(bid > 0) || !(usd > 0)) return { qty: 0, all: false };
  const scale = 10 ** decimals;
  const want = Math.floor((usd / bid) * scale) / scale;
  if ((held - want) * scale < 1) return { qty: held, all: true };
  return { qty: want, all: false };
}
