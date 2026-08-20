import { describe, expect, it, vi } from 'vitest';
import { getAddress, keccak256, numberToHex, toEventSelector, zeroAddress, type Address, type AbiEvent, type Hex } from 'viem';
import { loadBuildRecords, type BuildRecords } from '../src/build-records.js';
import { RpcGuardError } from '../src/rpc/metered.js';
import { runVerifyCommand, verificationMode } from '../src/verify-command.js';
import { loadRegistry } from '../src/registry.js';
import { verifyChain, IMPLEMENTATION_SLOT, type VerifyClient } from '../src/verify.js';
import { ponsCurveAbi, ponsFactoryAbi, v4Abi } from '../src/abis.js';
import { logOf, syntheticLog } from './helpers.js';
import codes from './fixtures/4663/registry-code.json' with { type: 'json' };
import launch from './fixtures/4663/pons-launch.json' with { type: 'json' };
import curve from './fixtures/4663/pons-curve-logs.json' with { type: 'json' };
import pool from './fixtures/4663/v3-pool.json' with { type: 'json' };
import v4 from './fixtures/4663/v4-poolmanager-logs.json' with { type: 'json' };
import v4New from './fixtures/4663/v4-initialize-donate-logs.json' with { type: 'json' };
const registry = loadRegistry();
// The captured fixture contains code sizes/hashes, not bytecode/storage/implementations.
// Byte strings are synthetic with the captured lengths; proxy slot and implementation code are synthetic.
// The base branch resolved these deployments after the captured code-size fixture.
// Supply synthetic code for offline verification; this is not a new chain capture.
const syntheticEntryPoints=(['v06','v07','v08'] as const).map(v=>registry.requireAddress(`entryPoints.${v}`));
const syntheticImplementation = getAddress('0x1234567890123456789012345678901234567890');
const emptySlot = `0x${'00'.repeat(32)}` as Hex;
const atBlock = BigInt(v4New.capturedAtBlock);
function clientWithFixtures(completeEvents = true): VerifyClient {
  const logs = [pool.created, launch.launch, ...curve.logs, ...v4].map(logOf);
  if (completeEvents) logs.push(...[...v4New.logs.Initialize, ...v4New.logs.Donate].map(logOf));
  return {
    getChainId: vi.fn(async () => codes.chainId),
    getBlockNumber: vi.fn(async () => atBlock),
    getCode: vi.fn(async ({ address }) => {
      if (address === syntheticImplementation || syntheticEntryPoints.some(a=>a.toLowerCase()===address.toLowerCase())) return '0x6000';
      const code = Object.values(codes.codes).find(e => e.address.toLowerCase() === address.toLowerCase());
      return code ? `0x${'60'.repeat(code.bytes)}` as Hex : undefined;
    }),
    getStorageAt: vi.fn(async ({ address, slot }) => {
      expect(slot).toBe(IMPLEMENTATION_SLOT);
      return ['tokens.USDG', 'erc8004.identityRegistry'].some(key => registry.addressOf(key as 'tokens.USDG') === address) ? `0x${'0'.repeat(24)}${syntheticImplementation.slice(2)}` as Hex : emptySlot;
    }),
    readContract: vi.fn<VerifyClient['readContract']>(async ({ functionName }) => getAddress(codes.swapRouter02[functionName as 'factory' | 'WETH9'])),
    getLogs: vi.fn(async ({ address, event, fromBlock, toBlock }) => logs.filter(log => log.address.toLowerCase() === address.toLowerCase() && log.topics[0] === toEventSelector(event) && log.blockNumber! >= fromBlock && log.blockNumber! <= toBlock)),
  };
}
const opts = { prelaunch: true, lookback: 100_000n, logChunkSize: 2_000n };
describe('verify:chain injected logic', () => {
  it('checks all registry code sizes, proxy implementations, wiring and captured event topics', async () => {
    const client = clientWithFixtures(); const report = await verifyChain(registry, client, opts);
    expect(report.block).toBe(atBlock);
    expect(report.rows.filter(r => r.check === 'code')).toHaveLength(17);
    expect(report.rows.filter(r => r.check === 'code').every(r => r.ok)).toBe(true);
    for(const v of ['v06','v07','v08'])expect(report.rows.find(r=>r.entry===`entryPoints.${v}` && r.check==='code')).toMatchObject({ok:true});
    expect(report.rows.find(r => r.entry === 'tokens.USDG' && r.check === 'code')?.detail).toContain('170 bytes →');
    expect(report.rows.find(r => r.check === 'factory')?.ok).toBe(true);
    expect(report.rows.find(r => r.check === 'WETH9')?.ok).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.rows.filter(r => r.check === 'event Initialize' || r.check === 'event Donate').every(r => r.ok)).toBe(true);
  });
  it('passes with real event fixtures while D0 TODOs remain informational', async () => {
    const report = await verifyChain(registry, clientWithFixtures(true), opts);
    expect(report.ok).toBe(true);
    expect(report.rows.find(r => r.entry === 'ours.burnWallet')).toMatchObject({ ok: true, detail: 'not deployed (required for D0)' });
    expect(report.rows.filter(r => r.check.startsWith('event '))).toHaveLength(9);
  });
  it('refuses a different chain before reading any code or logs', async () => {
    const client = clientWithFixtures(); client.getChainId = vi.fn(async () => 1);
    expect((await verifyChain(registry, client, opts)).ok).toBe(false);
    expect(client.getCode).not.toHaveBeenCalled(); expect(client.getLogs).not.toHaveBeenCalled();
  });
  it('fails missing T entries without failing optional or D0 TODOs', async () => {
    const altered = loadRegistry(); altered.data.uniswapV3.quoterV2.address = 'TODO';
    const report = await verifyChain(altered, clientWithFixtures(true), opts);
    expect(report.rows.find(r => r.entry === 'uniswapV3.quoterV2')).toMatchObject({ ok: false, check: 'registry' }); expect(report.ok).toBe(false);
  });
  it('fails missing code, missing implementation code and an empty proxy slot', async () => {
    for (const failure of ['code', 'implementation', 'slot']) {
      const client = clientWithFixtures(true); const original = client.getCode;
      if (failure === 'slot') client.getStorageAt = async () => emptySlot;
      else client.getCode = async input => (failure === 'code' && input.address === registry.addressOf('tokens.WETH')) || (failure === 'implementation' && input.address === syntheticImplementation) ? '0x' : original(input);
      const report = await verifyChain(registry, client, opts);
      expect(report.ok).toBe(false);
      expect(report.rows.some(r => !r.ok && /No code|slot is empty/.test(r.detail))).toBe(true);
    }
  });
  it('fails proxy cycles and malformed storage', async () => {
    for (const storage of [`0x${'0'.repeat(24)}${registry.requireAddress('tokens.USDG').slice(2)}`, '0x1234']) {
      const client = clientWithFixtures(true); client.getStorageAt = async () => storage as Hex;
      expect((await verifyChain(registry, client, opts)).ok).toBe(false);
    }
  });
  it('fails incorrect router wiring and RPC errors while retaining table rows', async () => {
    const client = clientWithFixtures(true); client.readContract = async () => zeroAddress;
    client.getCode = async () => { throw new Error('fixture RPC failure'); };
    const report = await verifyChain(registry, client, opts);
    expect(report.rows.filter(r => ['factory', 'WETH9'].includes(r.check)).every(r => !r.ok)).toBe(true);
    expect(report.rows.filter(r => r.check === 'code')).toHaveLength(17); expect(report.ok).toBe(false);
  });
  it('checks exact topics, emitter and strict decoding for retrieved logs', async () => {
    for (const mutation of ['topic', 'data', 'emitter']) {
      const client = clientWithFixtures(true); const original = client.getLogs;
      client.getLogs = async input => (await original(input)).map(log => mutation === 'topic' ? { ...log, topics: [emptySlot] } : mutation === 'data' ? { ...log, data: '0x' } : { ...log, address: zeroAddress });
      const report = await verifyChain(registry, client, opts);
      expect(report.ok).toBe(false); expect(report.rows.some(r => !r.ok && r.check.startsWith('event '))).toBe(true);
    }
  });
  it('scans logs backwards in bounded chunks without going below genesis', async () => {
    const client = clientWithFixtures(); client.getBlockNumber = async () => 25n; client.getLogs = vi.fn(async () => []);
    await verifyChain(registry, client, { prelaunch: true, lookback: 100n, logChunkSize: 10n });
    expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 16n, toBlock: 25n }));
    expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 0n, toBlock: 15n }));
    expect(vi.mocked(client.getLogs).mock.calls.every(([input]) => input.fromBlock >= 0n && input.toBlock <= 25n)).toBe(true);
  });
  it.each([
    new Error('logs matched by query exceeds limit of 10000'),
    new Error('RPC request failed', { cause: new Error('HTTP response body exceeded the size limit') }),
    new Error('too many results'),
  ])('halves dense windows at the same endpoint and stops once a matching log is found: %s', async error => {
    const client = clientWithFixtures(); const original = client.getLogs;
    const queries: Parameters<VerifyClient['getLogs']>[0][] = [];
    client.getLogs = async input => {
      if (input.address !== registry.addressOf('uniswapV4.poolManager') || input.event.name !== 'Swap') return original(input);
      queries.push(input);
      if (input.toBlock - input.fromBlock + 1n > 500n) throw error;
      return [{ ...logOf(v4[0]), blockNumber: input.toBlock }];
    };
    const report = await verifyChain(registry, client, opts);
    expect(report.ok).toBe(true);
    expect(queries.map(q => q.toBlock - q.fromBlock + 1n)).toEqual([2000n, 1000n, 500n]);
    expect(queries.every(q => q.toBlock === atBlock)).toBe(true);
  });
  it('grows successful empty windows after a shrink without gaps, and caps growth at 20,000 blocks', async () => {
    const client = clientWithFixtures(); const original = client.getLogs;
    const queries: Parameters<VerifyClient['getLogs']>[0][] = [];
    client.getLogs = async input => {
      if (input.address !== registry.addressOf('uniswapV4.poolManager') || input.event.name !== 'Swap') return original(input);
      queries.push(input);
      if (queries.length === 1) throw new Error('too many results');
      return queries.length === 4 ? [{ ...logOf(v4[0]), blockNumber: input.toBlock }] : [];
    };
    const report = await verifyChain(registry, client, { prelaunch: true, lookback: 128n, logChunkSize: 8n });
    expect(report.rows.find(r => r.entry === 'uniswapV4.poolManager' && r.check === 'event Swap')?.ok).toBe(true);
    expect(queries.map(q => [q.fromBlock, q.toBlock])).toEqual([
      [atBlock - 7n, atBlock], [atBlock - 3n, atBlock],
      [atBlock - 11n, atBlock - 4n], [atBlock - 27n, atBlock - 12n],
    ]);
    queries.length = 0;
    client.getLogs = async input => {
      if (input.address === registry.addressOf('uniswapV4.poolManager') && input.event.name === 'Swap') queries.push(input);
      return [];
    };
    await verifyChain(registry, client, { prelaunch: true, lookback: 100_000n, logChunkSize: 10_000n });
    expect(queries.map(q => q.toBlock - q.fromBlock + 1n)).toEqual([10_000n, 20_000n, 20_000n, 20_000n, 20_000n, 10_000n]);
  });
  it('stops at a one-block floor on capacity errors and does not retry unrelated errors', async () => {
    for (const message of ['HTTP response body exceeded the size limit', 'fixture RPC unavailable']) {
      const client = clientWithFixtures(); const original = client.getLogs;
      const widths: bigint[] = [];
      client.getLogs = async input => {
        if (input.address !== registry.addressOf('uniswapV4.poolManager') || input.event.name !== 'Swap') return original(input);
        widths.push(input.toBlock - input.fromBlock + 1n); throw new Error(message);
      };
      const report = await verifyChain(registry, client, { prelaunch: true, lookback: 100n, logChunkSize: 8n });
      expect(report.rows.find(r => r.entry === 'uniswapV4.poolManager' && r.check === 'event Swap')).toMatchObject({ ok: false, detail: message });
      expect(widths).toEqual(message.includes('size limit') ? [8n, 4n, 2n, 1n] : [8n]);
    }
  });
  it('checks recent unique Pons curves newest first and finds sells on an older launch', async () => {
    const client = clientWithFixtures(); const original = client.getLogs;
    const newer = getAddress(numberToHex(1234n, { size: 20 }));
    const launchEvent = ponsFactoryAbi.find((a): a is AbiEvent => a.type === 'event')!;
    const makeLaunch = (address: Address, logIndex: number) => ({ ...syntheticLog(registry.requireAddress('pons.factory'), launchEvent, {
      ...launch.launch.args, curve: address, launchConfigId: 0n, graduationThreshold: 4200000000000000000n,
    }), blockNumber: atBlock, logIndex });
    const queries: Address[] = [];
    client.getLogs = async input => {
      if (input.event.name === 'TokenLaunched') return [makeLaunch(newer, 1), makeLaunch(getAddress(curve.curve), 0), makeLaunch(newer, 2)];
      if (input.event.name === 'CurveSell') queries.push(input.address);
      return original(input);
    };
    const report = await verifyChain(registry, client, opts);
    expect(report.ok).toBe(true);
    expect([...new Set(queries)]).toEqual([newer, getAddress(curve.curve)]);
    expect(report.rows.find(r => r.check === 'event CurveSell')?.detail).toContain(`curve ${curve.curve}`);
  });
  it('passes unobserved Pons events only when their topic is present in deployed curve bytecode', async () => {
    const sellEvent = ponsCurveAbi.find((a): a is AbiEvent => a.type === 'event' && a.name === 'CurveSell')!;
    const topic = toEventSelector(sellEvent);
    for (const code of [`0x60${topic.slice(2)}00`, '0x6000']) {
      const client = clientWithFixtures(); const getLogs = client.getLogs, getCode = client.getCode;
      client.getLogs = async input => input.event.name === 'CurveSell' ? [] : getLogs(input);
      client.getCode = async input => input.address.toLowerCase() === curve.curve.toLowerCase() ? code as Hex : getCode(input);
      const report = await verifyChain(registry, client, opts);
      const row = report.rows.find(r => r.check === 'event CurveSell')!;
      expect(row.ok).toBe(code.includes(topic.slice(2)));
      expect(report.ok).toBe(row.ok);
      expect(row.detail).toContain(row.ok ? 'not emitted recently (checked 1 curve(s))' : 'No recent log or topic');
    }
  });
  it('limits Pons discovery to 20 unique recent curves, and reuses bytecode reads for unobserved events', async () => {
    const client = clientWithFixtures(); const original = client.getLogs;
    const launchEvent = ponsFactoryAbi.find((a): a is AbiEvent => a.type === 'event')!;
    const candidates = Array.from({ length: 21 }, (_, i) => getAddress(numberToHex(BigInt(1000 + i), { size: 20 })));
    const launches = candidates.map((address, logIndex) => ({ ...syntheticLog(registry.requireAddress('pons.factory'), launchEvent, {
      ...launch.launch.args, curve: address, launchConfigId: 0n, graduationThreshold: 4200000000000000000n,
    }), blockNumber: atBlock, logIndex }));
    const curvesRead: Address[] = [], codeRead: Address[] = [];
    const getCode = client.getCode;
    client.getCode = async input => { if (candidates.includes(input.address)) codeRead.push(input.address); return getCode(input); };
    client.getLogs = async input => {
      if (input.event.name === 'TokenLaunched') return launches;
      if (['CurveBuy', 'CurveSell', 'SnipeTaxExempted'].includes(input.event.name)) { curvesRead.push(input.address); return []; }
      return original(input);
    };
    const report = await verifyChain(registry, client, { prelaunch: true, lookback: 1n, logChunkSize: 1n });
    expect([...new Set(curvesRead)]).toEqual(candidates.slice(1).reverse());
    expect(codeRead).toEqual(candidates.slice(1).reverse());
    expect(report.rows.filter(r => r.entry === 'pons.curve').every(r => !r.ok && r.detail.includes('20 curve(s)'))).toBe(true);
  });
  it('does not replace Pons query failures or malformed logs with bytecode evidence', async () => {
    for (const failure of ['capacity', 'data']) {
      const client = clientWithFixtures(); const original = client.getLogs;
      client.getLogs = async input => {
        if (input.event.name !== 'CurveSell') return original(input);
        if (failure === 'capacity') throw new Error('logs matched by query exceeds limit of 10000');
        return [{ ...logOf(curve.logs[0]), address: getAddress(curve.curve), topics: [toEventSelector(ponsCurveAbi.find((a): a is AbiEvent => a.type === 'event' && a.name === 'CurveSell')!)], data: '0x' }];
      };
      const report = await verifyChain(registry, client, { prelaunch: true, lookback: 100_000n, logChunkSize: 2_000n });
      expect(report.rows.find(r => r.check === 'event CurveSell')?.ok).toBe(false);
      expect(vi.mocked(client.getCode).mock.calls.some(([input]) => input.address.toLowerCase() === curve.curve.toLowerCase())).toBe(false);
    }
  });
  it('pins Pons signatures to the provided ABI fragments', () => {
    expect(ponsFactoryAbi.filter((a): a is AbiEvent => a.type === 'event').map(a => a.name)).toEqual(['TokenLaunched']);
    expect(ponsCurveAbi.filter((a): a is AbiEvent => a.type === 'event').map(a => a.name)).toEqual(expect.arrayContaining(['CurveBuy', 'CurveSell', 'SnipeTaxExempted']));
  });
});

function ownedSetup() {
  const registry = loadRegistry();
  const address = getAddress(numberToHex(900n, { size: 20 }));
  const owner = getAddress(numberToHex(901n, { size: 20 }));
  const committer = getAddress(numberToHex(902n, { size: 20 }));
  const code: Hex = '0x60006000';
  const ref = registry.data.ours.receiptsRegistry.build_record!;
  Object.assign(registry.data.ours.receiptsRegistry, { address, owner, committer });
  const buildRecords: BuildRecords = { [ref]: {
    schemaVersion: 1, contract: 'src/ReceiptsRegistry.sol:ReceiptsRegistry', runtimeCodeHash: keccak256(code), immutableReferences: {},
  } };
  const client = clientWithFixtures();
  const getCode = client.getCode, readContract = client.readContract;
  client.getCode = vi.fn(async input => input.address === address ? code : getCode(input));
  client.readContract = vi.fn(async input => input.address !== address ? readContract(input) :
    input.functionName === 'owner' ? owner : input.functionName === 'committer' ? committer : zeroAddress);
  return { registry, client, options: { ...opts, buildRecords }, address, owner, committer, ref };
}

describe('manifest-driven EKO release verification', () => {
  it('matches bytecode and all roles at the recorded block, including in prelaunch mode', async () => {
    const { registry, client, options, address } = ownedSetup();
    const report = await verifyChain(registry, client, options);
    expect(report).toMatchObject({ ok: true, complete: true, block: atBlock });
    expect(report.rows.filter(row => row.entry === 'ours.receiptsRegistry')).toEqual([
      expect.objectContaining({ check: 'runtime hash', ok: true }),
      expect.objectContaining({ check: 'owner', ok: true }),
      expect.objectContaining({ check: 'pendingOwner', ok: true, detail: zeroAddress }),
      expect.objectContaining({ check: 'committer', ok: true }),
    ]);
    expect(vi.mocked(client.getCode).mock.calls.filter(([input]) => input.address === address)).toEqual([[{ address, blockNumber: atBlock }]]);
    expect(vi.mocked(client.readContract).mock.calls.filter(([input]) => input.address === address).map(([input]) => input.blockNumber)).toEqual([atBlock, atBlock, atBlock]);
  });
  it.each(['runtime hash', 'owner', 'pendingOwner', 'committer'])('fails a %s mismatch', async check => {
    const { registry, client, options, address, committer } = ownedSetup();
    if (check === 'runtime hash') {
      const original = client.getCode;
      client.getCode = async input => input.address === address ? '0x6001' : original(input);
    } else {
      const original = client.readContract;
      client.readContract = async input => input.address === address && input.functionName === check ? (check === 'pendingOwner' ? committer : zeroAddress) : original(input);
    }
    const report = await verifyChain(registry, client, options);
    expect(report.ok).toBe(false);
    expect(report.rows.find(row => row.entry === 'ours.receiptsRegistry' && row.check === check)?.ok).toBe(false);
  });
  it.each(['0x', undefined, '0x1'])('fails missing or malformed registry code: %s', async code => {
    const { registry, client, options, address } = ownedSetup();
    const original = client.getCode;
    client.getCode = async input => input.address === address ? code as Hex | undefined : original(input);
    expect((await verifyChain(registry, client, options)).ok).toBe(false);
  });
  it.each(['owner', 'committer', 'build_record'])('fails an incomplete deployed manifest: %s', async field => {
    for (const value of [undefined, 'TODO'] as const) {
      const { registry, client, options } = ownedSetup();
      registry.data.ours.receiptsRegistry[field as 'owner' | 'committer' | 'build_record'] = value;
      expect((await verifyChain(registry, client, options)).ok).toBe(false);
    }
  });
  it('fails absent, malformed, unsupported-immutable and wrong-contract records', async () => {
    const { registry, client, options, ref } = ownedSetup();
    for (const record of [undefined, { ...options.buildRecords[ref], runtimeCodeHash: '0x12' },
      { ...options.buildRecords[ref], immutableReferences: { '1': [{ start: 1, length: 32 }] } },
      { ...options.buildRecords[ref], contract: 'SomeOtherContract' }]) {
      const report = await verifyChain(registry, client, { ...options, buildRecords: { [ref]: record } as BuildRecords });
      expect(report.ok).toBe(false);
      expect(report.rows.find(row => row.check === 'runtime hash')?.ok).toBe(false);
    }
  });
  it('fails a zero deployment, zero owner and any unsupported deployed EKO contract', async () => {
    for (const failure of ['address', 'owner', 'unsupported']) {
      const { registry, client, options, address } = ownedSetup();
      if (failure === 'unsupported') registry.data.ours.burnEngine.address = address;
      else registry.data.ours.receiptsRegistry[failure as 'address' | 'owner'] = zeroAddress;
      expect((await verifyChain(registry, client, options)).ok).toBe(false);
    }
  });
  it.each(['getChainId', 'getBlockNumber', 'getCode', 'readContract'] as const)('fails unreachable %s', async method => {
    const { registry, client, options } = ownedSetup();
    client[method] = async () => { throw new Error('fixture RPC unreachable'); };
    const report = await verifyChain(registry, client, options);
    expect(report.ok).toBe(false);
    expect(report.rows.some(row => !row.ok && row.detail.includes('unreachable'))).toBe(true);
  });
  it('loads the committed record referenced by the manifest', () => {
    const records = loadBuildRecords(registry);
    expect(records[registry.data.ours.receiptsRegistry.build_record!]).toMatchObject({
      schemaVersion: 1, contract: 'src/ReceiptsRegistry.sol:ReceiptsRegistry', immutableReferences: {},
      runtimeCodeHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
  });
  it('reports not deployed explicitly and fails without prelaunch mode', async () => {
    const report = await verifyChain(registry, clientWithFixtures(), { ...opts, prelaunch: false });
    expect(report).toMatchObject({ ok: false, complete: true });
    expect(report.rows.find(row => row.entry === 'ours.receiptsRegistry')).toMatchObject({ ok: false, detail: 'not deployed (required for D0)' });
    expect((await verifyChain(registry, clientWithFixtures(), opts)).ok).toBe(true);
  });
});

describe('incomplete verification and command exit codes', () => {
  const run = async (prelaunch: boolean, change?: (client: VerifyClient, controller: AbortController) => void, timeoutMs?: number) => {
    const controller = new AbortController();
    const client = clientWithFixtures();
    change?.(client, controller);
    const output = vi.fn();
    const code = await runVerifyCommand(registry, client, { prelaunch, buildRecords: loadBuildRecords(registry), signal: controller.signal, timeoutMs, output });
    return { code, output, client };
  };
  it('exits 1 for undeployed entries by default and explicitly identifies prelaunch success', async () => {
    const strict = await run(false), prelaunch = await run(true);
    expect(strict.code).toBe(1);
    expect(strict.output.mock.calls[0][1]).toContain('not deployed');
    expect(prelaunch.code).toBe(0);
    expect(prelaunch.output.mock.calls[0][1]).toContain('prelaunch; deployment verification incomplete');
  });
  it('exits 0 for a complete deployed manifest', async () => {
    const { registry, client, options } = ownedSetup();
    // Only declared deployments are in this release fixture; production YAML keeps later TODO entries explicit.
    const entries = registry.entries().filter(([, entry]) => entry.address !== 'TODO');
    vi.spyOn(registry, 'entries').mockReturnValue(entries);
    expect(await runVerifyCommand(registry, client, { ...options, prelaunch: false, output: vi.fn() })).toBe(0);
  });
  it.each(['rpc_session_budget_reached', 'rpc_budget_exhausted', 'shutdown_requested'] as const)('exits 1 with incomplete report on %s, including wrapped errors', async reason => {
    const { code, output } = await run(true, client => {
      client.getLogs = async () => { throw new Error('wrapped transport failure', { cause: new RpcGuardError(reason) }); };
    });
    expect(code).toBe(1);
    expect(output.mock.calls[0][0]).toMatchObject({ ok: false, complete: false });
  });
  it('exits 1 before any RPC if already interrupted', async () => {
    const { code, output, client } = await run(true, (_client, controller) => controller.abort());
    expect(code).toBe(1);
    expect(client.getChainId).not.toHaveBeenCalled();
    expect(output.mock.calls[0][0].complete).toBe(false);
  });
  it('exits 1 if interrupted during an unreachable read', async () => {
    const { code, output } = await run(true, (client, controller) => {
      client.getChainId = async () => { queueMicrotask(() => controller.abort()); return new Promise<number>(() => {}); };
    });
    expect(code).toBe(1);
    expect(output.mock.calls[0][0].complete).toBe(false);
  });
  it('exits 1 even if interruption arrives with the last successful RPC', async () => {
    const { code } = await run(true, (client, controller) => {
      const getLogs = client.getLogs;
      client.getLogs = async input => {
        const logs = await getLogs(input);
        if (input.event.name === 'Donate') controller.abort();
        return logs;
      };
    });
    expect(code).toBe(1);
  });
  it('exits 1 on the total deadline even when the RPC never settles', async () => {
    const { code, output } = await run(true, client => { client.getChainId = () => new Promise<number>(() => {}); }, 10);
    expect(code).toBe(1);
    expect(output.mock.calls[0][0]).toMatchObject({ ok: false, complete: false });
    expect(output.mock.calls[0][0].rows.some((row: { detail: string }) => row.detail.includes('deadline exhausted'))).toBe(true);
  });
  it('rejects invalid timeout settings and unknown or repeated CLI options', async () => {
    expect(verificationMode([])).toBe(false);
    expect(verificationMode(['--prelaunch'])).toBe(true);
    for (const args of [['--unknown'], ['--prelaunch', '--prelaunch']]) expect(() => verificationMode(args)).toThrow('Usage');
    for (const timeoutMs of [0, -1, Infinity, NaN]) {
      await expect(verifyChain(registry, clientWithFixtures(), { timeoutMs })).rejects.toThrow('timeoutMs');
    }
  });
});
