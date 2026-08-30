import type { Address, Hex } from 'viem';
import type { GuardCursor } from '@eko/shared';
import type { ReferenceRoute } from './v3.js';
export type ReferenceSize = 100 | 1000 | 10000;
export type ReferenceStatus = 'ok' | 'provider_failure' | 'entry_limited' | 'entry_unavailable' | 'contract_restricted' | 'blocked_exit' | 'cooldown_unresolved' | 'fork_evidence_missing' | 'unsupported';
export interface RoundTripAmounts {
  tokens: string; spent: string; returned: string; quotedBuy: string; quotedSell: string;
  buyOk: boolean; sellOk: boolean; revert: Hex;
}
export interface DeepEvidence extends RoundTripAmounts {
  account: Address; blockHash: Hex; allowanceBefore: string; delaySec: number;
  validSellState: boolean; trace?: unknown;
}
export interface ReferenceResult {
  id: Hex; methodVersion: 'v3-reference-1'; coin: Address; cursor: GuardCursor; sizeUsd: ReferenceSize;
  routeId: string; routeSnapshot: Omit<ReferenceRoute,'deadline'> & {deadline:string}; requestedWei: string; probe: RoundTripAmounts | null; deep: DeepEvidence[];
  status: ReferenceStatus; complete: boolean; honeypotConfirmed: boolean;
  buyTaxPct: number | null; sellTaxPct: number | null; exitCostPct: number | null;
  traceDigest: Hex; trace: unknown; fidelityEvidenceIds: Hex[];
}
/** Accepted matched evidence is separate from fixture tests and current execution. */
export interface ForkMatch {
  id: Hex; venue: 'uniswap_v3' | 'pons_curve'; sizeUsd: ReferenceSize; accountClass: 'eoa' | 'contract';
  caseId: string; expectedSpent: string; actualSpent: string; expectedReturned: string; actualReturned: string;
  expectedBlocked: boolean; actualBlocked: boolean;
}
export interface ReferenceInput { cursor: GuardCursor; sizeUsd: ReferenceSize; sizeWei: bigint; route: ReferenceRoute; matches: ForkMatch[] }
export interface AnvilRpc { request(input: { method: string; params: readonly unknown[] }): Promise<unknown> }
/** Exclusive lease belongs to one host. reset must use the metered archive gateway for ALL upstream fork reads. */
export interface MeteredForkLease {
  withExclusive<T>(work: (rpc: AnvilRpc, reset: (cursor: GuardCursor) => Promise<void>) => Promise<T>): Promise<T>;
}
