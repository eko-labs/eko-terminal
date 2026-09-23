import { TransactionRetryExhaustedError } from '@eko/db';
import { loadSenderScope, extendSenderScope, needsSender, type SenderScope } from './sender-scope.js';
import { safeError } from './safe-error.js';
import { createHash, randomUUID } from 'node:crypto';
import { rpcStopReason, ponsFactoryAbi, ponsCurveAbi, v3Abi, v4Abi, erc20Abi, wethAbi } from '@eko/chain';
import { PartitionLockTimeoutError, hex, type ChainDb } from '@eko/db';
import { toEventSelector, type Address, type Hex } from 'viem';
import { lower, native } from './clients.js';
import { type BlockDecoder } from './decode.js';
import { budgetedQueries, MAX_LOG_ADDRESSES, type LogFilter } from './log-budget.js';
import { Semaphore } from './concurrency.js';
import { BlockRows } from './rows.js';
import { log, type ChainClient, type Logger, type RpcLog, type RpcBlock, type RpcReceipt } from './types.js';
export type Stream = 'logs:pons_factory' | 'logs:pons_curves' | 'logs:pools' | 'logs:pair_swaps' | 'logs:holders';
type LeaseStream = Stream | `logs:pair_swaps:${string}` | `logs:holders:${string}`;
export interface Range { stream: LeaseStream; from_block: string; to_block: string; attempts: number; lease_owner: string; last_error: string | null; error_repeats: number }
export const isRangeLimit = (error: unknown) => /logs matched by query exceeds limit of 10000|HTTP response body exceeded the size limit|too many results|range over 100000 blocks is not supported|eth_getLogs.*limited to 200000 addresses x blocks/i.test(safeError(error));
export class AdaptiveWindow {
  size: number;
  constructor(initial = 2000) { this.size = Math.min(20000, Math.max(1, initial)); }
  failure(error: unknown): boolean { if (!isRangeLimit(error) || this.size === 1) return false; this.size = Math.max(1, Math.floor(this.size / 2)); return true; }
  success() { this.size = Math.min(20000, this.size * 2); }
}
export class RangeLeases {
  // Three identical failures retire a range; nine claims bound changing errors/crashes.
  /**
   * Retain database and retry bound for indexer range claims. Host construction only, no database
   * work or auth; maxAttempts is not validated here.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  constructor(readonly db: ChainDb, readonly maxAttempts = 3) {}
  /**
   * Serialize planners and insert missing bounded ingest ranges without duplicating covered
   * intervals. Indexer role only; invalid interval or SQL failure rejects.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async seed(stream: LeaseStream, from: bigint, to: bigint) {
    if (from < 0n || to < from) throw new Error('Invalid backfill interval');
    await this.db.tx(async tx => {
      // Serialize planners, while claims themselves use SKIP LOCKED and do not take this lock.
      await tx.sql.query('LOCK TABLE ingest_ranges IN SHARE ROW EXCLUSIVE MODE');
      const rows = await tx.sql.query<{ from_block: string; to_block: string }>('SELECT from_block,to_block FROM ingest_ranges WHERE stream=$1 AND from_block <= $3 AND to_block >= $2 ORDER BY from_block', [stream, from.toString(), to.toString()]);
      let next = from;
      const add = async (end: bigint) => {
        while (next <= end) {
          const last = next + 19999n < end ? next + 19999n : end;
          await tx.sql.query('INSERT INTO ingest_ranges(stream,from_block,to_block) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [stream, next.toString(), last.toString()]);
          next = last + 1n;
        }
      };
      for (const r of rows.rows) {
        await add(BigInt(r.from_block) - 1n);
        if (BigInt(r.to_block) >= next) next = BigInt(r.to_block) + 1n;
      }
      await add(to);
    });
  }
  /**
   * Atomically claim an eligible scoped range with SKIP LOCKED, expiry and bounded attempts; return
   * null when no claim is available. Indexer worker supplies owner/scope; SQL failures reject and
   * exhausted expired leases are retired.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async claim(stream: LeaseStream, owner: string, from: bigint, to: bigint): Promise<Range | null> {
    await this.db.sql.query("UPDATE ingest_ranges SET status='failed',lease_owner=NULL,lease_until=NULL WHERE stream=$1 AND status='leased' AND lease_until<now() AND attempts >= $2", [stream, this.maxAttempts * 3]);
    const { rows } = await this.db.sql.query<Range>(`UPDATE ingest_ranges SET status='leased',lease_owner=$2,lease_until=now()+interval '5 minutes',attempts=attempts+1
      WHERE (stream,from_block) = (SELECT stream,from_block FROM ingest_ranges
      WHERE stream=$1 AND from_block <= $5 AND to_block >= $4 AND (status='todo' OR (error_repeats < $3 AND attempts < $3 * 3)) AND (status='todo' OR status='failed' OR (status='leased' AND lease_until < now()))
      ORDER BY CASE status WHEN 'leased' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,attempts,from_block FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [stream, owner, this.maxAttempts, from.toString(), to.toString()]);
    return rows[0] ? { ...rows[0], from_block: String(rows[0].from_block), to_block: String(rows[0].to_block) } : null;
  }
  /**
   * Extend only the matching live leased range using the supplied transaction/database. Indexer
   * lease owner only; lost/expired lease or SQL failure rejects.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async renew(range: Range, db = this.db) {
    const result = await db.sql.query("UPDATE ingest_ranges SET lease_until=now()+interval '5 minutes' WHERE stream=$1 AND from_block=$2 AND lease_owner=$3 AND status='leased' AND lease_until > now() RETURNING 1", [range.stream, range.from_block, range.lease_owner]);
    if (!result.rows.length) throw new Error('Backfill lease lost');
  }
  /**
   * Change the matching live leased range to the requested completion status and clear owner/error
   * state. Indexer lease owner only; lost lease or SQL failure rejects; caller must commit decoded
   * data before marking done.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async finish(db: ChainDb, range: Range, status: 'done' | 'failed' | 'todo') {
    const result = await db.sql.query('UPDATE ingest_ranges SET status=$4,lease_owner=NULL,lease_until=NULL,last_error=NULL,error_repeats=0 WHERE stream=$1 AND from_block=$2 AND lease_owner=$3 AND status=\'leased\' AND lease_until > now() RETURNING 1', [range.stream, range.from_block, range.lease_owner, status]);
    if (!result.rows.length) throw new Error('Backfill lease lost');
  }
  /**
   * Record bounded error text, increment consecutive identical failures and release only the
   * matching live lease. Indexer lease owner only; lost lease or SQL failure rejects and returns the
   * error-repeat count on success.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async fail(range: Range, error: unknown) {
    const reason = safeError(error);
    const result = await this.db.sql.query<{ error_repeats: number }>(`UPDATE ingest_ranges SET status='failed',lease_owner=NULL,lease_until=NULL,
      error_repeats=CASE WHEN last_error=$4 THEN error_repeats+1 ELSE 1 END,last_error=$4
      WHERE stream=$1 AND from_block=$2 AND lease_owner=$3 AND status='leased' AND lease_until>now() RETURNING error_repeats`,
    [range.stream,range.from_block,range.lease_owner,reason]);
    if (!result.rows.length) throw new Error('Backfill lease lost');
    return result.rows[0].error_repeats;
  }
}
export class BackfillFailedError extends Error {
  constructor(readonly count: number) { super(`Backfill completed with ${count} failed range(s)`); }
}
export class PonsBackfill {
  private stopping = false;
  private rpc: Semaphore;
  private filters: Omit<LogFilter, 'from' | 'to'>[] = [];
  /**
   * Wire decoder/storage/provider and initialize the bounded RPC semaphore. Indexer operator
   * construction only; invalid concurrency can throw through Semaphore; no ingest starts yet.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  constructor(readonly client: ChainClient, readonly db: ChainDb, readonly decoder: BlockDecoder, readonly options: { workers: number; logRange: number; concurrency?: number; logger?: Logger }) { this.rpc = new Semaphore(options.concurrency ?? 32); }
  /**
   * Request stopping at worker checkpoints. Indexer operator only; in-flight reads/transactions are
   * not synchronously cancelled.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  stop() { this.stopping = true; }
  /**
   * Require chain 4663 and requested stream prerequisites, seed target-scoped leases and ingest
   * canonical filtered receipts with adaptive bounded RPC work. Indexer operator controls
   * interval/stream. Provider budget/lease/consistency/SQL failures reject or record failed ranges;
   * any terminal failed ranges raise BackfillFailedError, not a complete result.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async run(stream: Stream, from: bigint, to: bigint) {
    if (await this.client.chainId() !== 4663) throw new Error('RPC chain ID must be 4663');
    const leases = new RangeLeases(this.db);
    if (stream === 'logs:pons_curves') {
      const { rows } = await this.db.sql.query<{ from_block: string; to_block: string }>("SELECT from_block,to_block FROM ingest_ranges WHERE stream='logs:pons_factory' AND status='done' AND from_block <= $2 AND to_block >= $1 ORDER BY from_block", [from.toString(), to.toString()]);
      let covered = from;
      for (const r of rows) { if (BigInt(r.from_block) > covered) break; if (BigInt(r.to_block) >= covered) covered = BigInt(r.to_block) + 1n; }
      if (covered <= to) throw new Error('Complete logs:pons_factory over the requested interval before logs:pons_curves');
    }
    if (stream === 'logs:pools') this.filters = [
      { topics: [toEventSelector(v3Abi[0])] },
      { address: this.decoder.registry.requireAddress('uniswapV4.poolManager'), topics: [toEventSelector(v4Abi.find(e => e.name === 'Initialize')!)] },
    ];
    if (stream === 'logs:pair_swaps') {
      const end = await (this.client.header?.(to) ?? this.client.block(to));
      const recent = await blockAtTime(this.client, BigInt(end.timestamp) - 7n * 86400n, to);
      const { rows } = await this.db.sql.query<{ id: Uint8Array; venue: string }>(`SELECT id,venue FROM pools WHERE
        (created_block BETWEEN $1 AND $2) OR id IN (SELECT graduated_pool FROM tokens WHERE graduated_pool IS NOT NULL AND graduated_block <= $2) ORDER BY id`, [recent.toString(),to.toString()]);
      const v3 = rows.filter(r => r.venue === 'uniswap_v3').map(r => hex(r.id) as Address);
      const v4 = rows.filter(r => r.venue === 'uniswap_v4').map(r => hex(r.id));
      this.filters = [];
      for (let i=0;i<v3.length;i+=MAX_LOG_ADDRESSES) this.filters.push({ addresses: v3.slice(i,i+MAX_LOG_ADDRESSES), topics: [toEventSelector(v3Abi.find(e => e.name === 'Swap')!)] });
      for (let i=0;i<v4.length;i+=MAX_LOG_ADDRESSES) this.filters.push({ address: this.decoder.registry.requireAddress('uniswapV4.poolManager'), topics: [], topicFilters: [toEventSelector(v4Abi.find(e => e.name === 'Swap')!),v4.slice(i,i+MAX_LOG_ADDRESSES)] });
    }
    if (stream === 'logs:holders') {
      const { rows } = await this.db.sql.query<{ address: Uint8Array }>('SELECT address FROM tokens ORDER BY address');
      const addresses = rows.map(r => hex(r.address) as Address);
      this.filters = [];
      for (let i=0;i<addresses.length;i+=MAX_LOG_ADDRESSES) this.filters.push({ addresses: addresses.slice(i,i+MAX_LOG_ADDRESSES), topics: [toEventSelector(erc20Abi[0]),...wethAbi.map(toEventSelector)] });
    }
    // A new target set must not reuse completion records for an older set.
    const leaseStream: LeaseStream = stream === 'logs:pair_swaps' || stream === 'logs:holders' ? `${stream}:${createHash('sha256').update(JSON.stringify(this.filters)).digest('hex').slice(0,16)}` : stream;
    await leases.seed(leaseStream, from, to);
    const results = await Promise.allSettled(Array.from({ length: this.options.workers }, async () => {
      const owner = `indexer-${randomUUID()}`; const window = new AdaptiveWindow(this.options.logRange);
      while (!this.stopping && !this.client.rpcStopped?.()) {
        const range = await leases.claim(leaseStream, owner, from, to);
        if (!range) {
          const result = await this.db.sql.query<{ status: string; attempts: number }>(`SELECT status,attempts FROM ingest_ranges WHERE stream=$1 AND from_block <= $3 AND to_block >= $2 AND (status='todo' OR status='leased' OR (status='failed' AND error_repeats < $4 AND attempts < $4 * 3))`, [leaseStream, from.toString(), to.toString(), leases.maxAttempts]);
          if (!result.rows.length) return;
          await new Promise(resolve => setTimeout(resolve, 500)); continue;
        }
        try {
          const complete = await this.process(leases, range, window);
          await leases.finish(this.db, range, complete ? 'done' : 'todo');
          if (!complete) return;
          (this.options.logger ?? log)('backfill_range_done', { stream, from: range.from_block, to: range.to_block, window: window.size });
        } catch (error) {
          if (rpcStopReason(error) || this.client.rpcStopped?.() || this.stopping) {
            this.stop(); await leases.finish(this.db, range, 'todo'); throw error;
          }
          if(error instanceof TransactionRetryExhaustedError){
            await leases.finish(this.db,range,'todo');
            await new Promise(resolve=>setTimeout(resolve,1000));
            continue;
          }
          if(error instanceof PartitionLockTimeoutError) {
            await leases.finish(this.db,range,'todo');
            await new Promise(resolve=>setTimeout(resolve,1000));
            continue;
          }
          (this.options.logger ?? log)('backfill_range_retry', { stream, from: range.from_block, attempt: range.attempts, error: safeError(error) });
          try {
            const repeats = await leases.fail(range,error);
            if (repeats >= leases.maxAttempts || range.attempts >= leases.maxAttempts * 3) (this.options.logger ?? log)('backfill_range_failed', { stream, from: range.from_block, to: range.to_block, attempts: range.attempts, error: safeError(error) });
          } catch (leaseError) {
            (this.options.logger ?? log)('backfill_lease_error', { stream, from: range.from_block, error: safeError(leaseError) });
            if (safeError(leaseError) !== 'Backfill lease lost') throw leaseError;
          }
        }
      }
    }));
    const failed = await this.db.sql.query<{ from_block: string; to_block: string; attempts: number; last_error: string | null }>(
      "SELECT from_block,to_block,attempts,last_error FROM ingest_ranges WHERE stream=$1 AND from_block <= $3 AND to_block >= $2 AND status='failed' ORDER BY from_block", [leaseStream,from.toString(),to.toString()]);
    if (failed.rows.length) (this.options.logger ?? log)('backfill_failed_ranges', { stream, count: failed.rows.length, ranges: failed.rows.map(r => ({ from: String(r.from_block), to: String(r.to_block), attempts: r.attempts, error: safeError(r.last_error ?? 'Backfill lease expired repeatedly') })) });
    const failure = results.find(r => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (failed.rows.length) throw new BackfillFailedError(failed.rows.length);
  }
  private async process(leases: RangeLeases, range: Range, window: AdaptiveWindow) {
    const ponsOnly = range.stream === 'logs:pons_factory' || range.stream === 'logs:pons_curves';
    const factory = range.stream === 'logs:pons_factory';
    const topics = factory ? ponsFactoryAbi.filter(a => a.type === 'event').map(toEventSelector) : ponsCurveAbi.flatMap(a => a.type === 'event' && ['CurveBuy','CurveSell','SnipeTaxExempted'].includes(a.name) ? [toEventSelector(a)] : []);
    let from = BigInt(range.from_block); const end = BigInt(range.to_block);
    while (from <= end) {
      if (this.stopping || this.client.rpcStopped?.()) return false;
      await leases.renew(range);
      const to = from + BigInt(window.size) - 1n < end ? from + BigInt(window.size) - 1n : end;
      let logs: RpcLog[];
      try {
        if (ponsOnly) logs = await this.filteredLogs({ from, to, topics, ...(factory ? { address: this.decoder.registry.requireAddress('pons.factory') } : {}) });
        else {
          const queries = await Promise.allSettled(this.filters.map(filter => this.filteredLogs({ ...filter, from, to })));
          const failure = queries.find(r => r.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
          logs = queries.flatMap(r => r.status === 'fulfilled' ? r.value : []);
        }
      }
      catch (error) { if (window.failure(error)) continue; throw error; }
      if (ponsOnly && !factory) {
        const emitters = [...new Set(logs.map(l => lower(l.address)))];
        const curves = await this.db.sql.query<{ curve: Uint8Array }>(`SELECT curve FROM tokens WHERE curve IN (${emitters.map((_, i) => `$${i + 1}`).join(',') || 'NULL'})`, emitters.map(a => Buffer.from(a.slice(2), 'hex')));
        const known = new Set(curves.rows.map(r => `0x${Buffer.from(r.curve).toString('hex')}`));
        logs = logs.filter(l => known.has(lower(l.address)));
      }
      const blocks = new Map<bigint, RpcLog[]>();
      for (const l of logs) {
        if (l.removed || BigInt(l.blockNumber) < from || BigInt(l.blockNumber) > to) throw new Error('Inconsistent backfill logs');
        const n = BigInt(l.blockNumber); const list = blocks.get(n) ?? []; list.push(l); blocks.set(n, list);
      }
      const scope=extendSenderScope(await loadSenderScope(this.db),logs,this.decoder.registry);
      const ordered = [...blocks].sort(([a],[b]) => a < b ? -1 : 1);
      for (let offset = 0; offset < ordered.length; offset += this.rpc.limit) {
        if (this.stopping || this.client.rpcStopped?.()) return false;
        await leases.renew(range);
        const reads = await Promise.allSettled(ordered.slice(offset, offset + this.rpc.limit).map(([n, selected]) => this.rpc.run(() => this.readBlock(n, selected, factory, ponsOnly,scope))));
        const failure = reads.find(r => r.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        if (this.stopping || this.client.rpcStopped?.()) return false;
        const data = reads.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
        const tokenRows = await this.decoder.loadTokens(this.db, data.flatMap(b => b.receipts.flatMap(r => r.logs.map(l => lower(l.address)))));
        const batch = new BlockRows();
        for (const b of data) {
          const prepared = await this.decoder.prepare(this.db, b.block, b.receipts, { ponsOnly, discoverLaunches: factory, remote: b.remote, tokenRows,scope,poolRows:scope.poolRows });
          batch.merge(this.decoder.collect(b.block, b.filtered, prepared, { ponsOnly }));
        }
        if (this.stopping || this.client.rpcStopped?.()) return false;
        for (const b of data) await this.db.ensurePartitions(new Date(Number(BigInt(b.block.timestamp)) * 1000));
        await this.db.tx(async tx => {
          await leases.renew(range, tx);
          await batch.flush(tx);
        },{retry:true});
      }
      from = to + 1n; window.success();
    }
    return true;
  }
  private async filteredLogs(filter: LogFilter): Promise<RpcLog[]> {
    const logs: RpcLog[] = [];
    // Inclusive endpoints: 50 addresses allow 4,000 blocks per RPC, while
    // one PoolManager address does not charge each topic-filtered PoolId.
    for (const query of budgetedQueries(filter)) logs.push(...await this.requestLogs(query));
    return logs;
  }
  private async requestLogs(filter: LogFilter): Promise<RpcLog[]> {
    try { return await this.rpc.run(() => this.client.logs(filter)); }
    catch (error) {
      // Provider array limits vary. Split filters on an array rejection, or when
      // a dense single block cannot be reduced further by the adaptive window.
      const arrayError = error instanceof Error && /too many addresses|address.*limit|topics.*limit|array.*limit/i.test(safeError(error));
      if (!arrayError && isRangeLimit(error) && filter.to > filter.from) {
        const mid = (filter.from+filter.to)/2n;
        return [...await this.requestLogs({ ...filter, to: mid }),...await this.requestLogs({ ...filter, from: mid+1n })];
      }
      if (!arrayError && !(filter.from === filter.to && isRangeLimit(error))) throw error;
      const ids = filter.addresses ?? (Array.isArray(filter.topicFilters?.[1]) ? filter.topicFilters[1] : null);
      if (!ids || ids.length < 2) throw error;
      const mid = Math.ceil(ids.length / 2);
      const split = (part: Hex[]): LogFilter => filter.addresses ? { ...filter, addresses: part as Address[] } : { ...filter, topicFilters: [filter.topicFilters![0],part] };
      return [...await this.requestLogs(split(ids.slice(0,mid))),...await this.requestLogs(split(ids.slice(mid)))];
    }
  }
  private async readBlock(n: bigint, selected: RpcLog[], factory: boolean, ponsOnly: boolean, scope:SenderScope) {
    // One receipts RPC per distinct block, regardless of the number of swaps/exemptions in its logs.
    const resolve=selected.some(l=>needsSender(l,scope,this.decoder.registry));
    const allReceipts:RpcReceipt[] = resolve ? await this.client.receipts(n) : [...new Set(selected.map(l=>lower(l.transactionHash)))].map(tx=>({transactionHash:tx,blockHash:selected[0].blockHash,blockNumber:selected[0].blockNumber,from:native,to:null,synthetic:true,logs:selected.filter(l=>lower(l.transactionHash)===tx)}));
    const selectedTxs = new Set(selected.map(l => lower(l.transactionHash)));
    const receipts = allReceipts.filter(r => selectedTxs.has(lower(r.transactionHash)));
    // The public RPC returns blockTimestamp 0x0 on logs; a zero is missing, never epoch 0.
    const timestamp = selected[0].blockTimestamp && BigInt(selected[0].blockTimestamp) > 0n ? selected[0].blockTimestamp : undefined;
    let block: RpcBlock;
    if (receipts.every(r => r.from && 'to' in r) && timestamp && selected.every(l => l.blockTimestamp === timestamp)) {
      block = { number: selected[0].blockNumber, hash: selected[0].blockHash, parentHash: '0x', timestamp, transactionsComplete:false, transactions: receipts.map(r => ({ hash: r.transactionHash, from: r.from!, to: r.to!,type:r.type,transactionIndex:r.transactionIndex })) };
    } else {
      // Compatibility with providers without log timestamps or receipt from/to; never look up a tx per log.
      const hasActors = receipts.every(r => r.from && 'to' in r);
      block = hasActors && this.client.header ? await this.client.header(n) : await this.client.block(n);
      if (hasActors) block = { ...block, transactionsComplete:false, transactions: receipts.map(r => ({ hash: r.transactionHash, from: r.from!, to: r.to!,type:r.type,transactionIndex:r.transactionIndex })) };
    }
    if (BigInt(block.number) !== n || selected.some(l => lower(l.blockHash) !== lower(block.hash)) || receipts.some(r => lower(r.blockHash) !== lower(block.hash) || BigInt(r.blockNumber) !== n)) throw new Error('Reorg during backfill');
    const keys = new Map(selected.map(l => [`${lower(l.transactionHash)}:${BigInt(l.logIndex)}`, l]));
    const filtered = receipts.map(r => ({ ...r, logs: r.logs.filter(l => {
      const expected = keys.get(`${lower(l.transactionHash)}:${BigInt(l.logIndex)}`);
      if (!expected) return false;
      if (l.removed || lower(l.blockHash) !== lower(block.hash) || lower(l.data) !== lower(expected.data) || lower(l.address) !== lower(expected.address) || l.topics.map(lower).join(',') !== expected.topics.map(lower).join(',')) throw new Error('Inconsistent canonical backfill receipt');
      return true;
    }) }));
    if (filtered.flatMap(r => r.logs).length !== keys.size) throw new Error('Backfill logs missing from canonical receipts');
    const remote = await this.decoder.prefetch(block, receipts, { ponsOnly, discoverLaunches: factory,scope });
    return { block, receipts, filtered, remote };
  }

}
// ERC-8004 identity history is collected separately by AgentRegistryCollector (registry:sync).

/** Find the first block at/after a timestamp without assuming a fixed block rate.
 * @remarks
 * Binary-search headers for the first block at/after the supplied timestamp up to head. Indexer
 * host read, no wallet auth; wrong/missing header or provider failure rejects and no fixed block
 * rate is assumed.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
 */
export async function blockAtTime(client: ChainClient, timestamp: bigint, head: bigint): Promise<bigint> {
  let lo = 0n, hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await (client.header?.(mid) ?? client.block(mid));
    if (!block || BigInt(block.number) !== mid) throw new Error('Historical header unavailable');
    if (BigInt(block.timestamp) < timestamp) lo = mid + 1n; else hi = mid;
  }
  return lo;
}
