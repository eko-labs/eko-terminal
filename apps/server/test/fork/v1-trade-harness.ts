/**
 * Test-only inputs for the v1 trade fork suite. The suite runs the production trade backend
 * (`src/exec/live-trade.ts`, installed by `buildApp` from LIVE_TRADING_ENABLED, the RPC URL and ANVIL_FORK_URL);
 * this file supplies only what a fork cannot provide the production way:
 *
 * - indexer- and engine-shaped rows the production readers use: tokens, the WETH/USDG v3 pools, one ETH-priced swap,
 *   current verdicts (`verdicts`, what Radar shows), scan jobs and stored sell-check readings. No Guard v2 rows: trade
 *   admission runs on the current verdict, as it will at launch;
 * - `anvilNetworkFeeWei`: Anvil has no Arbitrum NodeInterface, so the fee is execution gas at base fee (L2 only);
 * - cache warming, discovery of open native-ETH Pons curves and of a graduated Pons coin, and a loopback relay to the
 *   public RPC that retries its transient refusals (Anvil treats them as final).
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { erc20Abi, keccak256, stringToHex, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { binary, type SqlClient } from '@eko/db';
import { loadRegistry, type V4PoolKey } from '@eko/chain';
import type { Verdict } from '@eko/shared';
import { liveTradeSources } from '../../src/exec/live-trade.js';
import { FACTORY_ABI, POOL_ABI, QUOTER_V2_ABI, type IndexedV3Pool, type V3TradeSources } from '../../src/exec/v3-routes.js';
import { PONS_CURVE_ABI, ponsOpen, readPonsCurve } from '../../src/exec/pons-routes.js';
import { readV4Pool, v4Wired } from '../../src/exec/v4-routes.js';
import { ponsGraduationLock } from '../../src/exec/pons-graduation.js';
import { verdict as legacyVerdict } from '../../../../packages/policy/test/fixtures.js';

/** Optional diagnostics: set FORK_DEBUG_LOG to a file path to record quote outcomes and warm-up attempts. */
export function forkLog(...parts: unknown[]) {
  const file = process.env.FORK_DEBUG_LOG;
  if (file) appendFileSync(file, `${new Date().toISOString()} ${parts.map(p => typeof p === 'string' ? p : JSON.stringify(p, (_k, v) => typeof v === 'bigint' ? v.toString() : v)).join(' ')}\n`);
}

const registry = loadRegistry();
const lower = (a: string) => a.toLowerCase() as Address;
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const WETH = lower(registry.requireAddress('tokens.WETH'));
export const USDG = lower(registry.requireAddress('tokens.USDG'));
export const ROUTER = lower(registry.requireAddress('uniswapV3.swapRouter02'));
const FACTORY = lower(registry.requireAddress('uniswapV3.factory'));
const QUOTER = lower(registry.requireAddress('uniswapV3.quoterV2'));

/**
 * Loopback relay from the trading fork to the public RPC. Behind its load balancer, some public nodes intermittently
 * answer "historical state … is not available" for blocks others serve, and bursts get HTTP 429; Anvil does not retry
 * either. The relay retries those (bounded, with backoff) and forwards everything else unchanged. Public RPC only.
 */
export async function startPublicRpcRelay(port: number, upstream: string) {
  const transient = (status: number, text: string) => status === 429 || /historical state [0-9a-f]+ is not available|Too Many Requests/i.test(text);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let status = 502, text = '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"relay unavailable"}}';
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const response = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
          status = response.status; text = await response.text();
          if (!transient(status, text)) break;
        } catch { /* network error: retry */ }
        await new Promise(resolve => setTimeout(resolve, Math.min(8_000, 500 * 2 ** attempt)));
      }
      res.writeHead(status === 429 ? 503 : status, { 'content-type': 'application/json' }).end(text);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** Indexer-shaped rows: the tokens, v3 pools and one ETH-priced swap that the indexer would have written. */
export async function seedIndexedState(sql: SqlClient, client: PublicClient, block: bigint, extra: { pons?: PonsSeed[] } = {}) {
  const pools: IndexedV3Pool[] = [];
  for (const fee of [100, 500, 3000, 10000]) {
    const pool = await client.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getPool', args: [WETH, USDG, fee], blockNumber: block });
    if (/^0x0{40}$/i.test(pool)) continue;
    const [c0, c1] = WETH < USDG ? [WETH, USDG] : [USDG, WETH];
    pools.push({ address: lower(pool), currency0: c0, currency1: c1, fee });
  }
  if (!pools.length) throw new Error('No WETH/USDG v3 pool at the fork block');
  for (const p of pools) {
    await sql.query(`INSERT INTO pools(id,venue,currency0,currency1,fee,tick_spacing,created_block,block,creation_verified)
      VALUES($1,'uniswap_v3',$2,$3,$4,$5,$6,$6,true) ON CONFLICT(id) DO NOTHING`,
    [binary(p.address), binary(p.currency0), binary(p.currency1), p.fee, ({ 100: 1, 500: 10, 3000: 60, 10000: 200 } as Record<number, number>)[p.fee], block.toString()]);
  }
  const tokens: [Address, string, number, string | null, Address | null, bigint][] = [[WETH, 'WETH', 18, null, null, block], [USDG, 'USDG', 6, null, null, block]];
  for (const [i, p] of (extra.pons ?? []).entries()) tokens.push([p.coin, `PONS-SAMPLE-${i + 1}`, 18, 'pons', p.curve, p.launchBlock]);
  for (const [address, symbol, decimals, launchpad, curve, first] of tokens) {
    await sql.query(`INSERT INTO tokens(address,symbol,name,decimals,launchpad,curve,first_block,block) VALUES($1,$2,$2,$3,$4,$5,$6,$7) ON CONFLICT(address) DO NOTHING`,
      [binary(address), symbol, decimals, launchpad, curve ? binary(curve) : null, first.toString(), block.toString()]);
  }
  // The indexer's graduation record: the coin's Pons-hook v4 pool (its Initialize) and the block it was created in.
  for (const p of extra.pons ?? []) if (p.graduated) {
    const { pool, block: created, key } = p.graduated;
    await sql.query(`INSERT INTO pools(id,venue,currency0,currency1,fee,tick_spacing,hooks,created_block,block,creation_verified)
      VALUES($1,'uniswap_v4',$2,$3,$4,$5,$6,$7,$7,true) ON CONFLICT(id) DO NOTHING`,
    [binary(pool), binary(key.currency0), binary(key.currency1), key.fee, key.tickSpacing, binary(key.hooks), created.toString()]);
    await sql.query('UPDATE tokens SET graduated_pool=$2,graduated_block=$3 WHERE address=$1', [binary(p.coin), binary(pool), created.toString()]);
  }
  // The production price source, read once at the fork block.
  const ethUsd = await liveTradeSources(() => client, () => sql).priceUsd(WETH, block);
  if (!ethUsd) throw new Error('ETH-USD unavailable at the fork block');
  // The sell check prices its probe size with indexedEthUsd: recent ETH-quoted swaps with their USD value.
  await sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,side,amount_coin,amount_quote,price_quote,usd,priced_block)
    VALUES($1,$2,$3,0,'uniswap_v3',$4,$5,$6,1,$7,$8,$9,$10,$2)`,
  [new Date(), block.toString(), binary(keccak256(stringToHex(`eth-usd:${block}`))), binary(pools[0]!.address), binary(USDG), binary(WETH),
    BigInt(Math.round(ethUsd * 1e6)).toString(), (10n ** 18n).toString(), ethUsd, ethUsd]);
  return { pools, ethUsd };
}

/** Anvil has no Arbitrum NodeInterface (0xc8): execution gas at the block's base fee, L2 only (BACKEND §14 fork note). */
export function anvilNetworkFeeWei(chain: () => PublicClient): V3TradeSources['networkFeeWei'] {
  return async (_tx, gas, block) => {
    const b = await chain().getBlock({ blockNumber: block });
    return b.baseFeePerGas == null ? null : gas * b.baseFeePerGas;
  };
}

let verdictSequence = 0;
/**
 * Publish the coin's current verdict the way the engines do: verdict rows are append-only, so earlier rows are marked
 * orphaned (`verdict_events`) and a new row is appended. `null` leaves the coin with no verdict (never scanned).
 */
export async function setVerdict(sql: SqlClient, coin: Address, level: Verdict['level'] | null, block: bigint, playbooks: Verdict['playbooks'] = []) {
  const n = ++verdictSequence;
  const current = (await sql.query<{ id: string }>(`SELECT id FROM verdicts v WHERE coin=$1 AND NOT EXISTS
    (SELECT 1 FROM verdict_events e WHERE e.verdict_id=v.id AND e.kind='orphaned')`, [binary(coin)])).rows;
  for (const row of current) await sql.query("INSERT INTO verdict_events(id,verdict_id,kind,block,data) VALUES($1,$2,'orphaned',$3,'{}')",
    [`${row.id}-orphaned-${n}`, row.id, block.toString()]);
  if (!level) return;
  const id = `fork-${coin}-${n}`;
  const data: Verdict = { ...legacyVerdict, coin, level, playbooks, reasons: [`fork fixture: ${level}`], asOfBlock: Number(block),
    receipt: { ...legacyVerdict.receipt, id } };
  await sql.query('INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES($1,$2,$3,$4,$5,$6)',
    [id, binary(coin), (block + BigInt(n)).toString(), 'fork-rules', 'fork-signature', JSON.stringify(data)]);
}
/** A requested scan of the coin that is queued (a rescan pending), or finished. */
export async function setScanPending(sql: SqlClient, coin: Address, pending: boolean) {
  await sql.query(`INSERT INTO scan_jobs(id,query,coin,phase,status) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,status=excluded.status`, [`fork-scan-${coin}`, coin, binary(coin), pending ? 'queued' : 'done', pending ? 'pending' : 'ready']);
}
/** The engines' stored sell-check reading for a coin, checked now (`null`: no usable reading). */
export async function setStoredSellCheck(sql: SqlClient, coin: Address, status: 'sellable' | 'refused' | null, block: bigint) {
  const stored = status ?? 'unavailable';
  await sql.query(`INSERT INTO sell_check_latest(coin,block,checked_at,venue,route_id,status,exit_cost_100_pct,exit_cost_1k_pct,method_version,data,attempted_at,attempt_status)
    VALUES($1,$2,$3,'uniswap_v3',NULL,$4,1,1,'sell-check-1','{}',$3,$4) ON CONFLICT(coin) DO UPDATE SET block=excluded.block,checked_at=excluded.checked_at,
    status=excluded.status,attempted_at=excluded.attempted_at,attempt_status=excluded.attempt_status`, [binary(coin), block.toString(), new Date(), stored]);
}

/**
 * Load the route and sell-check state into the trading fork through a patient client. A cold slot is a rate-limited
 * public RPC read, and the API's metered client gives up after 10 seconds; once loaded, the fork answers locally.
 */
export async function warmForkState(client: PublicClient, pools: IndexedV3Pool[], ethUsd: number, sellCheck: (coin: Address, usd: number) => Promise<unknown>) {
  const block = await client.getBlockNumber();
  for (const p of pools) {
    await client.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getPool', args: [WETH, USDG, p.fee], blockNumber: block });
    await client.readContract({ address: p.address, abi: POOL_ABI, functionName: 'slot0', blockNumber: block });
    for (const usd of [3, 5, 20, 2_000, 10_000, 50_000]) for (const [tokenIn, tokenOut, units] of [[WETH, USDG, usd / ethUsd * 1e18], [USDG, WETH, usd * 1e6]] as const) {
      await client.simulateContract({ address: QUOTER, abi: QUOTER_V2_ABI, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, amountIn: BigInt(Math.floor(units)), fee: p.fee, sqrtPriceLimitX96: 0n }], blockNumber: block }).catch(() => undefined);
    }
  }
  for (const usd of [5, 10, 20, 300]) await sellCheck(USDG, usd);
}

/** An indexed Pons coin: its curve and launch block, and, once graduated, the indexer's graduation record. */
export interface PonsSeed { coin: Address; curve: Address; launchBlock: bigint; graduated?: { pool: Hex; block: bigint; key: V4PoolKey } }
const launchedEvent = { type: 'event', name: 'TokenLaunched', inputs: [{ type: 'address', name: 'token', indexed: true }, { type: 'address', name: 'curve', indexed: true },
  { type: 'address', name: 'deployer', indexed: true }, { type: 'address', name: 'pairToken' }, { type: 'uint256', name: 'launchConfigId' }, { type: 'uint256', name: 'graduationThreshold' }] } as const;
const initializeEvent = { type: 'event', name: 'Initialize', inputs: [{ type: 'bytes32', name: 'id', indexed: true }, { type: 'address', name: 'currency0', indexed: true },
  { type: 'address', name: 'currency1', indexed: true }, { type: 'uint24', name: 'fee' }, { type: 'int24', name: 'tickSpacing' }, { type: 'address', name: 'hooks' },
  { type: 'uint160', name: 'sqrtPriceX96' }, { type: 'int24', name: 'tick' }] } as const;

/**
 * Native-ETH Pons launches at least `minAgeBlocks` old at `block` (TokenLaunched on the Pons factory) whose curves still
 * trade there: not graduated or graduating, anti-snipe window over, at least half the tokens left to buy, and fee plus
 * creator tax of 3–4% a leg (the typical launch: a 6–8% round trip at small sizes). Newest first.
 */
export async function findOpenPonsLaunches(client: PublicClient, block: bigint, count: number, minAgeBlocks = 30_000n, span = 40_000n): Promise<PonsSeed[]> {
  const logs = await client.getLogs({ address: registry.requireAddress('pons.factory'), fromBlock: block - minAgeBlocks - span, toBlock: block - minAgeBlocks, event: launchedEvent });
  const found: PonsSeed[] = [];
  for (const launch of logs.reverse()) {
    if (found.length >= count) break;
    if (!/^0x0{40}$/i.test(launch.args.pairToken ?? '')) continue;
    const coin = lower(launch.args.token!), curve = lower(launch.args.curve!);
    const s = await readPonsCurve(client, coin, curve, block).catch(() => null);
    if (s && ponsOpen(s) && s.snipeTaxBps === 0n && s.feeBps + s.creatorTaxBps >= 300n && s.feeBps + s.creatorTaxBps <= 400n && s.sellable * 2n > s.tokenReserve)
      found.push({ coin, curve, launchBlock: launch.blockNumber! });
  }
  return found;
}

/**
 * The newest native Pons coin that graduated within `span` blocks before `block`: its Pons-hook pool's Initialize on the
 * v4 PoolManager (how the indexer records a graduation) and its curve from the factory's TokenLaunched log.
 */
export async function findGraduatedPons(client: PublicClient, block: bigint, span = 250_000n): Promise<PonsSeed | null> {
  const hook = registry.requireAddress('pons.v4Hook');
  const inits = await client.getLogs({ address: registry.requireAddress('uniswapV4.poolManager'), fromBlock: block - span, toBlock: block, event: initializeEvent });
  for (const init of inits.reverse().filter(l => same(l.args.hooks, hook) && /^0x0{40}$/i.test(l.args.currency0 ?? ''))) {
    const coin = lower(init.args.currency1!);
    const [launch] = await client.getLogs({ address: registry.requireAddress('pons.factory'), fromBlock: init.blockNumber! - 200_000n, toBlock: init.blockNumber!,
      event: launchedEvent, args: { token: coin } });
    if (!launch || !/^0x0{40}$/i.test(launch.args.pairToken ?? '')) continue;
    const curve = lower(launch.args.curve!);
    if (await client.readContract({ address: curve, abi: PONS_CURVE_ABI, functionName: 'graduated', blockNumber: block }))
      return { coin, curve, launchBlock: launch.blockNumber!, graduated: { pool: init.args.id!, block: init.blockNumber!,
        key: { currency0: zeroAddress, currency1: coin, fee: init.args.fee!, tickSpacing: init.args.tickSpacing!, hooks: lower(init.args.hooks!) } } };
  }
  return null;
}

/** Load each open curve's quote, fingerprint and sell-check state into the trading fork through a patient client (see warmForkState). */
export async function warmPons(client: PublicClient, coins: PonsSeed[], account: Address, sellCheck: (coin: Address, usd: number) => Promise<unknown>) {
  const block = await client.getBlockNumber();
  for (const p of coins) {
    await readPonsCurve(client, p.coin, p.curve, block);
    await Promise.all([client.getCode({ address: p.coin, blockNumber: block }), client.getCode({ address: p.curve, blockNumber: block }),
      client.readContract({ address: p.coin, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber: block }),
      client.readContract({ address: p.coin, abi: erc20Abi, functionName: 'allowance', args: [account, p.curve], blockNumber: block })]);
    // A graduated coin's pool and the v4 router wiring (its route since graduation).
    if (p.graduated) await Promise.all([readV4Pool(client, p.graduated.pool, block), v4Wired(client, block),
      ponsGraduationLock(client, p.coin, { id: p.graduated.pool, key: p.graduated.key }, p.graduated.pool, block)]);
    await sellCheck(p.coin, 5);
  }
}
