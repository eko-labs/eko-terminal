import { encodeAbiParameters, encodeEventTopics, toHex, zeroAddress, zeroHash, type AbiEvent, type Hex } from 'viem';
import { loadRegistry, ponsFactoryAbi, type RpcRequest } from '@eko/chain';
import { pilotHash } from '../src/coverage-pilot.js';
import { LaunchEnumerationManifestSchema, PONS_LAUNCH_TOPIC, initialEnumerationCheckpoint,
  runLaunchEnumeration, type LaunchEnumerationManifest } from '../src/launch-enumeration.js';
import { createMeasuredBackfillSource, measuredBackfillRpc } from '../src/selective-backfill-source.js';
import type { BackfillCheckpoint, BackfillIO, BackfillResponse, SelectiveBackfillManifest } from '../src/selective-backfill.js';

export const registry = loadRegistry();
export const FACTORY = registry.requireAddress('pons.factory').toLowerCase();
export const D = 1791072000; // 2026-10-04T00:00:00Z
export const DAY = 86400;
export const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
export const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const blockHash = (n: number) => hash(0xabc000 + n);
const launchEvent = ponsFactoryAbi.find((e): e is AbiEvent => e.type === 'event' && e.name === 'TokenLaunched')!;
export const cursorAt = (chain: { timestamps: number[] }, n: number) => ({ chainId: 4663, blockNumber: String(n),
  blockHash: blockHash(n), transactionIndex: null, executionOrdinal: null, timestampSec: String(chain.timestamps[n]), boundary: 'block_end' as const });
export type Fault = (r: RpcRequest, attempt: number) => unknown;

/** Synthetic offline chain, not captured data: explicit per-block timestamps, ABI-encoded Pons launches and
 * optional token logs. `send` stands in for the paid HTTP transport; every dispatch is recorded. */
export function syntheticChain(timestamps: number[], launches: { block: number; token: string }[],
  options: { zeroTimestamps?: boolean; extraLogs?: { block: number; address: string; topics: string[] }[] } = {}) {
  const head = timestamps.length - 1;
  const log = (block: number, address: string, topics: string[], data: string, i: number) => ({ address, blockNumber: toHex(block),
    blockHash: blockHash(block), transactionHash: hash(0x5000 + i), transactionIndex: '0x0', logIndex: toHex(i),
    topics, data, blockTimestamp: options.zeroTimestamps ? '0x0' : toHex(timestamps[block]), removed: false });
  const logs = [...launches.map((l, i) => log(l.block, FACTORY, encodeEventTopics({ abi: [launchEvent], eventName: 'TokenLaunched',
    args: { token: l.token as Hex, curve: addr(0xc000 + i) as Hex, deployer: addr(0xd000 + i) as Hex } }) as string[],
  encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [zeroAddress, 0n, 4200000000000000000n]), i)),
  ...(options.extraLogs ?? []).map((l, i) => log(l.block, l.address, l.topics, '0x', 1000 + i))];
  const calls: { method: string; params: unknown }[] = [];
  let fault: Fault | null = null;
  const answer = (r: RpcRequest): unknown => {
    const p = (r.params ?? []) as unknown[];
    if (r.method === 'eth_getBlockByNumber') {
      const tag = String(p[0]), n = ['finalized', 'safe', 'latest'].includes(tag) ? head : Number(BigInt(tag));
      return n > head ? null : { number: toHex(n), hash: blockHash(n), parentHash: n ? blockHash(n - 1) : zeroHash, timestamp: toHex(timestamps[n]) };
    }
    if (r.method === 'eth_getLogs') {
      const f = p[0] as { fromBlock: string; toBlock: string; address: string[]; topics: (string | string[] | null)[] };
      const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
      return logs.filter(l => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to && f.address.includes(l.address) &&
        f.topics.every((t, i) => t === null || (Array.isArray(t) ? t : [t]).includes(l.topics[i])));
    }
    if (r.method === 'eth_getCode') return '0x';
    if (r.method === 'eth_getBalance') return '0x2a';
    throw new Error('unsupported fixture method');
  };
  const send = {
    paid: async (r: RpcRequest) => {
      calls.push({ method: r.method, params: structuredClone(r.params) });
      const injected = fault?.(r, calls.filter(c => c.method === r.method).length);
      return injected === undefined ? answer(r) : injected;
    },
    public: async (): Promise<unknown> => { throw new Error('public route used'); },
  };
  return { head, timestamps, logs, calls, send, setFault: (f: Fault | null) => { fault = f; } };
}
export type SyntheticChain = ReturnType<typeof syntheticChain>;
/** Hourly blocks from D-1d through D+15d, so the 14-day launch frame and seven-day follow-up both fit. */
export const hourlyTimestamps = () => Array.from({ length: 16 * 24 + 1 }, (_, n) => D - DAY + n * 3600);

export const measuredBudget = (checkpointUnits = 1000) => ({ approvalRef: 'sample-approval', pricingEvidence: hash(77),
  unitNanoUsd: '6000', capNanoUsd: String(checkpointUnits * 6000), fixedNanoUsd: '0', checkpointUnits,
  weights: { header: 1, logs: 1, boundary: 1 } });
export function enumerationManifest(chain: SyntheticChain, fromSec: number, untilSec: number,
  options: { budget?: ReturnType<typeof measuredBudget>; validation?: 'fixture' | 'measured'; sourceId?: string } = {}): LaunchEnumerationManifest {
  const watermark = cursorAt(chain, chain.head), revision = hash(0x900);
  return LaunchEnumerationManifestSchema.parse({ version: 'launch-enumeration-058.1', validation: options.validation ?? 'measured',
    chainId: 4663, sourceRevision: revision, availability: { id: hash(0x901), sourceId: options.sourceId ?? 'sample-launch-source',
      sourceRevision: revision, replayMode: 'retrospective', cut: { cursor: watermark, acquisitionSequence: '0' }, watermark,
      acquiredAt: '2026-10-19T00:00:00Z' },
    fromSec: String(fromSec), untilSec: String(untilSec), launchpads: [{ id: 'pons', factory: FACTORY, topic: PONS_LAUNCH_TOPIC }],
    budget: options.budget ?? measuredBudget() });
}

/** Durable in-memory store shared across simulated restarts; each `process()` is a fresh meter/store/source. */
export function measuredRun(chain: SyntheticChain, budget: SelectiveBackfillManifest['budget'],
  options: { maxLogsPerResponse?: number; transientRetrySec?: number } = {}) {
  const artifacts = new Map<string, BackfillResponse>(), saves: BackfillCheckpoint[] = [];
  let persisted: BackfillCheckpoint | null = null;
  const start = (stopWhen: (c: BackfillCheckpoint) => boolean = () => false) => {
    let clock = Date.UTC(2026, 9, 19), stop = false;
    const { meter, store, rpc } = measuredBackfillRpc({ RPC_HTTP_URL: 'http://fixture.invalid' }, budget, { onSessionBudget: () => {},
      log: () => {}, now: () => clock, sleep: async ms => { clock += ms; }, send: chain.send, transientRetrySec: options.transientRetrySec ?? 0 });
    const source = createMeasuredBackfillSource({ rpc, store, registry, maxLogsPerResponse: options.maxLogsPerResponse });
    const io: BackfillIO = { sourceRevision: async () => hash(0x900), stopped: () => stop, now: () => 0, rss: () => 0,
      save: async c => { persisted = structuredClone(c); saves.push(persisted); if (stopWhen(c)) stop = true; },
      artifact: async key => structuredClone(artifacts.get(key) ?? null), putArtifact: async (key, value) => { artifacts.set(key, structuredClone(value)); },
      request: r => source.request(r), bindAttempts: admit => source.bindAttempts(admit) };
    return { io, meter, store };
  };
  return { artifacts, saves, start, persisted: () => persisted };
}
export const candidate = 'c'.repeat(64), owner = 'sample-runner';
export async function enumerate(chain: SyntheticChain, m: LaunchEnumerationManifest,
  run = measuredRun(chain, m.budget), stopWhen?: (c: BackfillCheckpoint) => boolean) {
  const c = run.persisted() ?? initialEnumerationCheckpoint(m, candidate, owner);
  const result = await runLaunchEnumeration(m, structuredClone(c), run.start(stopWhen).io, candidate, owner, registry);
  return { result, run, checkpoint: run.persisted()! };
}
export const dispatched = (chain: SyntheticChain) => chain.calls.map(c => pilotHash(c));
