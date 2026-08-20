import { safeError } from './rpc/safe-error.js';
import { decodeEventLog, getAddress, keccak256, numberToHex, parseAbi, toEventSelector, toHex, zeroAddress, type AbiEvent, type Address, type Hex, type Log } from 'viem';
import { v3Abi, v4Abi, ponsFactoryAbi, ponsCurveAbi } from './abis.js';
import type { DecoderLog } from './decoders.js';
import type { AddressRegistry, RegistryEntry, RegistryKey } from './registry.js';
import { RegistryBuildRecordSchema, type BuildRecords } from './build-records.js';
import { rpcStopReason } from './rpc/metered.js';
import { CHAIN_ID } from '@eko/shared';
export const IMPLEMENTATION_SLOT = numberToHex(BigInt(keccak256(toHex('eip1967.proxy.implementation'))) - 1n, { size: 32 });
export const routerWiringAbi = parseAbi(['function factory() view returns (address)', 'function WETH9() view returns (address)']);
export const registryRolesAbi = parseAbi(['function owner() view returns (address)', 'function pendingOwner() view returns (address)', 'function committer() view returns (address)']);
export type VerificationLog = DecoderLog & Partial<Pick<Log, 'blockNumber' | 'logIndex'>>;
export interface VerifyClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getCode(input: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  getStorageAt(input: { address: Address; slot: Hex; blockNumber: bigint }): Promise<Hex | undefined>;
  readContract(input: { address: Address; abi: typeof routerWiringAbi | typeof registryRolesAbi; functionName: 'factory' | 'WETH9' | 'owner' | 'pendingOwner' | 'committer'; blockNumber: bigint }): Promise<Address>;
  getLogs(input: { address: Address; event: AbiEvent; fromBlock: bigint; toBlock: bigint }): Promise<VerificationLog[]>;
}
export interface VerificationRow { entry: string; check: string; ok: boolean; detail: string }
export interface VerificationReport { ok: boolean; complete: boolean; block?: bigint; rows: VerificationRow[] }
/** All I/O is injected; no filesystem, environment, global clients or console access. */
export async function verifyChain(registry: AddressRegistry, rawClient: VerifyClient, options: {
  lookback?: bigint; logChunkSize?: bigint; prelaunch?: boolean; buildRecords?: BuildRecords;
  signal?: AbortSignal; timeoutMs?: number;
} = {}): Promise<VerificationReport> {
  const rows: VerificationRow[] = [];
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive and finite');
  const deadline = Date.now() + timeoutMs;
  let halted = false;
  async function rpc<T>(fn: () => Promise<T>): Promise<T> {
    if (halted || options.signal?.aborted || Date.now() >= deadline) {
      halted = true;
      throw new Error('Verification incomplete: interrupted, stopped or deadline exhausted');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([new Promise<T>((_resolve, reject) => {
        const stop = (reason: string) => { halted = true; reject(new Error(`Verification incomplete: ${reason}`)); };
        timer = setTimeout(() => stop('deadline exhausted'), deadline - Date.now());
        abort = () => stop('interrupted');
        options.signal?.addEventListener('abort', abort, { once: true });
      }), Promise.resolve().then(fn)]);
    } catch (error) {
      if (rpcStopReason(error)) halted = true;
      throw error;
    } finally {
      clearTimeout(timer);
      if (abort) options.signal?.removeEventListener('abort', abort);
    }
  }
  const client: VerifyClient = {
    getChainId: () => rpc(() => rawClient.getChainId()),
    getBlockNumber: () => rpc(() => rawClient.getBlockNumber()),
    getCode: input => rpc(() => rawClient.getCode(input)),
    getStorageAt: input => rpc(() => rawClient.getStorageAt(input)),
    readContract: input => rpc(() => rawClient.readContract(input)),
    getLogs: input => rpc(() => rawClient.getLogs(input)),
  };
  const finish = (block?: bigint): VerificationReport => {
    const complete = !halted && !options.signal?.aborted && Date.now() < deadline;
    if (!complete) rows.push({ entry: 'RPC', check: 'completion', ok: false, detail: 'Verification incomplete: interrupted, stopped or deadline exhausted' });
    return { ok: complete && rows.every(row => row.ok), complete, block, rows };
  };
  const run = async (entry: string, check: string, fn: () => Promise<string>) => {
    try { rows.push({ entry, check, ok: true, detail: await fn() }); }
    catch (error) { rows.push({ entry, check, ok: false, detail: safeError(error) }); }
  };
  await run('RPC', 'chainId', async () => {
    const id = await client.getChainId();
    if (id !== CHAIN_ID) throw new Error(`RPC chainId ${id}, expected ${CHAIN_ID}`);
    return String(CHAIN_ID);
  });
  if (!rows[0].ok) return finish();
  let block: bigint | undefined;
  await run('RPC', 'head', async () => { block = await client.getBlockNumber(); return String(block); });
  if (block === undefined) return finish();
  const atBlock = block;
  async function followCode(address: Address, requiredProxy: boolean, visited = new Set<string>()): Promise<string> {
    const key = address.toLowerCase();
    if (visited.has(key) || visited.size >= 8) throw new Error('Proxy implementation cycle or depth limit');
    visited.add(key);
    const code = await client.getCode({ address, blockNumber: atBlock });
    if (!code || code === '0x') throw new Error(`No code at ${address}`);
    const storage = await client.getStorageAt({ address, slot: IMPLEMENTATION_SLOT, blockNumber: atBlock });
    if (storage && !/^0x[0-9a-fA-F]{64}$/.test(storage)) throw new Error('Malformed implementation slot');
    const implementation = storage ? getAddress(`0x${storage.slice(-40)}`) : zeroAddress;
    if (implementation !== zeroAddress) return `${(code.length - 2) / 2} bytes → ${implementation}: ${await followCode(implementation, false, visited)}`;
    if (requiredProxy) throw new Error('Expected EIP-1967 implementation slot is empty');
    return `${(code.length - 2) / 2} bytes`;
  }
  async function verifyOwnedContract(key: RegistryKey, entry: RegistryEntry): Promise<void> {
    // TODO(spec): Later EKO contracts need their own role/delay/immutable checks before deployment.
    // Fail closed rather than treating an unsupported release as a code-presence check.
    if (key !== 'ours.receiptsRegistry') {
      await run(key, 'release profile', async () => { throw new Error('No release verification profile for deployed EKO contract'); });
      return;
    }
    await run(key, 'runtime hash', async () => {
      if (!entry.build_record || entry.build_record === 'TODO') throw new Error('Build record reference is TODO or missing');
      const record = RegistryBuildRecordSchema.parse(options.buildRecords?.[entry.build_record]);
      const code = await client.getCode({ address: entry.address as Address, blockNumber: atBlock });
      if (!code || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error('Missing or malformed runtime code');
      const actual = keccak256(code);
      if (actual.toLowerCase() !== record.runtimeCodeHash.toLowerCase()) throw new Error(`Runtime hash ${actual} != ${record.runtimeCodeHash}`);
      return actual;
    });
    for (const functionName of ['owner', 'pendingOwner', 'committer'] as const) {
      await run(key, functionName, async () => {
        const expected = functionName === 'pendingOwner' ? zeroAddress : entry[functionName];
        if (!expected || expected === 'TODO') throw new Error(`Manifest ${functionName} is TODO or missing`);
        if (functionName === 'owner' && expected === zeroAddress) throw new Error('Manifest owner must not be zero');
        const actual = await client.readContract({ address: entry.address as Address, abi: registryRolesAbi, functionName, blockNumber: atBlock });
        if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${actual} != ${expected}`);
        return actual;
      });
    }
  }
  for (const [key, entry] of registry.entries()) {
    if (entry.address === 'TODO') {
      rows.push({ entry: key, check: 'registry', ok: options.prelaunch === true && entry.required_for !== 'T', detail: `not deployed${entry.required_for ? ` (required for ${entry.required_for})` : ''}` });
      continue;
    }
    if (entry.address === zeroAddress) {
      rows.push({ entry: key, check: 'registry', ok: false, detail: 'Zero deployment address' });
      continue;
    }
    if (key.startsWith('ours.')) {
      // Public fee wallets are addresses, not EKO contract deployments.
      if (key === 'ours.burnWallet' || key === 'ours.devWallet') {
        rows.push({ entry: key, check: 'wallet', ok: true, detail: entry.address });
      } else await verifyOwnedContract(key, entry);
      continue;
    }
    await run(key, 'code', () => followCode(entry.address as Address, key === 'tokens.USDG' || key === 'erc8004.identityRegistry'));
    if (entry.check === 'router02_wiring') {
      for (const [functionName, expectedKey] of [['factory', 'uniswapV3.factory'], ['WETH9', 'tokens.WETH']] as const) {
        await run(key, functionName, async () => {
          const result = await client.readContract({ address: entry.address as Address, abi: routerWiringAbi, functionName, blockNumber: atBlock });
          const expected = registry.requireAddress(expectedKey);
          if (result.toLowerCase() !== expected.toLowerCase()) throw new Error(`${result} != ${expected}`);
          return result;
        });
      }
    }
  }
  const lookback = options.lookback ?? 100_000n;
  const chunk = options.logChunkSize ?? 2_000n;
  if (lookback <= 0n || chunk <= 0n) throw new Error('lookback and logChunkSize must be positive');
  const fromBlock = atBlock >= lookback ? atBlock - lookback + 1n : 0n;
  function isLogCapacityError(error: unknown): boolean {
    const seen = new Set<unknown>();
    while (error && !seen.has(error)) {
      seen.add(error);
      if (typeof error === 'string') return /too many (?:results|logs)|logs matched by query exceeds limit|response body exceeded the size limit/i.test(error);
      if (typeof error !== 'object') return false;
      const detail = error as { message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
      if ([detail.message, detail.shortMessage, detail.details].some(value => typeof value === 'string' && /too many (?:results|logs)|logs matched by query exceeds limit|response body exceeded the size limit/i.test(value))) return true;
      error = detail.cause;
    }
    return false;
  }
  async function recentLogs(address: Address, event: AbiEvent): Promise<VerificationLog[]> {
    let window = chunk > 20_000n ? 20_000n : chunk;
    // BACKEND §4.3: halve dense windows, grow successful empty windows, never skip a range.
    for (let end = atBlock; end >= fromBlock;) {
      const width = end - fromBlock + 1n < window ? end - fromBlock + 1n : window;
      const start = end - width + 1n;
      let logs: VerificationLog[];
      try { logs = await client.getLogs({ address, event, fromBlock: start, toBlock: end }); }
      catch (error) {
        // One block is the floor; capacity failures there and unrelated RPC errors stay failures.
        if (!isLogCapacityError(error) || width === 1n) throw error;
        window = width / 2n;
        continue;
      }
      if (logs.length) return logs;
      if (start === fromBlock) break;
      end = start - 1n;
      window = window * 2n > 20_000n ? 20_000n : window * 2n;
    }
    return [];
  }
  function validateLogs(logs: VerificationLog[], address: Address, event: AbiEvent): void {
    const topic = toEventSelector(event);
    for (const log of logs) {
      if (log.address.toLowerCase() !== address.toLowerCase()) throw new Error('Unexpected event emitter');
      if (log.topics[0] !== topic) throw new Error(`Observed ${log.topics[0]}, expected ${topic}`);
      decodeEventLog({ abi: [event], topics: log.topics, data: log.data, strict: true });
    }
  }
  async function checkEvent(entry: string, address: Address | null, event: AbiEvent): Promise<VerificationLog[]> {
    let found: VerificationLog[] = [];
    await run(entry, `event ${event.name}`, async () => {
      if (!address) throw new Error('Emitter address is TODO');
      found = await recentLogs(address, event);
      if (!found.length) throw new Error(`No recent log for ${toEventSelector(event)}`);
      validateLogs(found, address, event);
      return `${found.length} log(s), ${toEventSelector(event)}`;
    });
    return rows.at(-1)!.ok ? found : [];
  }
  await checkEvent('uniswapV3.factory', registry.addressOf('uniswapV3.factory'), v3Abi[0]);
  const launchEvent = ponsFactoryAbi.find((a): a is AbiEvent => a.type === 'event' && a.name === 'TokenLaunched')!;
  const launches = await checkEvent('pons.factory', registry.addressOf('pons.factory'), launchEvent);
  const newestLaunches = [...launches].reverse().sort((a, b) => {
    const aBlock = a.blockNumber ?? 0n, bBlock = b.blockNumber ?? 0n;
    return aBlock === bBlock ? (b.logIndex ?? 0) - (a.logIndex ?? 0) : aBlock > bBlock ? -1 : 1;
  });
  const curves: Address[] = [];
  for (const launch of newestLaunches) {
    const curve = (decodeEventLog({ abi: [launchEvent], topics: launch.topics, data: launch.data }).args as { curve: Address }).curve;
    if (!curves.some(address => address.toLowerCase() === curve.toLowerCase())) curves.push(curve);
    if (curves.length === 20) break;
  }
  const curveCodes = new Map<Address, Hex | undefined>();
  for (const name of ['CurveBuy', 'CurveSell', 'SnipeTaxExempted']) {
    const event = ponsCurveAbi.find((a): a is AbiEvent => a.type === 'event' && a.name === name)!;
    await run('pons.curve', `event ${name}`, async () => {
      if (!curves.length) throw new Error('No recent launch curve was found');
      const topic = toEventSelector(event);
      for (const curve of curves) {
        const found = await recentLogs(curve, event);
        if (!found.length) continue;
        validateLogs(found, curve, event);
        return `${found.length} log(s), ${topic}, curve ${curve}`;
      }
      for (const curve of curves) {
        if (!curveCodes.has(curve)) curveCodes.set(curve, await client.getCode({ address: curve, blockNumber: atBlock }));
        if (curveCodes.get(curve)?.toLowerCase().includes(topic.slice(2).toLowerCase())) {
          return `${topic} present in bytecode at ${curve}; not emitted recently (checked ${curves.length} curve(s))`;
        }
      }
      throw new Error(`No recent log or topic ${topic} in deployed bytecode of ${curves.length} curve(s)`);
    });
  }
  for (const event of v4Abi) await checkEvent('uniswapV4.poolManager', registry.addressOf('uniswapV4.poolManager'), event);
  return finish(atBlock);
}
