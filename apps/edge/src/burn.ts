/**
 * Burn sinks: the zero address, the conventional 0x…dEaD and 0x…01. Tokens sent there are gone, so these are never a
 * holder, trader, sniper, early buyer or any other wallet role, on any chain or launchpad. Lowercase, as flows are kept.
 */
export const BURN_SINKS: readonly string[] = Object.freeze(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000001']);
