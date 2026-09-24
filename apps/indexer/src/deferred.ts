import { binary, hex, refreshBars, type ChainDb } from '@eko/db';
import type { AddressRegistry } from '@eko/chain';
import { toHex, type Hex } from 'viem';
import { lower, native } from './clients.js';
import { BlockDecoder, type RemoteInputs } from './decode.js';
import { loadSenderScope } from './sender-scope.js';
import { BlockRows } from './rows.js';
import { log, type ChainClient, type Logger, type RpcBlock, type RpcLog, type RpcReceipt } from './types.js';

interface Deferred { block: string; tx_hash: Uint8Array; log_index: number; emitter: Uint8Array; data: RpcLog & { blockTimestamp?: Hex }; hash: Uint8Array | null; ts: Date | null }
/** Stored events materialized per step: a step runs between two ticks of the head, which waits for it. */
export const DEFERRED_BATCH = 500;
/** Seconds the stored tokens and pools are reused across steps (a newly discovered pool reloads them at once). */
const SCOPE_SEC = 60;
/** Seconds between steps once nothing is left (a newly discovered pool ends the wait). */
const IDLE_SEC = 120;

/**
 * Turns the stored raw events of pools that have since become known into swaps and liquidity events. The head
 * follower stores an event of a pool it does not know as a raw log (pending_pool_events); once the pool is known
 * (discovered at the head from the canonical factory, or by an enrichment) its earlier events stayed raw, so a coin
 * trading in such a pool had no history (2026-10-13: 239,000 events of 156 known pools, 912,000 in all).
 * No chain read: the raw log, the pool row and the stored tokens decode it. The rows are written as the head writes
 * them for a pool outside the sender scope without the transaction's transfers: no trader (the worker names it from
 * stored transfers where there are any, or the v3 event's own recipient stands), ETH-quoted swaps unpriced (the
 * worker prices them). Only events deeper than the reorg depth are taken, and only when the stored block hash, where
 * there is one, is the log's. A log whose block is missing its time is left as it is.
 */
export class DeferredEvents {
  private readonly decoder: BlockDecoder;
  /** The pool being worked through, and the block below which its stored events have been read and left (not convertible). */
  private at?: { emitter: Uint8Array; block: string };
  private idleUntil = 0;
  private scope?: { at: number; value: Awaited<ReturnType<typeof loadSenderScope>> };
  constructor(private readonly db: ChainDb, client: ChainClient, private readonly registry: AddressRegistry, private readonly options: { reorgDepth: number; batch?: number; logger?: Logger; now?: () => number }) {
    // Its own decoder: nothing here may touch the head follower's caches.
    this.decoder = new BlockDecoder(client, registry);
    this.decoder.storeWalletProtocol = false;
  }
  /** A pool became known: look again at once. */
  wake() { this.idleUntil = 0; this.at = undefined; this.scope = undefined; }
  /** One bounded batch; returns the events written as rows. Errors are the caller's to log: the head must not stop for them. */
  async step(): Promise<number> {
    const now = (this.options.now ?? Date.now)();
    if (now < this.idleUntil) return 0;
    const head = await this.db.cursor('head');
    if (head == null) return 0;
    const limit = this.options.batch ?? DEFERRED_BATCH, settled = (head - BigInt(this.options.reorgDepth)).toString();
    // One pool at a time, by the (emitter, block) index: the next known pool with stored events, then its oldest ones.
    // One statement over every pool at once sorted all of them on each step (six seconds for 362,000 rows, 2026-10-13),
    // and a step runs between two ticks of the head.
    const pool = (await this.db.sql.query<{ id: Uint8Array }>(`SELECT p.id FROM pools p WHERE p.venue='uniswap_v3' AND ($2::bytea IS NULL OR p.id>=$2)
        AND EXISTS(SELECT 1 FROM pending_pool_events e WHERE e.emitter=p.id AND e.block<=$1::bigint AND (p.id IS DISTINCT FROM $2 OR e.block>$3::bigint))
      ORDER BY p.id LIMIT 1`, [settled, this.at?.emitter ?? null, this.at?.block ?? '-1'])).rows[0];
    if (!pool) { this.at = undefined; this.idleUntil = now + IDLE_SEC * 1000; return 0; }
    const from = this.at && hex(this.at.emitter) === hex(pool.id) ? this.at.block : '-1';
    const rows = (await this.db.sql.query<Deferred>(`SELECT e.block::text,e.tx_hash,e.log_index,e.emitter,e.data,b.hash,b.ts FROM pending_pool_events e
      LEFT JOIN chain_blocks b ON b.number=e.block WHERE e.emitter=$1 AND e.block>$2::bigint AND e.block<=$3::bigint ORDER BY e.block LIMIT $4`, [pool.id, from, settled, limit])).rows;
    if (!rows.length) { this.at = { emitter: pool.id, block: settled }; return 0; }
    // Whole blocks only: a block cut by the limit is read again with the next batch (unless it is the only one).
    const lastBlock = rows.at(-1)!.block;
    if (rows.length === limit && rows[0].block !== lastBlock) while (rows.at(-1)!.block === lastBlock) rows.pop();
    // Events converted below are deleted; any left behind (a block without a time, a hash that differs) are passed over.
    this.at = { emitter: pool.id, block: rows.at(-1)!.block };
    if (!this.scope || now - this.scope.at >= SCOPE_SEC * 1000) this.scope = { at: now, value: await loadSenderScope(this.db) };
    const scope = this.scope.value;
    const blocks = new Map<string, { time: Hex; hash: Hex; logs: RpcLog[]; keys: Deferred[] }>();
    for (const row of rows) {
      const raw = row.data, stored = row.hash ? hex(row.hash) : null;
      if (!raw?.topics?.length || !raw.blockHash || (stored && stored !== lower(raw.blockHash))) continue;
      const time = raw.blockTimestamp && BigInt(raw.blockTimestamp) > 0n ? raw.blockTimestamp : row.ts ? toHex(BigInt(Math.floor(new Date(row.ts).getTime() / 1000))) : null;
      if (!time) continue;
      const entry = blocks.get(row.block) ?? { time, hash: raw.blockHash, logs: [], keys: [] };
      if (lower(entry.hash) !== lower(raw.blockHash)) continue;
      const { blockTimestamp: _time, ...event } = raw as RpcLog & { blockTimestamp?: Hex; currencyHints?: string[] };
      entry.logs.push({ ...event, blockTimestamp: time } as RpcLog); entry.keys.push(row); blocks.set(row.block, entry);
    }
    const batch = new BlockRows(), done: Deferred[] = [];
    for (const [number, entry] of [...blocks].sort((a, b) => BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)) {
      const hashes = [...new Set(entry.logs.map(l => lower(l.transactionHash)))];
      const receipts: RpcReceipt[] = hashes.map(hash => ({ transactionHash: hash, blockHash: entry.hash, blockNumber: toHex(BigInt(number)), logs: entry.logs.filter(l => lower(l.transactionHash) === hash), from: native, to: null, synthetic: true }));
      const block: RpcBlock = { number: toHex(BigInt(number)), hash: entry.hash, parentHash: '0x', timestamp: entry.time, transactionsComplete: false,
        transactions: receipts.map(r => ({ hash: r.transactionHash, from: native, to: null })) };
      const narrowed = this.decoder.scopeForBlock(scope, entry.logs).scope;
      // Every input comes from stored rows: no code, metadata, pool or price read.
      const remote: RemoteInputs = { codes: new Map(), codeBlocks: new Map(), metadata: new Map(), pools: new Map(), rate: null };
      const state = await this.decoder.prepare(this.db, block, receipts, { remote, scope: narrowed, tokenRows: narrowed.tokenRows, poolRows: narrowed.poolRows });
      // A log whose pool the scope still does not hold would only be stored raw again: left as it is.
      const known = entry.keys.filter(key => state.pools.has(hex(key.emitter)));
      if (!known.length) continue;
      const wanted = new Set(known.map(key => `${hex(key.tx_hash)}:${key.log_index}`));
      const filtered = receipts.map(r => ({ ...r, logs: r.logs.filter(l => wanted.has(`${lower(l.transactionHash)}:${Number(BigInt(l.logIndex))}`)) })).filter(r => r.logs.length);
      batch.merge(this.decoder.collect(block, filtered, state));
      done.push(...known);
    }
    if (!done.length) return 0;
    for (const date of new Set(batch.get('swaps').map(row => (row.ts as Date).toISOString().slice(0, 10)))) await this.db.ensurePartitions(new Date(`${date}T00:00:00Z`));
    await this.db.tx(async tx => {
      // Old trades are not news: no notices (the API reads each swap notice as a trade that just happened).
      await batch.flush(tx, undefined, { notify: false });
      for (let offset = 0; offset < done.length; offset += 500) {
        const params: unknown[] = [];
        const values = done.slice(offset, offset + 500).map(key => { params.push(key.tx_hash, key.log_index); return `($${params.length - 1}::bytea,$${params.length}::integer)`; });
        await tx.sql.query(`DELETE FROM pending_pool_events e USING (VALUES ${values.join(',')}) AS k(tx_hash,log_index) WHERE e.tx_hash=k.tx_hash AND e.log_index=k.log_index`, params);
      }
      const priced = batch.get('swaps').filter(row => row.usd != null);
      if (priced.length) await refreshBars(tx, priced.map(row => ({ coin: row.coin as Uint8Array, minute: new Date(Math.floor(new Date(row.ts as Date).getTime() / 60000) * 60000) })));
    },{retry:true});
    (this.options.logger ?? log)('deferred_events_materialized', { events: done.length, swaps: batch.get('swaps').length, liquidity: batch.get('liquidity_events').length, read: rows.length });
    return done.length;
  }
}
