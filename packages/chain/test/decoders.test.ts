import { describe, expect, it } from 'vitest';
import { getAddress, toEventSelector, type Address, type Hex } from 'viem';
import { decode, decodeBatch, decodeResult } from '../src/decoders.js';
import { v3Abi, v4Abi, verifiedV4Events, wethAbi, erc20Abi } from '../src/abis.js';
import { loadRegistry } from '../src/registry.js';
import { resolveActor } from '../src/actor.js';
import { logOf, syntheticLog } from './helpers.js';
import pool from './fixtures/4663/v3-pool.json' with { type: 'json' };
import v4 from './fixtures/4663/v4-poolmanager-logs.json' with { type: 'json' };
import v4New from './fixtures/4663/v4-initialize-donate-logs.json' with { type: 'json' };
import transfers from './fixtures/4663/erc20-transfer-logs.json' with { type: 'json' };
import weth from './fixtures/4663/weth-logs.json' with { type: 'json' };
import buy from './fixtures/4663/pons-buy-tx.json' with { type: 'json' };
const registry = loadRegistry();
const tx = { from: getAddress(buy.from), to: buy.to ? getAddress(buy.to) : null };
const ctx = { registry, tx, isV3Pool: (address: Address) => address.toLowerCase() === pool.created.args.pool.toLowerCase() };
describe('standard decoders', () => {
  it('checks v3 topics and fields against the captured factory and pool', () => {
    expect(pool.created.topics[0]).toBe(toEventSelector(v3Abi[0]));
    const created = decode(logOf(pool.created), ctx)[0];
    expect(created).toMatchObject({ source: 'uniswap_v3', eventName: 'PoolCreated', args: { token0: pool.created.args.token0, token1: pool.created.args.token1, fee: 10000, tickSpacing: 200, pool: pool.created.args.pool } });
    const result = decodeBatch(pool.logs.map(logOf), ctx);
    expect(result.unknownTopics).toBe(0); expect(result.malformedLogs).toBe(0);
    expect(new Set(result.events.map(e => e.eventName))).toEqual(new Set(['Initialize', 'Mint', 'Swap']));
    for (const event of result.events) {
      const abi = v3Abi.find(a => a.name === event.eventName)!;
      expect(pool.logs.some(l => l.topics[0] === toEventSelector(abi))).toBe(true);
    }
    const swap = result.events.find(e => e.source === 'uniswap_v3' && e.eventName === 'Swap')!;
    if (swap.source === 'uniswap_v3' && swap.eventName === 'Swap') {
      expect(typeof swap.args.amount0).toBe('bigint'); expect(typeof swap.args.amount1).toBe('bigint');
      expect(swap.args.recipient).toMatch(/^0x/); expect(swap.actor).toBe(tx.from);
    }
    expect(decode(logOf(pool.created), { registry })).toHaveLength(1);
    expect(decode(logOf(pool.logs[0]), { registry })).toEqual([]);
    expect(decode({ ...logOf(pool.created), address: getAddress(pool.created.args.pool) }, ctx)).toEqual([]);
  });
  it('decodes a synthetic Burn (not present in the v3 fixture window)', () => {
    const burn = syntheticLog(getAddress(pool.created.args.pool), v3Abi[4], { owner: tx.from, tickLower: -200, tickUpper: 200, amount: 123n, amount0: 1n, amount1: 2n });
    expect(decode(burn, ctx)[0]).toMatchObject({ eventName: 'Burn', args: { owner: tx.from, tickLower: -200, amount: 123n } });
  });
  it('checks all four v4 selectors against real logs and decodes every observed event shape', () => {
    const allLogs = [...v4, ...v4New.logs.Initialize, ...v4New.logs.Donate];
    const topics = new Set(allLogs.map(l => l.topics[0]));
    const observed = v4Abi.filter(a => topics.has(toEventSelector(a))).map(a => a.name);
    expect(observed).toEqual([...verifiedV4Events]);
    expect(topics).toEqual(new Set(observed.map(name => toEventSelector(v4Abi.find(a => a.name === name)!))));
    const result = decodeBatch(allLogs.map(logOf), ctx);
    expect(result.events).toHaveLength(allLogs.length); expect(result.unknownTopics).toBe(0); expect(result.malformedLogs).toBe(0);
    expect(result.events.filter(e => e.eventName === 'Swap')).toHaveLength(19);
    expect(result.events.filter(e => e.eventName === 'ModifyLiquidity')).toHaveLength(1);
    expect(result.events.filter(e => e.eventName === 'Initialize')).toHaveLength(3);
    expect(result.events.filter(e => e.eventName === 'Donate')).toHaveLength(3);
    for (const raw of [...v4New.logs.Initialize, ...v4New.logs.Donate]) {
      expect(decode({ ...logOf(raw), address: tx.from }, ctx)).toEqual([]);
      expect(decodeResult({ ...logOf(raw), data: '0x' }, ctx)).toEqual({ events: [], unknownTopics: 0, malformedLogs: 1 });
    }
  });
  it('preserves Initialize pool currencies and parameters and Donate sender and amounts from the new capture', () => {
    const initialized = decode(logOf(v4New.logs.Initialize[0]), ctx)[0];
    expect(initialized).toMatchObject({ source: 'uniswap_v4', eventName: 'Initialize', args: {
      id: v4New.logs.Initialize[0].topics[1], currency0: '0x0000000000000000000000000000000000000000',
      currency1: getAddress(`0x${v4New.logs.Initialize[0].topics[3].slice(-40)}`),
      fee: 100, tickSpacing: 1, hooks: '0x0000000000000000000000000000000000000000',
      sqrtPriceX96: 792280926924313289846529216293289n, tick: 184216,
    } });
    const donated = decode(logOf(v4New.logs.Donate[0]), ctx)[0];
    expect(donated).toMatchObject({ source: 'uniswap_v4', eventName: 'Donate', args: {
      id: v4New.logs.Donate[0].topics[1], sender: getAddress(`0x${v4New.logs.Donate[0].topics[2].slice(-40)}`),
      amount0: 44299n, amount1: 0n,
    } });
  });
  it('decodes captured token Transfers including WETH, without treating them as Deposit/Withdrawal', () => {
    for (const raw of [...transfers.logs, ...weth]) {
      expect(raw.topics[0]).toBe(toEventSelector(erc20Abi[0]));
      const result = decode(logOf(raw), ctx)[0];
      expect(result).toMatchObject({ source: 'erc20', eventName: 'Transfer' });
      if (result.source === 'erc20') expect(typeof result.args.value).toBe('bigint');
    }
    const result = decode(logOf(transfers.logs[0]), ctx)[0];
    expect(result).toMatchObject({ args: { from: transfers.logs[0].args.from, to: transfers.logs[0].args.to, value: BigInt(transfers.logs[0].args.value) } });
  });
  it('decodes synthetic WETH Deposit and Withdrawal and rejects another emitter', () => {
    for (const event of wethAbi) {
      const log = syntheticLog(registry.requireAddress('tokens.WETH'), event, { dst: tx.from, src: tx.from, wad: 50n });
      expect(decode(log, ctx)[0]).toMatchObject({ source: 'weth', eventName: event.name, args: { wad: 50n } });
      expect(decode({ ...log, address: tx.from }, ctx)).toEqual([]);
    }
  });
  it('returns empty arrays for unknown topics and counts unknown vs malformed logs separately', () => {
    const unknown = { ...logOf(pool.created), topics: [`0x${'ff'.repeat(32)}` as Hex] as [Hex] };
    const malformed = { ...logOf(pool.created), data: '0x' as Hex };
    expect(decode(unknown, ctx)).toEqual([]);
    expect(decodeBatch([unknown, malformed], ctx)).toEqual({ events: [], unknownTopics: 1, malformedLogs: 1 });
  });
});
describe('actor resolution', () => {
  it('uses the captured buy transaction sender', () => expect(resolveActor(tx)).toBe(tx.from));
  it('prioritizes the enclosing UserOp sender over delegation and tx.from', () => {
    expect(resolveActor(tx, { userOpSender: registry.requireAddress('pons.factory'), toCode: `0xef0100${tx.from.slice(2)}` })).toBe(registry.addressOf('pons.factory'));
  });
  it('uses tx.to only for a valid delegation called by another sender', () => {
    const to = registry.requireAddress('pons.router'); const code = `0xef0100${tx.from.slice(2)}` as Hex;
    expect(resolveActor({ ...tx, to }, { toCode: code })).toBe(to);
    expect(resolveActor({ ...tx, to: tx.from }, { toCode: code })).toBe(tx.from);
    expect(resolveActor({ ...tx, to }, { toCode: '0xef0100' })).toBe(tx.from);
    expect(resolveActor({ ...tx, to: null }, { toCode: code })).toBe(tx.from);
    expect(resolveActor({ ...tx, to }, { toCode: '0x6000' })).toBe(tx.from);
  });
});
