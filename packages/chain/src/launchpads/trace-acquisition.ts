import { z } from 'zod';
import { concatHex, keccak256, recoverAddress, toHex, toRlp, type Hex } from 'viem';
import { AddressSchema, Bytes32Schema, GuardCursorSchema } from '@eko/shared';
import type { GuardCursor } from '@eko/shared';
import type { createMeteredClients } from '../rpc/clients.js';
import { rpcStopReason } from '../rpc/metered.js';

export const TRACE_ROLES_METHOD_VERSION = '2.1.0' as const;
/** The delegation marker identifies an implementation, never a controller. */
export function decodeDelegationCode(code: string): Hex | null {
  return /^0xef0100[0-9a-fA-F]{40}$/.test(code) ? code.slice(8).toLowerCase().replace(/^/, '0x') as Hex : null;
}
const address = AddressSchema.transform(a => a.toLowerCase() as Hex);
const hash = Bytes32Schema.transform(h => h.toLowerCase() as Hex);
const bytes = z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/).transform(v => v.toLowerCase() as Hex);
const quantity = z.string().regex(/^0x[0-9a-fA-F]+$/);
const log = z.object({ address, topics: z.array(hash), data: bytes });
export type TraceLog = z.infer<typeof log>;
export interface CallFrame {
  type: string; from: Hex; to?: Hex; input: Hex; value?: string; error?: string;
  calls?: CallFrame[]; logs?: (TraceLog & { position?: number })[];
}
const frame: z.ZodType<CallFrame> = z.lazy(() => z.object({
  type: z.string(), from: address, to: address.optional(), input: bytes.default('0x'), value: quantity.optional(), error: z.string().optional(),
  calls: z.array(frame).optional(), logs: z.array(log.extend({ position: z.number().int().nonnegative().optional() })).optional(),
}));
const authorization = z.object({ chainId: quantity, address, nonce: quantity, yParity: quantity, r: quantity, s: quantity });
/** Signature recovery is shared by raw protocol ingest and 043; application remains unknown. */
export async function decodeAuthorization(a: z.infer<typeof authorization>, chainId: number) {
  let authority: Hex | null = null;
  try {
    // Bigint avoids nonce/chain coercion. Signature validity does not prove authorization was applied.
    const chain = BigInt(a.chainId), nonce = BigInt(a.nonce), yParity = BigInt(a.yParity);
    const order = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
    if (yParity !== 0n && yParity !== 1n || nonce >= 2n ** 64n || chain >= 2n ** 256n || BigInt(a.s) > order / 2n) throw new Error('Invalid authorization');
    const digest = keccak256(concatHex(['0x05', toRlp([chain === 0n ? '0x' : toHex(chain), a.address, nonce === 0n ? '0x' : toHex(nonce)])]));
    authority = (await recoverAddress({ hash: digest, signature: { yParity: Number(yParity), r: toHex(BigInt(a.r), { size: 32 }), s: toHex(BigInt(a.s), { size: 32 }) } })).toLowerCase() as Hex;
  } catch { /* Invalid authorization remains explicit; never an account-control link. */ }
  return { authority, implementation: a.address, chainId: BigInt(a.chainId).toString(), nonce: BigInt(a.nonce).toString(), signatureValid: authority !== null && (BigInt(a.chainId) === 0n || BigInt(a.chainId) === BigInt(chainId)), effective: 'unknown' as const };
}
const transaction = z.object({ hash, from: address, to: address.nullable(), input: bytes, value: quantity, transactionIndex: quantity,
  blockHash: hash, blockNumber: quantity, authorizationList: z.array(authorization).optional() });
const blockSchema = z.object({ hash, number: quantity, timestamp: quantity, transactions: z.array(transaction) });
const receiptSchema = z.object({ transactionHash: hash, blockHash: hash, blockNumber: quantity, transactionIndex: quantity,
  status: z.enum(['0x0', '0x1']), logs: z.array(log.extend({ logIndex: quantity, transactionHash: hash, removed: z.boolean().optional() })) });
export interface TraceFrame { path: string; parent: string | null; call: CallFrame; context: Hex | null; ordinal: number; endOrdinal: number; successful: boolean }
export interface BoundTraceLog extends TraceLog { logIndex: number; path: string; ordinal: number }
export interface AcquiredTraceTransaction {
  cursor: GuardCursor;
  transaction: z.infer<typeof transaction>; receipt: z.infer<typeof receiptSchema>; frames: TraceFrame[]; logs: BoundTraceLog[];
  bindingStatus: 'complete' | 'unsupported' | 'unreconciled';
  authorizations: { authority: Hex | null; implementation: Hex; chainId: string; nonce: string; signatureValid: boolean; effective: 'unknown' }[];
}
export type AcquiredTraceBlock = { cursor: GuardCursor; status: 'complete'; transactions: AcquiredTraceTransaction[]; raw: unknown[] }
  | { cursor: GuardCursor; status: 'missing' | 'unsupported' | 'unreconciled'; transactions: []; raw: unknown[] };

/** Merge call entry/exit and positioned logs numerically. Trace path strings never order execution. */
export function bindCallTrace(root: CallFrame, receipt: z.infer<typeof receiptSchema>) {
  const frames: TraceFrame[] = [], logs: Omit<BoundTraceLog, 'logIndex'>[] = [];
  let ordinal = 0, supported = true;
  function visit(call: CallFrame, path: string, parent: TraceFrame | null) {
    const successful = receipt.status === '0x1' && !call.error && (parent?.successful ?? true);
    const context = /^(DELEGATECALL|CALLCODE)$/.test(call.type) ? parent?.context ?? null : call.to ?? null;
    const current: TraceFrame = { call, path, parent: parent?.path ?? null, context, ordinal: ordinal++, endOrdinal: 0, successful };
    frames.push(current);
    const children = call.calls ?? [], ownLogs = call.logs ?? [];
    if (successful && ownLogs.some(l => l.position === undefined || l.position > children.length)) supported = false;
    for (let i = 0; i <= children.length; i++) {
      for (const l of ownLogs.filter(l => l.position === i)) {
        if (successful) { if (l.address !== context) supported = false; logs.push({ address: l.address, topics: l.topics, data: l.data, path, ordinal: ordinal++ }); }
      }
      if (i < children.length) visit(children[i], `${path}.${i}`, current);
    }
    current.endOrdinal = ordinal++;
  }
  visit(root, '0', null);
  const actual = receipt.logs;
  const matches = supported && logs.length === actual.length && logs.every((l, i) =>
    l.address === actual[i].address && l.data === actual[i].data && JSON.stringify(l.topics) === JSON.stringify(actual[i].topics) && !actual[i].removed);
  return { frames, logs: matches ? logs.map((l, i) => ({ ...l, logIndex: Number(BigInt(actual[i].logIndex)) })) : [],
    bindingStatus: (!supported ? 'unsupported' : matches ? 'complete' : 'unreconciled') as AcquiredTraceTransaction['bindingStatus'] };
}

/** Bounded shared acquisition; no background work, transport construction, or per-token trace requests. */
export class TraceAcquisition {
  private readonly blocks = new Map<string, Promise<AcquiredTraceBlock>>();
  constructor(private readonly clients: Pick<ReturnType<typeof createMeteredClients>, 'archive'>, private readonly maxBlocks = 64) {
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) throw new Error('Invalid trace cache bound');
  }
  acquire(input: GuardCursor): Promise<AcquiredTraceBlock> {
    const cursor = GuardCursorSchema.parse(input);
    if (cursor.boundary !== 'block_end') throw new Error('Trace acquisition requires completed block-end state');
    if (this.clients.archive.chain && this.clients.archive.chain.id !== cursor.chainId) throw new Error('Trace acquisition chain mismatch');
    const key = `${cursor.chainId}:${cursor.blockHash.toLowerCase()}`;
    const existing = this.blocks.get(key);
    if (existing) return existing.then(b => { if (JSON.stringify(b.cursor) !== JSON.stringify(cursor)) throw new Error('Trace cache cursor mismatch'); return b; });
    // Never evict in-flight work: bounded admission prevents duplicate acquisition under load.
    if (this.blocks.size >= this.maxBlocks) throw new Error('Trace cache full; release a completed block before acquisition');
    const pending = this.fetch(cursor); this.blocks.set(key, pending); return pending;
  }
  async release(cursor: GuardCursor) {
    const key = `${cursor.chainId}:${cursor.blockHash.toLowerCase()}`;
    const pending = this.blocks.get(key); if (pending) { await pending.catch(() => undefined); this.blocks.delete(key); }
  }
  private async fetch(cursor: GuardCursor): Promise<AcquiredTraceBlock> {
    const raw: unknown[] = [];
    const request = (method: string, params: readonly unknown[]) => this.clients.archive.request({ method, params } as never);
    try {
      const number = `0x${BigInt(cursor.blockNumber).toString(16)}`;
      const results = await Promise.allSettled([
        request('eth_getBlockByNumber', [number, true]), request('eth_getBlockReceipts', [cursor.blockHash]),
        request('debug_traceBlockByNumber', [number, { tracer: 'callTracer', tracerConfig: { withLog: true } }]),
      ]);
      for (const r of results) { if (r.status === 'rejected') throw r.reason; raw.push(r.value); }
      const block = blockSchema.parse(raw[0]), receipts = z.array(receiptSchema).parse(raw[1]);
      const traces = z.array(z.object({ txHash: hash, result: frame })).parse(raw[2]);
      // Number-addressed traces need a post-acquisition canonical hash check; no mixed-fork result survives.
      const end = z.object({ hash }).parse(await request('eth_getBlockByNumber', [number, false])); raw.push(end);
      if (block.hash !== cursor.blockHash.toLowerCase() || end.hash !== block.hash || BigInt(block.number) !== BigInt(cursor.blockNumber) || BigInt(block.timestamp) !== BigInt(cursor.timestampSec)) throw new Error('Trace block mismatch');
      if (receipts.length !== block.transactions.length || traces.length !== block.transactions.length) throw new Error('Trace transaction coverage mismatch');
      const transactions: AcquiredTraceTransaction[] = [];
      for (const [index, tx] of block.transactions.entries()) {
        const rs = receipts.filter(r => r.transactionHash === tx.hash), ts = traces.filter(t => t.txHash === tx.hash);
        if (rs.length !== 1 || ts.length !== 1 || tx.blockHash !== block.hash || rs[0].blockHash !== block.hash || BigInt(tx.transactionIndex) !== BigInt(index) || BigInt(rs[0].transactionIndex) !== BigInt(index) || BigInt(tx.blockNumber) !== BigInt(block.number) || BigInt(rs[0].blockNumber) !== BigInt(block.number)) throw new Error('Trace transaction mismatch');
        const root = ts[0].result;
        if (root.from !== tx.from || (root.to ?? null) !== tx.to || root.input !== tx.input || BigInt(root.value ?? '0x0') !== BigInt(tx.value) || rs[0].logs.some(l => l.transactionHash !== tx.hash)) throw new Error('Trace input mismatch');
        const authorizations: AcquiredTraceTransaction['authorizations'] = [];
        for (const a of tx.authorizationList ?? []) {
          authorizations.push(await decodeAuthorization(a, cursor.chainId));
        }
        transactions.push({ cursor, transaction: tx, receipt: rs[0], ...bindCallTrace(root, rs[0]), authorizations });
      }
      return { cursor, status: 'complete', transactions, raw };
    } catch (error) {
      if (rpcStopReason(error)) throw error;
      return { cursor, status: error instanceof z.ZodError ? 'unsupported' : raw.length < 3 ? 'missing' : 'unreconciled', transactions: [], raw };
    }
  }
}
