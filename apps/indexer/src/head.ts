import { loadSenderScope } from './sender-scope.js';
import { rpcStopReason, isTransientRpcUnavailable, backoffDelay } from '@eko/chain';
import { safeError } from './safe-error.js';
import { retryableTransaction, PartitionLockTimeoutError, binary, type ChainDb } from '@eko/db';
import type { BlockDecoder, RemoteInputs } from './decode.js';
import { log, type ChainClient, type Logger, type RpcBlock, type RpcReceipt } from './types.js';
import { lower } from './clients.js';
export class BlockQueue {
  private target: bigint; private nextBlock: bigint; private wake: (() => void) | null = null; private stopped = false;
  constructor(first: bigint) { this.nextBlock = first; this.target = first - 1n; }
  upTo(n: bigint) { if (n > this.target) this.target = n; this.wake?.(); }
  reset(first: bigint, target?: bigint) { this.nextBlock = first; if (target != null) this.target = target; this.wake?.(); }
  stop() { this.stopped = true; this.wake?.(); }
  async next(): Promise<bigint | null> {
    while (!this.stopped && this.nextBlock > this.target) await new Promise<void>(resolve => { this.wake = resolve; });
    this.wake = null;
    if (this.stopped) return null;
    return this.nextBlock++;
  }
}
type FetchResult = { ok: true; block: RpcBlock; receipts: RpcReceipt[]; remote: RemoteInputs } | { ok: false; error: unknown };
/** Completed results still occupy the window until applied, bounding memory as well as RPC concurrency. */
export class BlockPrefetch {
  private pending = new Map<bigint, Promise<FetchResult>>();
  private target: bigint; private nextBlock: bigint; private stopped = false;
  constructor(private client: ChainClient, private decoder: BlockDecoder, first: bigint, readonly size = 32, private db?: ChainDb) {
    if (!Number.isInteger(size) || size < 1 || size > 128) throw new Error('Invalid prefetch window');
    this.target = first - 1n; this.nextBlock = first;
  }
  upTo(n: bigint) { if (n > this.target) this.target = n; this.fill(); }
  private fetch(n: bigint): Promise<FetchResult> {
    return (async (): Promise<FetchResult> => {
      const reads = await Promise.allSettled([this.client.block(n), this.client.receipts(n)] as const);
      const guard = reads.find(r => r.status === 'rejected' && rpcStopReason(r.reason));
      if (guard?.status === 'rejected') throw guard.reason;
      const [blockRead, receiptRead] = reads;
      if (blockRead.status === 'rejected') throw blockRead.reason;
      if (receiptRead.status === 'rejected') throw receiptRead.reason;
      const block = blockRead.value, receipts = receiptRead.value;
      if (!block || BigInt(block.number) !== n) throw new Error('RPC returned wrong block number');
      return { ok: true, block, receipts, remote: await this.decoder.prefetch(block, receipts,{...(this.db?{scope:await loadSenderScope(this.db)}:{})}) };
    })().catch(error => ({ ok: false, error }));
  }

  private fill() {
    while (!this.stopped && this.pending.size < this.size && this.nextBlock <= this.target) {
      const n = this.nextBlock++; this.pending.set(n, this.fetch(n));
    }
  }
  async get(n: bigint) {
    const pending = this.pending.get(n); if (!pending) throw new Error('Block outside prefetch window');
    const result = await pending; if (!result.ok) throw result.error; return result;
  }
  retry(n: bigint) { this.pending.set(n, this.fetch(n)); }
  applied(n: bigint) { this.pending.delete(n); this.fill(); }
  async reset(first: bigint, target = this.target) {
    // Drain discarded reads before replacing the window: old requests cannot mutate caches after invalidation.
    this.stopped = true; await Promise.all(this.pending.values()); this.pending.clear();
    this.decoder.invalidate(); this.nextBlock = first; this.target = target; this.stopped = false; this.fill();
  }
  stop() { this.stopped = true; }
  async drain() { this.stop(); await Promise.all(this.pending.values()); this.pending.clear(); }
}
export class ReorgDepthError extends Error {}
export class HeadFollower {
  private prefetch?: BlockPrefetch;
  private queue: BlockQueue | null = null; private stopRequested = false;
  private wakeRetry?: () => void;
  /**
   * Retain full-block provider/decoder/storage and reorg/start/prefetch options. Indexer operator
   * construction only; no I/O or validation occurs until lifecycle methods.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  constructor(readonly client: ChainClient, readonly db: ChainDb, readonly decoder: BlockDecoder, readonly options: { startBlock?: bigint; prefetchBlocks?: number; reorgDepth: number; logger?: Logger;
    /** Watchdog hooks: announced chain heads and committed blocks. */
    onHead?: (head: bigint) => void; onProgress?: (block: bigint) => void; random?: () => number }) {}
  private get logger() { return this.options.logger ?? log; }
  /**
   * Require RPC chain id 4663 before running full-block ingest. Indexer operator configures the
   * provider; no wallet auth. Wrong chain or RPC failure rejects.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async assertChain() { if (await this.client.chainId() !== 4663) throw new Error('RPC chain ID must be 4663'); }
  /**
   * Request stop and wake/stop queue and prefetch scheduling. Host lifecycle only; does not undo
   * committed ingest or cancel already running provider calls.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  stop() { this.stopRequested = true; this.queue?.stop(); this.prefetch?.stop(); this.wakeRetry?.(); }
  /**
   * Search backward within configured reorg depth for a stored canonical ancestor, transactionally
   * delete chain data above it/reset cursor and invalidate decoder caches. Indexer role only;
   * RPC/SQL failure or no retained ancestor throws, including ReorgDepthError. Return first
   * replacement block.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async rollback(from: bigint): Promise<bigint> {
    for (let depth = 0, n = from; depth < this.options.reorgDepth && n >= 0n; depth++, n--) {
      const block = await this.client.block(n);
      if (await this.db.blockHash(n) !== lower(block.hash)) continue;
      await this.db.tx(async tx => {
        await tx.deleteAbove(n);
        await tx.setCursor('head', n, block.hash);
        await tx.notify('chain_reorg', { fromBlock: (n + 1n).toString() });
      });
      this.decoder.invalidate();
      this.logger('chain_reorg', { fromBlock: (n + 1n).toString() });
      return n + 1n;
    }
    this.logger('alert', { reason: 'reorg_depth_exceeded', depth: this.options.reorgDepth });
    throw new ReorgDepthError('Reorg exceeds INDEX_REORG_DEPTH; indexer halted');
  }
  /**
   * Check parent/stored block conflicts and full receipt/log consistency before atomic decoder
   * writes/cursor notification. Indexer role supplies acquired block/receipts; conflicts return
   * false, inconsistent data or prepare/SQL failure rejects. Decoder caches advance only after
   * commit.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async ingest(block: RpcBlock, receipts: RpcReceipt[], remote?: RemoteInputs): Promise<boolean> {
    const n = BigInt(block.number);
    const stored = n > 0n ? await this.db.blockHash(n - 1n) : null;
    if (stored && stored !== lower(block.parentHash)) return false;
    const existing = await this.db.blockHash(n);
    if (existing && existing !== lower(block.hash)) return false;
    if (receipts.length !== block.transactions.length || new Set(receipts.map(r => lower(r.transactionHash))).size !== receipts.length || receipts.some(r => lower(r.blockHash) !== lower(block.hash) || BigInt(r.blockNumber) !== n || r.logs.some(l => l.removed || lower(l.blockHash) !== lower(block.hash) || BigInt(l.blockNumber) !== n || lower(l.transactionHash) !== lower(r.transactionHash)))) throw new Error('Inconsistent full block/receipts; retry canonical block');
    const prepared = await this.decoder.prepare(this.db, block, receipts, { remote });
    await this.db.ensurePartitions(new Date(Number(BigInt(block.timestamp)) * 1000));
    await this.db.tx(async tx => {
      const inserted = await tx.insert('chain_blocks', { number: n.toString(), block: n.toString(), hash: binary(block.hash), parent_hash: binary(block.parentHash), ts: new Date(Number(BigInt(block.timestamp)) * 1000) });
      await this.decoder.write(tx, block, receipts, prepared, { transfers: true });
      const cursor = await tx.cursor('head');
      if (cursor == null || n >= cursor) await tx.setCursor('head', n, block.hash);
      if (inserted) await tx.notify('chain_block', { n: n.toString() });
    },{retry:true});
    this.decoder.committed(prepared);
    this.decoder.metrics.observe(block.timestamp);
    return true;
  }
  /**
   * Assert chain, recover cursor/reorg state, follow head with bounded prefetch and retries, commit
   * in block order and drain on stop. Indexer operator only; deep reorg, exhausted retries or RPC
   * budget/SQL failures reject. Defaults to current head when no start/cursor is configured.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async run() {
    await this.assertChain();
    const cursor = await this.db.cursor('head');
    const initialHead = await this.client.head();
    const first = cursor == null ? this.options.startBlock ?? initialHead : cursor + 1n;
    this.queue = new BlockQueue(first);
    // No implicit history: the current head is the default, while an explicit start (including zero) overrides it.
    if (cursor == null && first > 0n) {
      const anchor = await (this.client.header?.(first - 1n) ?? this.client.block(first - 1n));
      await this.db.insert('chain_blocks', { number: BigInt(anchor.number).toString(), block: BigInt(anchor.number).toString(), hash: binary(anchor.hash), parent_hash: binary(anchor.parentHash), ts: new Date(Number(BigInt(anchor.timestamp)) * 1000) });
    }
    if (cursor != null && await this.db.blockHash(cursor) !== lower((await this.client.block(cursor)).hash)) this.queue.reset(await this.rollback(cursor));
    const next = await this.db.cursor('head');
    const prefetch = new BlockPrefetch(this.client, this.decoder, next == null ? first : next + 1n, this.options.prefetchBlocks ?? 32,this.db);
    this.prefetch = prefetch;
    let guardError: unknown;
    const stopGuard = (error: unknown) => {
      if (!rpcStopReason(error) && !this.client.rpcStopped?.()) return false;
      guardError ??= error; this.stop(); return true;
    };
    let latestHead = initialHead; let sampling = false; let sampled: bigint | null = null;
    let headTimeUnavailable = false; let appliedTimestamp: RpcBlock['timestamp'] | null = null;
    const sampleHead = async () => {
      if (sampling || this.stopRequested || latestHead === sampled) return;
      sampling = true;
      const n = latestHead;
      let lastError: unknown;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            // A newHeads notification can precede the HTTP backend seeing that block.
            const block = await (this.client.header?.(n) ?? this.client.block(n));
            if (!block || BigInt(block.number) !== n || !block.timestamp) throw new Error('Head header not available yet');
            this.decoder.metrics.setHead(block.timestamp); sampled = n; headTimeUnavailable = false;
            return;
          } catch (error) {
            if (stopGuard(error) || this.stopRequested || this.client.rpcStopped?.()) return;
            lastError = error;
            if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        headTimeUnavailable = true;
        if (appliedTimestamp) this.decoder.metrics.setHead(appliedTimestamp);
        this.logger('head_time_error', { reason: 'header_unavailable_after_retry', fallback: 'applied_block', error: safeError(lastError) });
      } finally { sampling = false; }
    };
    const announce = (n: bigint) => {
      if (this.stopRequested || this.client.rpcStopped?.() || n < latestHead) return;
      latestHead = n; this.options.onHead?.(n); this.queue!.upTo(n); prefetch.upTo(n); void sampleHead();
    };
    const unwatch = this.client.watch?.(announce, error => {
      if ((rpcStopReason(error) === 'rpc_session_budget_reached' || this.client.rpcStopped?.()) && stopGuard(error)) return;
      this.logger('head_ws_error', { backstop: true, error: safeError(error) });
    });
    let polling = false;
    const poll = async () => {
      if (polling || this.stopRequested) return;
      polling = true;
      try { announce(await this.client.head()); } catch (error) { if (!stopGuard(error) && !this.stopRequested) this.logger('head_poll_error', { error: safeError(error) }); }
      finally { polling = false; }
    };
    const timer = setInterval(() => { void poll(); }, 250);
    try {
      announce(initialHead); await sampleHead();
      while (!this.stopRequested) {
        const n = await this.queue.next(); if (n == null) break;
        let committed = false;
        // Three attempts for ordinary failures; transient provider outages keep backing off (the watchdog bounds them).
        for (let attempt = 1, outages = 0; !committed; attempt++) {
          try {
            const { block, receipts, remote } = await prefetch.get(n);
            if (headTimeUnavailable) this.decoder.metrics.setHead(block.timestamp);
            if (!await this.ingest(block, receipts, remote)) {
              const firstCanonical = await this.rollback(await this.db.blockHash(n) ? n : n - 1n);
              const canonicalHead = await this.client.head();
              await prefetch.reset(firstCanonical, canonicalHead); this.queue.reset(firstCanonical, canonicalHead); break;
            }
            appliedTimestamp = block.timestamp;
            committed = true; this.options.onProgress?.(n); if (this.stopRequested) prefetch.stop(); prefetch.applied(n);
          } catch (error) {
            if (rpcStopReason(error)) { this.stop(); throw error; }
            if (this.stopRequested) break;
            if (this.client.rpcStopped?.()) { this.stop(); throw error; }
            this.db.recordTransactionSkip(error);
            const outage = isTransientRpcUnavailable(error) || error instanceof PartitionLockTimeoutError || retryableTransaction(error);
            if (error instanceof ReorgDepthError || (attempt >= 3 && !outage)) throw error;
            const delay = outage ? backoffDelay(outages++, this.options.random, 1000, 60_000) : attempt * 250;
            this.logger('block_retry', { n: n.toString(), attempt, backoff_ms: Math.round(delay), error: safeError(error) });
            await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); this.wakeRetry = () => { clearTimeout(timer); resolve(); }; });
            this.wakeRetry = undefined;
            if (this.stopRequested) break;
            if (this.client.rpcStopped?.()) { this.stop(); throw error; }
            prefetch.retry(n);
          }
        }
      }
    } finally { clearInterval(timer); unwatch?.(); this.queue.stop(); await prefetch.drain(); }
    if (guardError) throw guardError;
  }
}
