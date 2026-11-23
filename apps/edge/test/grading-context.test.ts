import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { loadRegistry } from '@eko/chain';
import { CoinCardSchema, PairRowSchema, RadarRowSchema } from '@eko/shared';
import fx from './fixtures/robinhood/late-graduates.json' with { type: 'json' };
import { PONS_LOCK, ponsPoolReserve, probeRobinhoodCoin, robinhoodAddresses, robinhoodChain, type RobinhoodCoinState, type RobinhoodProbed } from '../src/chains/robinhood/index.js';
import { ponsPoolKey } from '../src/chains/robinhood/trade.js';
import { judge } from '../src/assess.js';
import { transferCoverage } from '../src/coverage.js';
import { historyOf } from '../src/positions.js';
import { coinCard, coinSummary, pairRow, radarRow } from '../src/views.js';
import { Tracker, type CoinState, type RawLog, type Rpc } from '../src/tracker.js';

/**
 * Grading context on Robinhood Chain, from two Pons graduates as the live edge held them on 2026-11-23
 * (fixtures/robinhood/late-graduates.json): EKO started following both long after launch, so it holds only their recent
 * transfers and swaps, while their v4 pools hold what backs the price. Charlie: launched 2026-10-26, about $1.02M on
 * about $39K of pool ETH, a few hundred dollars an hour. NovaAI: launched 2026-08-19, about $405M on about $781K.
 */
const addrs = robinhoodAddresses(loadRegistry());
const ETH_USD = fx.ethUsd;
const offline: Rpc = { request: async () => { throw new Error('no RPC in this test'); } };
type Fx = typeof fx.charlie;
const BLOCK_SEC = 0.102;
const tsOf = (f: Fx) => (l: RawLog) => Math.round(f.headTs - (f.head - Number(BigInt(l.blockNumber))) * BLOCK_SEC);
const MASK160 = (1n << 160n) - 1n, MASK128 = (1n << 128n) - 1n;
const reserveOf = (f: Fx) => ponsPoolReserve(BigInt(f.slot0) & MASK160, BigInt(f.lockedLiquidity) & MASK128);
const LAUNCH_TX = `0x${'1a'.repeat(32)}` as Hex;
const CURVE = '0x00000000000000000000000000000000000c0e7e' as Address;

/** The coin as a restart restored it: launched long ago, its transfers and swaps from the fixture's hour only. */
function late(f: Fx, extraFlows: CoinState['flows'] = []) {
  const token = getAddress(f.token), key = ponsPoolKey(token, addrs.hook);
  const launchBlock = Math.round(f.head - (f.headTs - f.launchTs) / BLOCK_SEC);
  const coin = { launchpad: 'pons', token, creator: getAddress(f.creator), poolId: f.poolId as Hex, key, manager: addrs.poolManager, launcher: addrs.factory,
    quote: zeroAddress, flipped: false, supplyFromMints: false, supply: 10n ** 27n, configId: 0n, firstBuyIn: 0n, firstBuyOut: 0n, feeRecipient: zeroAddress,
    feeLocked: false, block: launchBlock, ts: f.launchTs, tx: LAUNCH_TX, trades: [], netHype: 0, sqrtPriceX96: null, graduated: true, graduatedTs: f.launchTs + 3600,
    name: f.name, symbol: f.symbol, flows: [...extraFlows], firstScanSec: -1,
    curve: { address: CURVE, graduationThreshold: 42n * 10n ** 17n, realQuoteReserve: 0n, realTokenReserve: 0n } } as unknown as CoinState;
  const tracker = new Tracker(offline, robinhoodChain());
  tracker.launch(coin, { address: addrs.factory, topics: [], data: '0x', blockNumber: toHex(launchBlock), transactionHash: LAUNCH_TX, logIndex: '0x0' });
  tracker.applyAll([...f.transfers, ...f.swaps] as RawLog[], tsOf(f));
  return tracker.coin(token)!;
}
/** What the probe read at the fixture's head: the sell check passed, the Pons lock proven, and the pool's state. */
function probed(coin: CoinState, f: Fx): RobinhoodProbed {
  return { block: f.head, at: new Date(f.headTs * 1000).toISOString(), name: f.name, symbol: f.symbol, key: coin.key, config: null, currentBuyFeePips: null,
    probeUsd: 1000, tips: {}, pons: null, lock: { locked: true, tokenId: BigInt(f.tokenId), liquidity: BigInt(f.lockedLiquidity), locker: PONS_LOCK.locker },
    poolReserve: reserveOf(f),
    probe: { method: 'sell-check-1', venue: 'uniswap_v4', routeId: `uniswap_v4:${coin.poolId}`, block: String(f.head), sizeWei: '567000000000000000',
      status: 'sellable', reason: null, spentWei: '567000000000000000', tokens: '1', returnedWei: '555000000000000000', quotedSellWei: null, exitCostPct: 1.97,
      revert: null, requests: 1 } as never };
}
const ctxOf = (f: Fx) => ({ nowSec: f.headTs, head: f.head, hypeUsd: ETH_USD, native: 'ETH' as const });
const grade = (coin: CoinState, f: Fx) => judge(coin, probed(coin, f), { chain: robinhoodChain(), hypeUsd: ETH_USD, nowSec: f.headTs, head: f.head });
/** A real-shaped transfer EKO held from before the fixture's hour (as a restart two days earlier would have kept). */
const older = (f: Fx, ageSec: number, from: string, to: string, value: bigint) =>
  ({ tx: `0x${'0b'.repeat(32)}` as Hex, block: f.head - Math.round(ageSec / BLOCK_SEC), ts: f.headTs - ageSec, from: from.toLowerCase(), to: to.toLowerCase(), value });
const W1 = '0x00000000000000000000000000000000000a11ce', W2 = '0x00000000000000000000000000000000000b0b00';
const TRANSFER_CHECKS = ['holder_concentration', 'bundle_dump', 'launch_snipers', 'dev_dump', 'migration_dump', 'exempt_insiders'];

describe('history coverage (coverage.ts)', () => {
  it('is complete from the mint or the launch transaction, and starts at the first transfer EKO holds otherwise', () => {
    const coin = late(fx.charlie);
    const first = coin.flows[0]!;
    expect(transferCoverage(coin)).toEqual({ complete: false, since: first.ts });
    // positions.ts shares it (its history also needs every trade and unfolded transfer).
    expect(historyOf(coin)).toEqual({ complete: false, since: first.ts });
    const minted = { ...coin, flows: [{ tx: LAUNCH_TX, block: coin.block, ts: coin.ts, from: zeroAddress, to: CURVE.toLowerCase(), value: 10n ** 27n }, ...coin.flows] };
    expect(transferCoverage(minted)).toEqual({ complete: true, since: coin.ts });
    // No transfers held: complete unless EKO first saw it more than an hour after launch.
    expect(transferCoverage({ ...coin, flows: [], firstScanSec: 1 })).toEqual({ complete: true, since: coin.ts });
    expect(transferCoverage({ ...coin, flows: [] }, coin.ts + 99)).toEqual({ complete: false, since: coin.trades[0]!.ts });
  });
});

describe('a coin EKO joined late (Charlie, Pons graduate)', () => {
  it('reads its pool from chain: ETH side and price of the locked full-range position', () => {
    const r = reserveOf(fx.charlie);
    expect(r.native * ETH_USD).toBeGreaterThan(38_000); expect(r.native * ETH_USD).toBeLessThan(41_000);
    expect(r.price * 1e9 * ETH_USD).toBeGreaterThan(950_000); expect(r.price * 1e9 * ETH_USD).toBeLessThan(1_100_000);
    // EKO's own price (the last swap it saw) agrees with the pool's within half a percent.
    const coin = late(fx.charlie);
    expect(coin.trades.at(-1)!.priceHype / r.price).toBeCloseTo(1, 2);
  });

  it('keeps holder and early-buyer checks off its partial history, keeps the level, and says why', () => {
    // A wallet the hour shows receiving 30% of supply from another: on a partial history that is no holding EKO knows.
    const big = older(fx.charlie, 3000, W1, W2, 300_000_000n * 10n ** 18n);
    const coin = late(fx.charlie, [big]);
    const a = grade(coin, fx.charlie);
    expect(a.history).toEqual({ complete: false, since: big.ts });
    expect(a.matches.filter(m => TRANSFER_CHECKS.includes(m.id))).toEqual([]);
    expect(a.verdict.level).toBe('clear');
    expect(a.verdict.historyPartial).toEqual({ since: new Date(big.ts * 1000).toISOString() });
    expect(a.verdict.reasons[0]).toBe('EKO started following this coin 29 days after launch: holders and early buyers are not counted.');
    // The pool holds 3.8% of the market cap: no fake_mcap, and with under a day of trades held no quiet line either.
    expect(a.matches.find(m => m.id === 'fake_mcap')).toBeUndefined();
    expect(a.verdict.reasons).toHaveLength(1);
    expect(a.poolNative).toBeCloseTo(reserveOf(fx.charlie).native, 9);
  });

  it('the same coin followed from launch is graded on its holders as before, with no partial flag', () => {
    const big = older(fx.charlie, 3000, W1, W2, 300_000_000n * 10n ** 18n);
    const mint = { tx: LAUNCH_TX, block: 0, ts: fx.charlie.launchTs, from: zeroAddress, to: W1.toLowerCase(), value: 300_000_000n * 10n ** 18n };
    const coin = late(fx.charlie, [mint, big]);
    const a = grade(coin, fx.charlie);
    expect(a.history).toEqual({ complete: true, since: fx.charlie.launchTs });
    expect(a.verdict.historyPartial).toBeUndefined();
    expect(a.matches.find(m => m.id === 'holder_concentration')?.level).toBe('monitor');
    expect(a.verdict.level).toBe('monitor');
    expect(a.verdict.reasons.some(r => r.startsWith('EKO started following'))).toBe(false);
    const card = coinCard(coin, a, ctxOf(fx.charlie));
    expect(card.supply.top10Pct).toBeCloseTo(30, 0);
    expect(card.meta!.supply).toMatchObject({ confidence: 1, missing: ['freshWalletsPct', 'exemptWalletsHeldPct'], flags: ['bundles_linked_by_transaction'] });
  });

  it('a quiet older coin gets a context line once EKO holds a full day of its trading', () => {
    // Held from two days back (one small transfer then); its trades are the fixture's hour.
    const coin = late(fx.charlie, [older(fx.charlie, 2 * 86_400, W1, W2, 10n ** 18n)]);
    const a = grade(coin, fx.charlie);
    expect(a.verdict.level).toBe('clear');
    expect(a.matches.find(m => m.id === 'fake_mcap')).toBeUndefined();
    expect(a.verdict.reasons[0]).toMatch(/^EKO started following this coin 2\d days after launch/);
    expect(a.verdict.reasons[1]).toMatch(/^Quiet: 4 weeks old · \$\d+ traded in the last hour · \d+ buyers in 24 hours · \$\d+(\.\d)?K in its pool \(3\.\d% of its \$1\.0\dM market cap\)\.$/);
  });

  it('names every holder figure missing on the card and in rows, and shows the pool ETH read on chain as its liquidity', () => {
    const coin = late(fx.charlie), a = grade(coin, fx.charlie), ctx = ctxOf(fx.charlie);
    const card = CoinCardSchema.parse(coinCard(coin, a, ctx));
    expect(card.meta!.supply).toEqual({ confidence: 0, asOfBlock: fx.charlie.head, missing: ['top10Pct', 'devPct', 'bundlesHeldPct', 'freshWalletsPct', 'exemptWalletsHeldPct'], flags: ['history_partial'] });
    expect(card.supply).toMatchObject({ top10Pct: 0, devPct: 0, bundlesHeldPct: 0 });
    expect(card.verdict.historyPartial).toEqual(a.verdict.historyPartial);
    // EKO's running net of the swaps it saw is not what the pool holds; the chain read is.
    const liquidity = reserveOf(fx.charlie).native * ETH_USD;
    expect(card.identity.pools[0]!.liquidityUsd).toBeCloseTo(liquidity, 6);
    expect(Math.abs(coin.netHype * ETH_USD - liquidity)).toBeGreaterThan(30_000);
    const row = RadarRowSchema.parse(radarRow(coin, a, ctx, 1));
    expect(row).toMatchObject({ verdict: 'clear', historyPartial: a.verdict.historyPartial });
    expect(row.liquidityUsd).toBeCloseTo(liquidity, 6);
    const pair = PairRowSchema.parse(pairRow(coin, a, ctx));
    expect(pair.top10Pct).toBeUndefined(); expect(pair.devPct).toBeUndefined(); expect(pair.earlyHeldPct).toBeUndefined();
    expect(pair.unavailable).toContain('buyers');
    expect(coinSummary(coin, a, ctx).historyPartial).toEqual(a.verdict.historyPartial);
  });
});

describe('a market cap that rests on almost nothing (NovaAI, Pons graduate)', () => {
  it('prices it from the pool on chain: the $405M is the pool\'s own price, not a misread', () => {
    const r = reserveOf(fx.novaai), coin = late(fx.novaai);
    expect(r.price * 1e9 * ETH_USD / 1e6).toBeGreaterThan(395); expect(r.price * 1e9 * ETH_USD / 1e6).toBeLessThan(415);
    expect(coin.trades.at(-1)!.priceHype / r.price).toBeCloseTo(1, 2);
    expect(r.native * ETH_USD / 1e3).toBeGreaterThan(760); expect(r.native * ETH_USD / 1e3).toBeLessThan(800);
  });

  it('is Danger once a day of its trading is known, with the numbers in plain words', () => {
    const coin = late(fx.novaai, [older(fx.novaai, 2 * 86_400, W1, W2, 10n ** 18n)]);
    const a = grade(coin, fx.novaai);
    const fake = a.matches.find(m => m.id === 'fake_mcap')!;
    expect(fake.level).toBe('danger');
    expect(a.verdict.level).toBe('danger');
    expect(a.verdict.reasons[0]).toMatch(/^A \$40\dM market cap with \$7\d\dK in its pool \(0\.19%\) and \$[\d,.K]+ traded in the last hour: the price rests on almost nothing\.$/);
    // A Danger level is not "partly checked"; the partial history is still named, after the finding.
    expect(a.verdict.historyPartial).toBeDefined();
    expect(a.verdict.reasons.at(-1)).toMatch(/^EKO started following this coin \d+ days after launch/);
    expect(fake.evidence.find(e => e.label === 'Holders')).toBeUndefined();
    expect(fake.evidence.some(e => e.kind === 'address' && e.ref === coin.poolId && /read on chain/.test(e.label ?? ''))).toBe(true);
  });

  it('is Monitor while the day\'s trading is not known: an unknown is never counted as idle', () => {
    const a = grade(late(fx.novaai), fx.novaai);
    expect(a.matches.find(m => m.id === 'fake_mcap')?.level).toBe('monitor');
  });
});

describe('the probe reads a Pons graduate\'s pool', () => {
  const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])']);
  const managerAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);
  const word = (v: bigint | boolean | string) => encodeAbiParameters([{ type: typeof v === 'string' ? 'address' : typeof v === 'boolean' ? 'bool' : 'uint256' }], [v as never]);
  const code = '0x6080604052' as Hex;
  const sel = (sig: string) => keccak256(new TextEncoder().encode(sig)).slice(0, 10);

  it('takes the ETH side of the locked position at slot0\'s price (Charlie at block 121,579,843)', async () => {
    const f = fx.charlie, coin = late(f);
    const state = BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [f.poolId as Hex, 6n])));
    const answers: Record<string, Hex> = {
      [sel('name()')]: encodeAbiParameters([{ type: 'string' }], ['Charlie']), [sel('symbol()')]: encodeAbiParameters([{ type: 'string' }], ['CHARLIE']),
      [sel('locker()')]: word(PONS_LOCK.locker), [sel('positionManager()')]: word(PONS_LOCK.positionManager), [sel('memeHook()')]: word(addrs.hook),
      [sel('lockedPositions(address)')]: word(BigInt(f.tokenId)), [sel('poolManager()')]: word(addrs.poolManager), [sel('ownerOf(uint256)')]: word(PONS_LOCK.locker),
      [sel('getApproved(uint256)')]: word(zeroAddress), [sel('getPositionLiquidity(uint256)')]: f.lockedLiquidity as Hex,
      [sel('getPoolAndPositionInfo(uint256)')]: encodeAbiParameters([{ type: 'tuple', components: [{ name: 'c0', type: 'address' }, { name: 'c1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'ts', type: 'int24' }, { name: 'hooks', type: 'address' }] }, { type: 'uint256' }],
        [{ c0: coin.key!.currency0, c1: coin.key!.currency1, fee: coin.key!.fee, ts: coin.key!.tickSpacing, hooks: coin.key!.hooks }, 0n]),
    };
    const rpc: Rpc = { request: async ({ method, params }) => {
      if (method === 'eth_getCode') return code;
      const [tx, , overrides] = params as [{ to: Address; data: Hex }, string, Record<string, unknown> | undefined];
      if (overrides) return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'bytes' }],
        [10n ** 24n, 0n, 9n * 10n ** 16n, 10n ** 17n, true, true, '0x']);
      if (method === 'eth_getTransactionReceipt' || method === 'eth_getBlockByNumber') return null;
      const { args: [calls] } = decodeFunctionData({ abi: multicallAbi, data: tx.data });
      return encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: calls.map(c => {
        if (c.callData.startsWith(sel('extsload(bytes32)'))) {
          const slot = BigInt(decodeFunctionData({ abi: managerAbi, data: c.callData }).args[0]);
          return slot === state ? { success: true, returnData: f.slot0 as Hex } : slot === state + 3n ? { success: true, returnData: f.liquidity as Hex } : { success: false, returnData: '0x' as Hex };
        }
        const a = answers[c.callData.slice(0, 10)];
        return { success: a !== undefined, returnData: a ?? '0x' };
      }) });
    } };
    const p = await probeRobinhoodCoin(coin as unknown as RobinhoodCoinState, BigInt(f.head), { rpc, addrs, ethUsd: () => ETH_USD, pins: { locker: keccak256(code), positionManager: keccak256(code) } });
    expect(p.lock).toMatchObject({ locked: true });
    expect(p.poolReserve).toEqual(reserveOf(f));
    // The chain's facts back the price with it (fake_mcap's source), not with EKO's running net.
    const facts = robinhoodChain().facts(coin, p, f.headTs);
    expect(facts.backing).toMatchObject({ source: 'pool', paidIn: reserveOf(f).native });
    expect(facts.backing!.mcap).toBeCloseTo(reserveOf(f).price * 1e9, 6);
  });
});
