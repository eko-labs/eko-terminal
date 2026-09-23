import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, pad, toEventSelector, toHex, type Address, type Hex } from 'viem';
import { erc20Abi } from '@eko/chain';
import { liquidityWallet, swapWallet } from '../src/beneficiary.js';
import type { RpcLog } from '../src/types.js';

// Synthetic logs only. The same cases as the worker's SQL backfill (apps/server/test/coin-onboarding.test.ts).
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const tx = `0x${'7'.repeat(64)}` as Hex, otherTx = `0x${'8'.repeat(64)}` as Hex;
const coin = address(0xa1), manager = address(0x99), v3pool = address(0x31), router = address(0x70), buyer = address(0xb1), seller = address(0xb2), bot = address(0xb3);
const dead = '0x000000000000000000000000000000000000dead' as Address, zero = address(0);
let index = 0;
const transfer = (from: Address, to: Address, value: bigint, token: Address = coin, hash: Hex = tx): RpcLog => ({ address: token, topics: [toEventSelector(erc20Abi[0]), pad(from), pad(to)],
  data: encodeAbiParameters([{ type: 'uint256' }], [value]), blockNumber: '0x1', blockHash: `0x${'1'.repeat(64)}`, transactionHash: hash, logIndex: toHex(index++) });
const pools = (a: string) => a === v3pool;
const wallet = (logs: RpcLog[], side: 1 | -1, pool: string = `0x${'4'.repeat(64)}`) => swapWallet(logs, tx, coin, pool, manager, side, pools);

describe('the wallet behind a swap outside the sender scope', () => {
  it('is the wallet whose balance moved, not a router that passes the coins on', () => {
    expect(wallet([transfer(manager, router, 1000n), transfer(router, buyer, 1000n)], 1)).toEqual({ wallet: buyer, moved: true });
    expect(wallet([transfer(seller, manager, 400n)], -1)).toEqual({ wallet: seller, moved: true });
    expect(wallet([transfer(v3pool, router, 500n), transfer(router, buyer, 500n)], 1, v3pool)).toEqual({ wallet: buyer, moved: true });
  });
  it('is the buyer of a taxed buy, and the contract that took the coins when they were burned', () => {
    expect(wallet([transfer(manager, buyer, 950n), transfer(manager, coin, 50n)], 1)).toEqual({ wallet: buyer, moved: true });
    expect(wallet([transfer(manager, bot, 300n), transfer(bot, dead, 300n)], 1)).toEqual({ wallet: bot, moved: true });
  });
  it('is the wallet that dealt with the pool when it bought and sold in one transaction', () => {
    const logs = [transfer(manager, bot, 700n), transfer(bot, v3pool, 700n)];
    expect(wallet(logs, 1)).toEqual({ wallet: bot, moved: true });
    expect(wallet(logs, -1, v3pool)).toEqual({ wallet: bot, moved: true });
  });
  it('is nobody when the coin did not move, or moved only between pools and the mint address', () => {
    expect(wallet([], 1)).toEqual({ wallet: null, moved: false });
    // Another transaction's transfers, another token's, and an NFT transfer (four topics) do not count.
    const nft: RpcLog = { ...transfer(manager, buyer, 1n), topics: [toEventSelector(erc20Abi[0]), pad(manager), pad(buyer), pad('0x01')], data: '0x' };
    expect(wallet([transfer(manager, buyer, 5n, coin, otherTx), transfer(manager, buyer, 5n, address(0xa2)), nft], 1)).toEqual({ wallet: null, moved: false });
    expect(wallet([transfer(manager, v3pool, 9n), transfer(zero, manager, 9n)], 1)).toEqual({ wallet: null, moved: true });
  });
});
describe('the wallet behind a liquidity event outside the sender scope', () => {
  it('is whoever paid the coins in, or took them out', () => {
    expect(liquidityWallet([transfer(seller, manager, 800_000n)], tx, [coin], `0x${'4'.repeat(64)}`, manager, -1, pools)).toBe(seller);
    expect(liquidityWallet([transfer(manager, buyer, 750_000n)], tx, [coin], `0x${'4'.repeat(64)}`, manager, 1, pools)).toBe(buyer);
    expect(liquidityWallet([transfer(manager, buyer, 750_000n)], tx, [coin], `0x${'4'.repeat(64)}`, manager, -1, pools)).toBeNull();
    expect(liquidityWallet([], tx, [], `0x${'4'.repeat(64)}`, manager, -1, pools)).toBeNull();
  });
});
