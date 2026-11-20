import { readFileSync } from 'node:fs';
import { getAddress, zeroAddress, type Hex } from 'viem';
import type { CoinState } from '../../src/tracker.js';

/** A real Pons launch (NYMO, Robinhood Chain): a two-wallet bundle bought in one transaction one block after launch,
 *  passed its tokens through 13 fresh wallets and sold out; two trading bots' copy traders bought in the same seconds. */
export const fx = JSON.parse(readFileSync(new URL('./nymo-launch.json', import.meta.url), 'utf8')) as {
  token: string; deployer: string; curve: string; factory: string; manager: string; launchBlock: number; launchTs: number; launchTx: string;
  ts: Record<string, number>; trades: [number, string, string, 'b' | 's'][]; flows: [number, string, string, string, string][] };
const pad = (tx: string) => tx.padEnd(66, '0') as Hex;
export function nymo(): CoinState {
  const at = (b: number) => fx.launchTs + (fx.ts[b] ?? Math.round(b * 0.102));
  return {
    launchpad: 'pons', key: null, flipped: false, supplyFromMints: false, launcher: getAddress(fx.factory), manager: getAddress(fx.manager), token: getAddress(fx.token),
    creator: getAddress(fx.deployer), poolId: `0x${'0'.repeat(64)}`, quote: zeroAddress, supply: 10n ** 27n, configId: 0n, firstBuyIn: 0n, firstBuyOut: 0n,
    feeRecipient: getAddress(fx.deployer), feeLocked: true, block: fx.launchBlock, ts: fx.launchTs, tx: pad(fx.launchTx), netHype: 0, sqrtPriceX96: null, graduated: true,
    name: 'Anonymo', symbol: 'NYMO', curve: { address: getAddress(fx.curve), graduationThreshold: 0n, realQuoteReserve: 0n, realTokenReserve: 0n },
    trades: fx.trades.map(([b, tx, sender, side]) => ({ ts: at(b), block: fx.launchBlock + b, tx: pad(tx), sender: getAddress(sender), side: side === 'b' ? 'buy' : 'sell', hype: 0, tokens: 0, priceHype: 0 })),
    flows: fx.flows.map(([b, tx, from, to, v]) => ({ tx: pad(tx), block: fx.launchBlock + b, ts: at(b), from, to, value: BigInt(v) })),
  } as CoinState;
}
