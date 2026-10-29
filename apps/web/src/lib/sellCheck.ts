import type { CoinCard } from '@eko/shared';

export type ExitSize = 'usd100' | 'usd1k' | 'usd10k';
/** CA-34: an exit size is a measurement unless its section is unavailable or the size is named missing. */
export function exitMeasured(card: CoinCard, size: ExitSize) {
  const t = card.meta?.tradeability;
  if (!t) return true;
  return !t.unavailable && !(t.missing ?? []).some(m => ['exitCosts', 'exitCostPct', `exitCostPct.${size}`, size].includes(m));
}
/** The live sell check's reading on a card, from its tradeability flags; undefined means not checked. */
export function sellCheckOf(card: CoinCard): 'sellable' | 'refused' | undefined {
  const flags = card.meta?.tradeability?.flags ?? [];
  return flags.includes('sell_check_refused') ? 'refused' : flags.includes('sell_check_sellable') ? 'sellable' : undefined;
}
/** True when the card names any of these tradeability fields as not measured. */
export const tradeabilityGap = (card: CoinCard, ...fields: string[]) => !!card.meta?.tradeability?.missing?.some(m => fields.includes(m));
