import { withRpcOrigin } from '@eko/chain';
import { z } from 'zod';
import { keccak256, zeroAddress, type Hex } from 'viem';
import { RpcMeter, createMeteredClients, decodePonsResult, rpcStopReason, safeError,
  type AddressRegistry, type Provider, type RpcLog, type RpcRequest, type UsageRow, type UsageStore } from '@eko/chain';
import { BackfillStop, type BackfillAdmit, type BackfillAttemptKind, type BackfillRequest, type BackfillResponse,
  type SelectiveBackfillManifest } from './selective-backfill.js';

type Budget = SelectiveBackfillManifest['budget'];
type Cursor = Extract<BackfillResponse, { kind: 'header' }>['cursor'];
/** Provider methods a measured source may dispatch, each priced at the manifest weight of its request kind. */
export const BACKFILL_METHOD_KINDS: Readonly<Record<string, BackfillAttemptKind>> = Object.freeze({
  eth_getBlockByNumber: 'header', eth_getLogs: 'logs', eth_getCode: 'boundary', eth_getBalance: 'boundary' });
export const backfillMethodWeights = (weights: Budget['weights']) =>
  Object.fromEntries(Object.entries(BACKFILL_METHOD_KINDS).map(([method, kind]) => [method, weights[kind]]));
export const BOUNDARY_STATE_METHOD_VERSION = '1.0.0';
/** The runner's log-response bound; a larger result is answered as `dense` so the runner splits it. */
export const MAX_LOGS_PER_RESPONSE = 10000;

/** RpcMeter reserves every attempt it is about to dispatch, retries included. This store forwards each one
 * to the runner's bound admission, so the runner checkpoint stays the single durable ledger and the manifest
 * cap is checked before anything is sent. Unbound, public-route or unpriced attempts are refused. */
export class BackfillAttemptStore implements UsageStore {
  private admit: BackfillAdmit | null = null;
  private refusal: unknown = null;
  private total = 0;
  private readonly rows = new Map<string, UsageRow & { day: string }>();
  constructor(readonly weights: Record<string, number>) {}
  bind(admit: BackfillAdmit | null) { this.admit = admit; this.refusal = null; }
  /** The admission error behind the meter's last refusal (a cap stop or a ledger failure); cleared on read. */
  takeRefusal(): unknown { const refusal = this.refusal; this.refusal = null; return refusal; }
  async reserve(day: string, provider: Provider, method: string, units: number) {
    try {
      if (!this.admit) throw new Error('RPC attempt outside a backfill request');
      if (provider !== 'paid') throw new Error('Measured backfill uses the paid route only');
      const kind = Object.hasOwn(BACKFILL_METHOD_KINDS, method) ? BACKFILL_METHOD_KINDS[method] : undefined;
      if (!kind || units !== this.weights[method]) throw new Error('Unpriced backfill RPC method');
      await this.admit(kind);
    } catch (error) { this.refusal = error; return { allowed: false, total: this.total }; }
    this.total += units;
    const key = `${day}:${provider}:${method}`, row = this.rows.get(key) ?? { day, provider, method, calls: 0, units: 0 };
    row.calls++; row.units += units; this.rows.set(key, row);
    return { allowed: true, total: this.total };
  }
  async today(day: string) { return [...this.rows.values()].filter(r => r.day === day).map(({ day: _day, ...row }) => row); }
}

/** One JSON-RPC call through the metered client. */
export interface BackfillRpc { request(method: string, params: readonly unknown[]): Promise<unknown> }
/** Paid-route metered client for a measured manifest. The endpoint comes from the environment at run time;
 * nothing here persists it. `send` replaces the HTTP transport in offline tests. */
export function measuredBackfillRpc(env: { RPC_HTTP_URL?: string; RPC_PAID_MAX_RPM?: string }, budget: Budget,
  options: { onSessionBudget: () => void; log?: RpcLog; transientRetrySec?: number; now?: () => number;
    sleep?: (ms: number) => Promise<void>; send?: Record<Provider, (r: RpcRequest) => Promise<unknown>> }) {
  if (!env.RPC_HTTP_URL) throw new Error('RPC_HTTP_URL is required for a measured source');
  const store = new BackfillAttemptStore(backfillMethodWeights(budget.weights));
  // The meter's own ceiling is a backstop one unit above the manifest cap, so the runner's admission is
  // always the authority that refuses (and names) the attempt at the cap.
  const meter = new RpcMeter({ RPC_HTTP_URL: env.RPC_HTTP_URL, RPC_PAID_MAX_RPM: env.RPC_PAID_MAX_RPM,
    RPC_PAID_DAILY_BUDGET: String(budget.checkpointUnits + 1), RPC_WEIGHTS: JSON.stringify(store.weights) },
  { store, transientRetrySec: options.transientRetrySec ?? 20, onSessionBudget: options.onSessionBudget,
    log: options.log, alert: options.log, now: options.now, sleep: options.sleep });
  // The 'fork' route is paid-only, so there is no silent public fallback mid-source: public logs carry zero
  // timestamps and public archive coverage is unverified (Guard §8.1).
  const send = options.send;
  const client = send ? null : createMeteredClients({}, { meter }).forkArchive;
  const rpc: BackfillRpc = { request: (method, params) => send ? meter.request({ method, params }, send, 'fork') :
    client!.request({ method, params } as never) };
  return { meter, store, rpc };
}

const TRANSIENT = /rate.?limit|too many requests|\b429\b|timed? ?out|timeout|temporarily unavailable|ECONNRESET|socket hang up|fetch failed/i;
const RANGE_LIMIT = /query returned more than|more than \d+ (?:results|logs)|too many (?:results|logs)|query exceeds|exceeds defined limit|response (?:size|body) (?:exceeded|(?:is )?too (?:large|big))|log response size|(?:block )?range (?:is )?too (?:large|wide)|exceed(?:s|ed)? (?:the )?max(?:imum)? (?:block )?range|range .*not supported|limited to .*(?:addresses|blocks)/i;
/** A provider refusal caused by result size or range, never by load: split it, don't record a gap. */
export function logRangeLimited(error: unknown) {
  const text = safeError(error);
  return !TRANSIENT.test(text) && RANGE_LIMIT.test(text);
}

const quantityHex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const bytes = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
const rpcBlock = z.object({ number: quantityHex, hash: hash32, timestamp: quantityHex });
const rpcLog = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), blockNumber: quantityHex, blockHash: hash32,
  transactionHash: hash32, transactionIndex: quantityHex, logIndex: quantityHex, topics: z.array(hash32).max(4), data: bytes,
  blockTimestamp: quantityHex.optional(), removed: z.boolean().optional() });
const quantity = (n: string | bigint) => `0x${BigInt(n).toString(16)}`;
const blockCursor = (number: string, hash: string, timestampSec: string): Cursor => ({ chainId: 4663, blockNumber: number,
  blockHash: hash.toLowerCase(), transactionIndex: null, executionOrdinal: null, timestampSec, boundary: 'block_end' });
const NO_TRANSACTION = { from: zeroAddress, to: null };
/** A block-end cursor from an `eth_getBlockByNumber` result, or null (past the head, or malformed). */
export function parseRpcHeader(raw: unknown): Cursor | null {
  const parsed = rpcBlock.safeParse(raw);
  return parsed.success ? blockCursor(BigInt(parsed.data.number).toString(), parsed.data.hash, BigInt(parsed.data.timestamp).toString()) : null;
}
/** Re-raise budget, shutdown and ledger refusals; return normally only for genuine provider failures. */
export function raiseBackfillStops(store: BackfillAttemptStore, error: unknown) {
  const refusal = store.takeRefusal();
  if (refusal) throw refusal;
  const stop = rpcStopReason(error);
  if (stop) throw new BackfillStop(stop);
}

/** Measured header, log and boundary-state reads. Provider errors and oversized results become the runner's
 * `missing`/`dense` responses; budget, shutdown and ledger stops are re-raised so they are never cached as gaps. */
export function createMeasuredBackfillSource(options: { rpc: BackfillRpc; store: BackfillAttemptStore;
  registry: AddressRegistry; maxLogsPerResponse?: number }) {
  const { rpc, store } = options, maxLogs = options.maxLogsPerResponse ?? MAX_LOGS_PER_RESPONSE;
  const factory = options.registry.requireAddress('pons.factory').toLowerCase();
  const timestamps = new Map<string, { hash: string; timestampSec: string }>();
  const stopIfNotProvider = (error: unknown) => raiseBackfillStops(store, error);
  const header = async (block: string): Promise<BackfillResponse> => {
    let raw: unknown;
    try { raw = await withRpcOrigin('engines.selective_backfill_source.rawL113',()=>rpc.request('eth_getBlockByNumber', [quantity(block), false])); }
    catch (error) { stopIfNotProvider(error); return { kind: 'missing', reason: 'header_unavailable' }; }
    const at = parseRpcHeader(raw); // null past the provider's head, or malformed
    if (!at) return { kind: 'missing', reason: 'header_unavailable' };
    timestamps.set(at.blockNumber, { hash: at.blockHash, timestampSec: at.timestampSec });
    return { kind: 'header', cursor: at };
  };
  // Positive log timestamps are kept; zero or absent ones come from the block header (an extra metered
  // attempt), never interpolated. A header on another fork is a reorg.
  const cursorOf = async (log: z.infer<typeof rpcLog>): Promise<Cursor | null> => {
    const number = BigInt(log.blockNumber).toString(), hash = log.blockHash.toLowerCase();
    const stamped = log.blockTimestamp ? BigInt(log.blockTimestamp) : 0n;
    if (stamped > 0n) return blockCursor(number, hash, stamped.toString());
    let seen = timestamps.get(number);
    if (!seen) {
      const response = await header(number);
      if (response.kind !== 'header') return null;
      seen = { hash: response.cursor.blockHash, timestampSec: response.cursor.timestampSec };
    }
    if (seen.hash !== hash) throw new BackfillStop('source_reorg');
    return blockCursor(number, hash, seen.timestampSec);
  };
  const logs = async (r: Extract<BackfillRequest, { kind: 'logs' }>): Promise<BackfillResponse> => {
    let raw: unknown;
    try { raw = await withRpcOrigin('engines.selective_backfill_source.rawL137',()=>rpc.request('eth_getLogs', [{ fromBlock: quantity(r.from), toBlock: quantity(r.through), address: r.addresses, topics: r.topics }])); }
    catch (error) { stopIfNotProvider(error); return logRangeLimited(error) ? { kind: 'dense' } : { kind: 'missing', reason: 'range_unavailable' }; }
    if (Array.isArray(raw) && raw.length > maxLogs) return { kind: 'dense' };
    const parsed = z.array(rpcLog).safeParse(raw);
    if (!parsed.success) return { kind: 'missing', reason: 'range_unavailable' };
    if (parsed.data.some(l => l.removed)) throw new BackfillStop('source_reorg');
    const events: Extract<BackfillResponse, { kind: 'logs' }>['events'] = [];
    const launches: Extract<BackfillResponse, { kind: 'logs' }>['launches'] = [];
    for (const log of parsed.data) {
      const at = await cursorOf(log);
      if (!at) return { kind: 'missing', reason: 'range_unavailable' };
      const event = { address: log.address.toLowerCase(), cursor: at, knownAt: { cursor: at, acquisitionSequence: '0' },
        transactionHash: log.transactionHash.toLowerCase(), transactionIndex: Number(BigInt(log.transactionIndex)),
        logIndex: Number(BigInt(log.logIndex)), topics: log.topics.map(t => t.toLowerCase()), data: log.data.toLowerCase() };
      events.push(event);
      if (event.address !== factory) continue;
      const decoded = decodePonsLaunch(event, options.registry);
      // An undecodable launch log at the factory would silently shrink the denominator: name the gap instead.
      if (decoded === 'malformed') return { kind: 'missing', reason: 'range_unavailable' };
      if (decoded) launches.push({ coin: decoded.token, creation: at, knownAt: event.knownAt });
    }
    return { kind: 'logs', events, launches };
  };
  // Pre-creation state of the coin address at the pinned parent block (number-addressed archive reads,
  // the verified archive path). Reconstruction applies validated events from creation onwards.
  const boundary = async (r: Extract<BackfillRequest, { kind: 'boundary' }>): Promise<BackfillResponse> => {
    let code: unknown, balance: unknown;
    try {
      code = await withRpcOrigin('engines.selective_backfill_source.rawL165',()=>rpc.request('eth_getCode', [r.coin, quantity(r.cursor.blockNumber)]));
      balance = await withRpcOrigin('engines.selective_backfill_source.rawL166',()=>rpc.request('eth_getBalance', [r.coin, quantity(r.cursor.blockNumber)]));
    } catch (error) { stopIfNotProvider(error); return { kind: 'missing', reason: 'boundary_unavailable' }; }
    const c = bytes.safeParse(code), b = quantityHex.safeParse(balance);
    if (!c.success || !b.success) return { kind: 'missing', reason: 'boundary_unavailable' };
    return { kind: 'boundary', coin: r.coin, cursor: r.cursor, knownAt: { cursor: r.cursor, acquisitionSequence: '0' },
      state: { codeHash: keccak256(c.data.toLowerCase() as Hex), codeBytes: (c.data.length - 2) / 2,
        nativeBalanceRaw: BigInt(b.data).toString() }, methodVersion: BOUNDARY_STATE_METHOD_VERSION };
  };
  return {
    bindAttempts: (admit: BackfillAdmit | null) => store.bind(admit),
    request: (r: BackfillRequest): Promise<BackfillResponse> =>
      r.kind === 'header' ? header(r.block) : r.kind === 'logs' ? logs(r) : boundary(r),
  };
}

/** Decode a Pons factory `TokenLaunched` event with the chain package decoder. Null for other factory topics. */
export function decodePonsLaunch(event: { address: string; topics: string[]; data: string }, registry: AddressRegistry) {
  const result = decodePonsResult({ address: event.address as Hex, topics: event.topics as [Hex, ...Hex[]], data: event.data as Hex },
    NO_TRANSACTION, { registry, tokenForCurve: () => null });
  if (result.malformedLogs) return 'malformed' as const;
  const launch = result.events.find(e => e.kind === 'launch');
  if (!launch || launch.kind !== 'launch') return null;
  return { token: launch.token.toLowerCase(), curve: launch.curve.toLowerCase(), deployer: launch.deployer.toLowerCase(),
    pairToken: launch.pairToken?.toLowerCase() ?? null, launchConfigId: launch.launchConfigId?.toString() ?? null,
    graduationThreshold: launch.graduationThreshold?.toString() ?? null };
}
