import { z } from 'zod';
import { AddressSchema } from './common.js';
import { GuardCursorSchema } from './guard-v2.js';
import { UnsignedTxSchema } from './transactions.js';

const uint = z.string().max(78).regex(/^(0|[1-9]\d*)$/).refine(v => /^(0|[1-9]\d*)$/.test(v) && v.length <= 78 && BigInt(v) < 2n ** 256n);
const positive = uint.refine(v => v !== '0');
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as `0x${string}`);
/** Guard §§1/7.2: execution context is part of JCS(order), including approval bytes. */
export const ActualOrderBindingSchema = z.strictObject({
  chainId: z.number().int().positive(), account: AddressSchema, recipient: AddressSchema, coin: AddressSchema,
  side: z.enum(['buy', 'sell']), amountIn: positive, minOut: positive,
  slippageBps: z.number().int().min(0).max(9999), cursor: GuardCursorSchema,
  routeFingerprint: hash, profileHash: hash, stateFingerprint: hash, policyHash: hash,
  guardReceiptId: z.string().min(1), tx: UnsignedTxSchema,
  approval: z.strictObject({ token: AddressSchema, spender: AddressSchema, amount: positive,
    kind: z.literal('erc20'), tx: UnsignedTxSchema }).nullable(),
}).superRefine((v, c) => {
  if (v.chainId !== v.cursor.chainId || v.chainId !== v.tx.chainId ||
    v.cursor.boundary !== 'block_end' || !uint.safeParse(v.tx.value).success ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(v.tx.data) ||
    v.approval && (v.approval.amount !== v.amountIn || v.approval.token !== v.coin ||
      v.approval.tx.to !== v.coin || v.approval.tx.chainId !== v.chainId || v.approval.tx.value !== '0')) {
    c.addIssue({ code: 'custom', message: 'Execution binding disagrees with chain, amount or approval' });
  }
});
export type ActualOrderBinding = z.infer<typeof ActualOrderBindingSchema>;

/** Trusted acquisition inputs only, never accepted as evidence from an HTTP/MCP caller. */
export interface ActualOrderState {
  observedAtMs: number; criticalCheckedAtMs: number; cursor: z.infer<typeof GuardCursorSchema>;
  routeFingerprint: `0x${string}`; profileHash: `0x${string}`; stateFingerprint: `0x${string}`;
  balanceHash: `0x${string}`; feeHash: `0x${string}`; controlHash: `0x${string}`;
  sourceRevision: `0x${string}`; semanticHash: `0x${string}`;
  policyHash: `0x${string}`; guardReceiptId: string; routeAvailable: boolean;
}
export interface ActualOrderObservation {
  binding: ActualOrderBinding; state: ActualOrderState;
  quotedAtMs: number; refreshedAtMs: number; expiresAtMs: number;
  origin: 'fixture' | 'measured'; mode: 'round_trip' | 'sell_only';
  accountClass: 'eoa' | 'smart_account'; status: 'ok' | 'unsupported' | 'entry_limited' | 'exit_restricted' | 'provider_failure';
  spent: string; returned: string; tokens: string; heldBefore: string; allowanceBefore: string;
  notionalUsd: number; entryNetworkFee: string; exitNetworkFee: string; depthUsdLower: number | null;
  evidenceIds: `0x${string}`[];
}
export type ActualOrderLookup = { status: 'ready'; observation: ActualOrderObservation } |
  { status: 'queued' | 'unavailable'; code: string };
