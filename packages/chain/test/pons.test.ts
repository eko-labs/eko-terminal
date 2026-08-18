import { describe, expect, it, vi } from 'vitest';
import { getAddress, toEventSelector, type AbiEvent, type Address } from 'viem';
import { createPonsAdapter, decodePons, decodePonsResult, dedupeExempt, readPonsProfile } from '../src/launchpads/pons.js';
import { loadRegistry } from '../src/registry.js';
import { ponsCurveAbi, ponsFactoryAbi } from '../src/abis.js';
import { logOf } from './helpers.js';
import launch from './fixtures/4663/pons-launch.json' with { type: 'json' };
import curve from './fixtures/4663/pons-curve-logs.json' with { type: 'json' };
import reads from './fixtures/4663/pons-curve-reads.json' with { type: 'json' };
import buy from './fixtures/4663/pons-buy-tx.json' with { type: 'json' };
const registry = loadRegistry();
const tx = { from: getAddress(buy.from), to: getAddress(buy.to) };
const ctx = { registry, tokenForCurve: (address: Address) => address.toLowerCase() === curve.curve.toLowerCase() ? getAddress(curve.token) : null };
describe('Pons adapter', () => {
  it('implements the adapter interface and obtains addresses only from the registry', () => {
    expect(createPonsAdapter(ctx).addresses()).toEqual(['pons.factory', 'pons.v4Hook', 'pons.router'].map(key => registry.addressOf(key as 'pons.factory')));
    expect(createPonsAdapter(ctx).id).toBe('pons');
  });
  it('checks the launch topic and preserves token, deployer and curve', () => {
    const event = ponsFactoryAbi.find(e => e.type === 'event')!;
    expect(launch.launch.topics[0]).toBe(toEventSelector(event));
    expect(decodePons(logOf(launch.launch), tx, ctx)).toEqual([{ kind: 'launch', token: launch.launch.args.token, deployer: launch.launch.args.deployer, curve: launch.launch.args.curve, pairToken: launch.launch.args.pairToken, launchConfigId: BigInt(launch.launch.args.launchConfigId), graduationThreshold: BigInt(launch.launch.args.graduationThreshold) }]);
    expect(decodePons({ ...logOf(launch.launch), address: tx.from }, tx, ctx)).toEqual([]);
  });
  it('decodes real buys, sells and exemptions, maps the curve to its token and dedupes exemptions', () => {
    const events = curve.logs.flatMap(l => decodePons(logOf(l), tx, ctx));
    expect(events.filter(e => e.kind === 'trade' && e.side === 1)).toHaveLength(13);
    expect(events.filter(e => e.kind === 'trade' && e.side === -1)).toHaveLength(1);
    for (const name of ['CurveBuy', 'CurveSell', 'SnipeTaxExempted']) {
      const abi = ponsCurveAbi.find((a): a is AbiEvent => a.type === 'event' && a.name === name)!;
      expect(curve.logs.some(l => l.topics[0] === toEventSelector(abi))).toBe(true);
    }
    const buyEvent = events.find(e => e.kind === 'trade' && e.side === 1)!;
    const buyLog = curve.logs.find(l => l.topics[0] === toEventSelector(ponsCurveAbi.find((a): a is AbiEvent => a.type === 'event' && a.name === 'CurveBuy')!))!;
    const words = buyLog.data.slice(2).match(/.{64}/g)!.map(w => BigInt(`0x${w}`));
    expect(buyEvent).toEqual({ kind: 'trade', token: curve.token, actor: tx.from, side: 1, amountEth: words[0], amountToken: words[1], feeEth: words[2], taxEth: words[3], buyer: getAddress(`0x${buyLog.topics[1].slice(-40)}`), recipient: getAddress(`0x${buyLog.topics[2].slice(-40)}`) });
    const sellLog = curve.logs.find(l => l.topics[0] === toEventSelector(ponsCurveAbi.find((a): a is AbiEvent => a.type === 'event' && a.name === 'CurveSell')!))!;
    const sellWords = sellLog.data.slice(2).match(/.{64}/g)!.map(w => BigInt(`0x${w}`));
    expect(decodePons(logOf(sellLog), tx, ctx)[0]).toMatchObject({ side: -1, amountToken: sellWords[0], amountEth: sellWords[1], feeEth: sellWords[2], taxEth: sellWords[3] });
    const launchBlock = curve.logs.filter(l => l.blockNumber === reads.launchBlock).flatMap(l => decodePons(logOf(l), tx, ctx));
    expect(launchBlock.filter(e => e.kind === 'exempt')).toHaveLength(9);
    expect(dedupeExempt(launchBlock).filter(e => e.kind === 'exempt')).toHaveLength(6);
    expect(dedupeExempt(launchBlock).filter(e => e.kind === 'trade')).toEqual(launchBlock.filter(e => e.kind === 'trade'));
    expect(decodePons(logOf(buyLog), tx, { ...ctx, tokenForCurve: () => null })).toEqual([]);
    expect(decodePons(logOf(buyLog), tx, { ...ctx, userOpSender: getAddress(curve.token) })[0]).toMatchObject({ actor: curve.token });
  });
  it('counts unknown router/graduation topics and malformed payloads without throwing', () => {
    expect(decodePonsResult(logOf(curve.logs[0]), tx, ctx)).toEqual({ events: [], unknownTopics: 1, malformedLogs: 0 });
    expect(decodePonsResult({ ...logOf(launch.launch), data: '0x' }, tx, ctx)).toEqual({ events: [], unknownTopics: 0, malformedLogs: 1 });
    expect(decodePonsResult({ ...logOf(launch.launch), address: registry.requireAddress('pons.router') }, tx, ctx)).toEqual({ events: [], unknownTopics: 1, malformedLogs: 0 });
  });
  it('reads captured anti-snipe values at the requested block through an injected client', async () => {
    const launchBlock = BigInt(reads.launchBlock);
    const readContract = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => BigInt(blockNumber === launchBlock ? reads.snipeAtLaunch : reads.snipeNow));
    const adapter = createPonsAdapter(ctx, { client: { readContract }, curveForToken: token => token === curve.token ? getAddress(curve.curve) : null, endsInSec: async () => 5 });
    expect(await adapter.antiSnipe!(getAddress(curve.token), launchBlock)).toEqual({ taxPct: 99, endsInSec: 5 });
    expect(await adapter.antiSnipe!(getAddress(curve.token), launchBlock + 100n)).toEqual({ taxPct: 0, endsInSec: 0 });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: curve.curve, args: [curve.token], functionName: 'currentSnipeTaxBps', blockNumber: launchBlock }));
    expect(await adapter.antiSnipe!(tx.from, launchBlock)).toBeNull();
    const noTiming = createPonsAdapter(ctx, { client: { readContract }, curveForToken: () => getAddress(curve.curve) });
    expect(await noTiming.antiSnipe!(getAddress(curve.token), launchBlock)).toBeNull();
  });
  it('reads the profile getters in one call when the client batches them, else one call each, with the same result', async () => {
    const token = getAddress(curve.token), at = getAddress(curve.curve), blockNumber = 5n;
    const values: Record<string, bigint> = { creatorTaxBps: 1000n, feeBps: 100n, currentSnipeTaxBps: 0n };
    const requests: string[] = [];
    const getCode = async () => { requests.push('getCode'); return '0x6080' as const; };
    const readContract = async (input: { functionName: string }) => { requests.push(input.functionName); return values[input.functionName]; };
    const separate = await readPonsProfile({ readContract, getCode }, token, at, blockNumber);
    expect(requests.sort()).toEqual(['creatorTaxBps', 'currentSnipeTaxBps', 'feeBps', 'getCode']);
    requests.length = 0;
    const readGetters = async (input: { curve: Address; token: Address; blockNumber: bigint }) => {
      requests.push('getters'); expect(input).toEqual({ curve: at, token, blockNumber });
      return [values.creatorTaxBps, values.feeBps, values.currentSnipeTaxBps] as const;
    };
    expect(await readPonsProfile({ readContract, getCode, readGetters }, token, at, blockNumber)).toEqual(separate);
    expect(requests.sort()).toEqual(['getCode', 'getters']);
    expect(separate).toMatchObject({ creatorTaxPct: 10, feePct: 1, antiSnipeActive: false });
    // A failed batched read fails the profile, as a failed getter did.
    await expect(readPonsProfile({ readContract, getCode, readGetters: async () => { throw new Error('reverted'); } }, token, at, blockNumber)).rejects.toThrow('reverted');
  });
});
