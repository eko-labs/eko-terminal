import { z } from 'zod';
import { AddressSchema, Bytes32Schema, GuardCursorSchema } from '@eko/shared';
import type { GuardCursor } from '@eko/shared';
import type { Address, Hex } from 'viem';
import type { createMeteredClients } from '../rpc/clients.js';
import type { LocalDepthRoute } from '../simulation/directional-depth.js';
import { CHAIN_ID } from '@eko/shared';

const address = AddressSchema.transform(v => v.toLowerCase() as Address);
const evidence = z.array(Bytes32Schema).min(1).max(16);
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v => BigInt(v) < 1n << 256n);
/** Registry entries are captured semantic reviews, not selector or code-presence guesses.
 * Only immutable, non-proxy contracts are supported by this first adapter. */
export const CustodyRegistrySchema = z.strictObject({
  chainId: z.literal(CHAIN_ID), origin: z.enum(['fixture', 'measured']),
  managers: z.array(z.strictObject({ address, codeHash: Bytes32Schema, factory: address, factoryCodeHash: Bytes32Schema,
    semantics: z.literal('immutable_v3_nft'), evidenceIds: evidence })).max(8),
  // TODO(spec): no generic locker ABI/production registry is specified. Reviews must
  // supply this read recipe and prove immutable, nonrevocable full-position custody.
  // Its return tuple is (manager, tokenId, beneficiary, liquidity, expirySec, revocable).
  lockers: z.array(z.strictObject({ address, codeHash: Bytes32Schema,
    selector: z.string().regex(/^0x[0-9a-f]{8}$/), semantics: z.literal('immutable_position_lock'),
    evidenceIds: evidence })).max(16),
});
export type CustodyRegistry = z.infer<typeof CustodyRegistrySchema>;
export const IndexedCustodySchema = z.strictObject({
  cursor: GuardCursorSchema, origin: z.enum(['fixture', 'measured']), evidenceIds: evidence,
  pools: z.array(z.strictObject({ poolId: z.string().min(1).max(128), complete: z.boolean(),
    positions: z.array(z.strictObject({ manager: address, tokenId: uint,
      /** Candidate ApprovalForAll actors from the index, revalidated at the pin. */
      operators: z.array(address).max(8), operatorsComplete: z.boolean(),
    })).max(128),
  })).max(16),
});
export type IndexedCustody = z.infer<typeof IndexedCustodySchema>;
export interface CustodyIndex {
  /** Must filter to the requested pools and reconstruct canonical history through the
   * exact cursor. Truncated discovery is complete=false, never a silent empty list. */
  positions(input: { poolIds: string[]; cursor: GuardCursor; limitPerPool: 128 }): Promise<IndexedCustody>;
}
export type CustodyClients = Pick<ReturnType<typeof createMeteredClients>, 'archive'>;
export type CustodyPool = { launchpad: 'other'; route: LocalDepthRoute } |
  { launchpad: 'other'; venue: 'uniswap_v4'; poolId: string };
export type CustodyGap = 'generic_v4_positions_unsupported' | 'position_index_incomplete' |
  'manager_unverified' | 'position_read_failed' | 'position_pool_mismatch' | 'locker_unverified' |
  'locker_state_unresolved' | 'approval_coverage_incomplete' | 'position_liquidity_unreconciled';
export interface CustodyPosition {
  id: string; poolId: string; manager: Address; tokenId: string; owner: Address | null;
  lower: bigint; upper: bigint; liquidity: bigint;
  custody: 'removable' | 'locked' | 'burned' | 'unknown';
  /** Authorization observations, not authenticated common-control group membership. */
  removers: Address[]; expirySec: string | null; beneficiary: Address | null;
  evidenceIds: Hex[]; gaps: CustodyGap[];
}
export interface CustodyObservation {
  id: Hex; methodVersion: 'generic-lp-custody-1'; cursor: GuardCursor;
  origin: 'fixture' | 'measured'; registryHash: Hex; indexHash: Hex;
  pools: { poolId: string; routeStateHash: Hex | null; complete: boolean; positions: CustodyPosition[]; gaps: CustodyGap[] }[];
  trace: unknown[]; requests: number;
}
