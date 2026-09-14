import { canonicalize } from '@eko/policy';
import { keccak256, stringToHex } from 'viem';
import { CONFIG_V1 } from '../config/v1.js';

export const RULES_VERSION = '1.0.2';
export const CONFIG_HASH = keccak256(stringToHex(canonicalize(CONFIG_V1)));
export { CONFIG_V1 };
export type { PlaybookConfig } from '../config/v1.js';
export type { CardSources, HistoryView, PlaybookInput, PriorLaunch, Rule, Simulation, VerdictMeta } from './types.js';
export * from './rules.js';
export { assembleVerdict, reasonForMatch } from './verdict.js';
export * from './guard-registry.js';
export * from './history-v2.js';
export * from './guard-scoring.js';

/** Card assembly can use this without adding a field to the shared match type. */
export function cloneFromMatches(matches: import('@eko/shared').PlaybookMatch[]): NonNullable<import('@eko/shared').CoinCard['clone']> {
  const original = matches.find((m) => m.id === 'clone_swarm')?.evidence.find((e) => e.kind === 'address' && e.label === 'clone.originalAddress');
  return original ? { isClone: true, originalAddress: original.ref as import('@eko/shared').Address } : { isClone: false };
}
export { evaluateGuardFactor } from './guard-factors.js';
