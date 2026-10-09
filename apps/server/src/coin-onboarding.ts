import { withRpcOrigin, rpcPauseRetryAt } from '@eko/chain';
import { LoopHeartbeat } from './loop-health.js';
import { decodeAbiParameters, hexToString, parseAbi, type Hex, type PublicClient } from 'viem';
import { binary, hex, type ChainDb } from '@eko/db';
import { isTransientRpcUnavailable, loadRegistry, rpcStopReason } from '@eko/chain';
import { rebuildCandles, repricePonsSwaps, pricingAssets, rawMutationBounds, liveRawRows, sealedRawMutation, type RawMutationBounds, type PricingAssets } from './pricing-repair.js';

const ZERO = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dead';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', ZERO_TOPIC = `0x${'0'.repeat(64)}`;
/**
 * Swaps or liquidity events settled per statement, and swaps priced per statement while a coin is onboarded. A pass
 * checks its time between statements, so a statement is kept short: 5,000 swaps priced in one took over twenty
 * seconds on the loaded box (2026-10-13), three times the pass's whole allowance.
 */
export const ATTRIBUTE_BATCH = 1000, ONBOARD_PRICE_BATCH = 1000;
/**
 * Minutes of candles rebuilt per transaction once a coin's swaps are priced. Rebuilding candles takes the candle
 * table's exclusive lock, which the indexer needs to write every block: a thousand minutes in the pricing transaction
 * held it for ten seconds at a time (2026-10-13). The candles of the last two days are rebuilt after pricing instead,
 * four hours of them at a time. That was thirty minutes while a candle's delete read the coin's whole history; since
 * that was fixed a rebuild of 240 minutes holds the lock about as long as one of 30 did (93 ms against 70 ms on a copy
 * of 2026-10-13), and a coin's two days take 12 turns at the lock instead of 96.
 */
export const CANDLE_MINUTES = 240;
const NO_CANDLES = new Date(8.64e15);
/**
 * Blocks per mint search request (the paid endpoint refuses a log range over 100,000 blocks, about three hours), and
 * the windows searched back from a coin's first pool: a launch mints in the transaction that opens its pool or shortly
 * before it. A coin minted more than about eight hours before its first pool has no launch wallet identified.
 */
const MINT_SPAN = 100_000n, MINT_WINDOWS = 3;

/**
 * Addresses that are never a coin's buyer or seller (the mint and burn addresses and the v4 pool manager), the
 * reference assets that are never onboarded as coins, and the ERC-4337 entry points (a launch sent through one was
 * sent by a bundler, not by the coin's creator).
 */
export interface AttributionAddresses { poolManager: string; weth: string; usdg: string; reference: string[]; entryPoints?: string[] }
export const attributionAddresses = (registry = loadRegistry()): AttributionAddresses => {
  const weth = registry.requireAddress('tokens.WETH'), usdg = registry.requireAddress('tokens.USDG');
  return { poolManager: registry.requireAddress('uniswapV4.poolManager'), weth, usdg,
    reference: [weth, usdg, registry.addressOf('tokens.USDC_bridged')].filter((a): a is `0x${string}` => !!a),
    entryPoints: (['entryPoints.v06', 'entryPoints.v07', 'entryPoints.v08'] as const).map(key => registry.addressOf(key)).filter((a): a is `0x${string}` => !!a).map(a => a.toLowerCase()) };
};
/**
 * A launch's sender with this many transactions is a relayer or a bot, not one person launching a coin (2026-10-13, 37
 * recent Uniswap launches: senders of 153,190, 140,006, 2,881 and 2,411 transactions sent 12 of them; the other 24
 * senders had 4 to 292). So is a sender this worker has already seen launch SHARED_LAUNCHES coins in a week.
 */
export const AUTOMATED_SENDER_TXS = 1000, SHARED_LAUNCHES = 20;

/**
 * Name the wallet behind Uniswap swaps the indexer stored without one, from the coin's own transfers in the same
 * transaction (which it already stores): no chain read. The indexer resolves the sender only for Pons coins (it reads
 * a block's receipts for that); every other pool's swaps stayed without a trader, so those coins had no buyers, no
 * holder checks and no sell check (2026-10-13: 38,600 swaps an hour). The buyer is the wallet whose balance of the
 * coin rose most in the transaction, the seller the one whose balance fell most; pools, the pool manager and the mint
 * and burn addresses never count, and a router that only passes coins on nets to zero. When no balance moved that way
 * (a wallet that bought and sold in one transaction), it is the wallet that took the coins from the pool, or sent them
 * to it. A v4 swap that moved no coins at all (the coin was one hop of a route inside the pool manager) has no wallet:
 * a buy is marked as delivered to the pool manager, so it is not mistaken for an unknown buyer. A swap whose
 * transaction has no stored transfers from before transfers were recorded stays unnamed. Checked against 10,629 swaps
 * on 2026-10-13: 92% named by balance change (99% on v3), 2% moved no coins.
 * `coins` limits it to those coins; otherwise every coin with a launch wallet that is not a Pons launch. Returns the
 * swaps settled.
 */
export async function attributeSwaps(db: ChainDb, a: AttributionAddresses, from: Date, to: Date, limit = ATTRIBUTE_BATCH, coins?: Uint8Array[], bounds?:RawMutationBounds): Promise<number> {
  bounds ??= await rawMutationBounds(db);
  const params:unknown[]=[from, to, limit, binary(a.poolManager), [ZERO, DEAD, a.poolManager].map(binary), ...(coins ? [coins.length === 1 ? coins[0] : coins] : [])];
  const live=liveRawRows('s',bounds.swaps,params);
  // One coin is matched by equality, so its swaps are read newest first through swaps(coin,block). As coin=ANY(...) the
  // planner walked every coin's swaps backward to find them: 3.3 million rows for a batch 50,000 swaps into one coin's
  // history on a copy of 2026-10-13 (3.2 s, against 78 ms).
  const scope = !coins ? 'EXISTS(SELECT 1 FROM tokens k WHERE k.address=s.coin AND k.deployer IS NOT NULL AND k.launchpad IS NULL)'
    : coins.length === 1 ? 's.coin=$6::bytea' : 's.coin=ANY($6::bytea[])';
  // The wallet is picked per swap inside the lateral: joined back as a separate ranked set, the planner re-read that set
  // once per swap (a 1,000-swap batch took 2.6 s on the same copy, 0.23 s this way).
  return (await db.sql.query(`WITH c AS MATERIALIZED (
      SELECT s.ts,s.tx_hash,s.log_index,s.block,s.coin,s.pool_id,s.side,s.venue,s.recipient FROM swaps s
      WHERE ${live} AND s.senders_pending AND s.venue<>'pons_curve' AND s.ts>=$1 AND s.ts<$2 AND ${scope} ORDER BY s.block DESC,s.log_index DESC LIMIT $3),
    -- No coins moved: nobody took delivery, when the coin's transfers were being stored by then.
    r AS (SELECT c.*,p.addr,p.addr IS NULL AND c.venue='uniswap_v4' AND c.side=1
        AND NOT EXISTS(SELECT 1 FROM token_transfers t WHERE t.token=c.coin AND t.block=c.block AND t.tx_hash=c.tx_hash)
        AND EXISTS(SELECT 1 FROM token_transfers t WHERE t.token=c.coin AND t.block<c.block) AS undelivered
      FROM c LEFT JOIN LATERAL (SELECT x.addr FROM (
          SELECT d.addr,sum(d.delta) AS net,coalesce(sum(d.delta) FILTER (WHERE d.delta>0),0) AS gin,coalesce(-sum(d.delta) FILTER (WHERE d.delta<0),0) AS gout,
            bool_or(d.delta>0 AND (d.other=c.pool_id OR d.other=$4)) AS from_pool,bool_or(d.delta<0 AND (d.other=c.pool_id OR d.other=$4)) AS to_pool
          FROM (SELECT t.to_address AS addr,t.amount AS delta,t.from_address AS other FROM token_transfers t WHERE t.token=c.coin AND t.block=c.block AND t.tx_hash=c.tx_hash AND t.kind='Transfer'
            UNION ALL SELECT t.from_address,-t.amount,t.to_address FROM token_transfers t WHERE t.token=c.coin AND t.block=c.block AND t.tx_hash=c.tx_hash AND t.kind='Transfer') d
          WHERE NOT d.addr=ANY($5::bytea[]) AND d.addr<>c.pool_id AND NOT EXISTS(SELECT 1 FROM pools p WHERE p.id=d.addr)
          GROUP BY d.addr) x
        CROSS JOIN LATERAL (SELECT CASE WHEN (c.side=1 AND x.net>0) OR (c.side=-1 AND x.net<0) THEN 0 WHEN (c.side=1 AND x.from_pool) OR (c.side=-1 AND x.to_pool) THEN 1
          WHEN (c.side=1 AND x.gin>0) OR (c.side=-1 AND x.gout>0) THEN 2 END AS tier) k
        WHERE k.tier IS NOT NULL
        ORDER BY k.tier,CASE WHEN k.tier=0 THEN abs(x.net) WHEN c.side=1 THEN x.gin ELSE x.gout END DESC,x.addr LIMIT 1) p ON true)
    UPDATE swaps s SET trader=r.addr,senders_pending=false,
      recipient=CASE WHEN r.side<>1 THEN s.recipient WHEN r.addr IS NOT NULL THEN r.addr WHEN r.undelivered THEN $4 ELSE s.recipient END
    FROM r WHERE ${live} AND s.ts=r.ts AND s.tx_hash=r.tx_hash AND s.log_index=r.log_index RETURNING 1`,
    params)).rows.length;
}

/**
 * Name the wallet behind liquidity events stored without one, the same way: whoever's balance of the pool's coin (its
 * token other than WETH and USDG) fell most in the transaction added the liquidity, whoever's rose most took it out. Most positions are held
 * through a position manager contract, so the event's own owner says nothing about who controls them; an event with
 * no such wallet keeps the owner or sender it names, or the pool manager or pool. Events of the pools of `coins`.
 */
export async function attributeLiquidity(db: ChainDb, a: AttributionAddresses, limit: number, coins: Uint8Array[], bounds?:RawMutationBounds): Promise<number> {
  bounds ??= await rawMutationBounds(db);
  const params:unknown[]=[limit, binary(a.poolManager), [ZERO, DEAD, a.poolManager].map(binary), coins, a.reference.map(binary)];
  const live=liveRawRows('e',bounds.liquidity_events,params);
  const where = '(p.currency0=ANY($4::bytea[]) OR p.currency1=ANY($4::bytea[]))';
  const word = (field: string) => `CASE WHEN lower(e.data->>'${field}') ~ '^0x[0-9a-f]{40}$' THEN decode(substr(lower(e.data->>'${field}'),3),'hex') END`;
  return (await db.sql.query(`WITH c AS MATERIALIZED (
      SELECT e.tx_hash,e.log_index,e.block,e.pool_id,p.currency0,p.currency1,
        CASE WHEN e.kind='Mint' OR (e.kind='ModifyLiquidity' AND (e.data->>'liquidityDelta') ~ '^[0-9]+$' AND (e.data->>'liquidityDelta')<>'0') THEN -1
          WHEN e.kind IN ('Burn','Collect') OR (e.kind='ModifyLiquidity' AND (e.data->>'liquidityDelta') ~ '^-[0-9]+$') THEN 1 ELSE 0 END AS way,
        coalesce(${word('owner')},${word('sender')},${word('recipient')},CASE WHEN length(e.pool_id)=20 THEN e.pool_id ELSE $2 END) AS named
      FROM liquidity_events e JOIN pools p ON p.id=e.pool_id WHERE ${live} AND e.senders_pending AND ${where} ORDER BY e.block DESC LIMIT $1),
    pick AS (SELECT c.tx_hash,c.log_index,(SELECT d.addr FROM (
        SELECT x.addr,sum(x.delta) AS net FROM (
          SELECT t.to_address AS addr,t.amount AS delta FROM token_transfers t WHERE t.token IN (c.currency0,c.currency1) AND NOT t.token=ANY($5::bytea[]) AND t.block=c.block AND t.tx_hash=c.tx_hash AND t.kind='Transfer'
          UNION ALL SELECT t.from_address,-t.amount FROM token_transfers t WHERE t.token IN (c.currency0,c.currency1) AND NOT t.token=ANY($5::bytea[]) AND t.block=c.block AND t.tx_hash=c.tx_hash AND t.kind='Transfer') x
        WHERE NOT x.addr=ANY($3::bytea[]) AND x.addr<>c.pool_id AND NOT EXISTS(SELECT 1 FROM pools q WHERE q.id=x.addr) GROUP BY x.addr) d
        WHERE c.way<>0 AND d.net*c.way>0 ORDER BY abs(d.net) DESC,d.addr LIMIT 1) AS addr FROM c)
    UPDATE liquidity_events e SET actor=coalesce(pick.addr,c.named),senders_pending=false FROM c JOIN pick USING (tx_hash,log_index)
    WHERE ${live} AND e.tx_hash=c.tx_hash AND e.log_index=c.log_index RETURNING 1`,
    params)).rows.length;
}

export interface TokenFacts { decimals: number | null; symbol: string | null; name: string | null; totalSupply: bigint | null }
export interface LaunchWallet { wallet: string; to: string | null; block: bigint; tx: string; mintTo: string | null }
/** The chain reads onboarding needs (the worker's metered client; tests supply fixtures). */
export interface OnboardingChain {
  facts(token: string): Promise<TokenFacts>;
  /**
   * The sender (and target) of the transaction that first minted the token, searched back from `upTo`; null when no
   * mint is found there or the first one cannot be told from later ones (a token that mints all the time).
   */
  firstMint(token: string, upTo: bigint): Promise<LaunchWallet | null>;
  /** Transactions the wallet has sent (its nonce), or null when unreadable. */
  sent(wallet: string): Promise<number | null>;
}

const erc20 = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)', 'function totalSupply() view returns (uint256)']);
const multicall3 = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) view returns (Result[] returnData)']);
const SELECTORS = { decimals: '0x313ce567', symbol: '0x95d89b41', name: '0x06fdde03', totalSupply: '0x18160ddd' } as const;
/** A string return, or the bytes32 some older tokens return for name and symbol; null when neither decodes to text. */
export function decodeText(data: Hex): string | null {
  let text: string | null = null;
  try { text = decodeAbiParameters([{ type: 'string' }], data)[0]; }
  catch { if (data.length === 66) try { text = hexToString(data, { size: 32 }); } catch { /* not text */ } }
  // Postgres text cannot hold a NUL byte.
  text = text?.replaceAll('\u0000', '').trim() ?? null;
  return text ? text.slice(0, 256) : null;
}
/** A provider refusing a log query for the size of its answer (never a rate limit, which is retried by the meter). */
const sizeLimited = (error: unknown) => { const e = error as { details?: string; shortMessage?: string; message?: string };
  return /more than \d+ results|too many results|query returned more|response size|result set too large|exceeds? (the )?max/i.test(`${e?.details ?? ''} ${e?.shortMessage ?? ''} ${e?.message ?? ''}`); };
/** Log requests one token's mint search may make. */
const MINT_REQUESTS = 24;
/** Chain reads onboarding may make in a UTC day: about four per coin, so some 7,000 coins. */
export const ONBOARDING_DAILY_READS = 30_000;
/** Thrown when the day's onboarding reads are spent; the pass stops and the next day's first pass resumes. */
export class OnboardingReadsSpent extends Error { constructor() { super('Onboarding chain reads are spent for today'); } }
/**
 * Onboarding reads through the worker's metered client, which bills them to the paid endpoint under the process's
 * daily budget. They also have their own ceiling per UTC day (`dailyReads`), so onboarding can never be what spends
 * that budget: the indexer and the rating engine read from the same one.
 */
export function chainOnboarding(metered: () => PublicClient, registry = loadRegistry(), dailyReads = ONBOARDING_DAILY_READS, now: () => number = () => Date.now()): OnboardingChain {
  const multicall = registry.requireAddress('multicall3');
  let day = '', reads = 0;
  const client = () => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) { day = today; reads = 0; }
    if (reads >= dailyReads) throw new OnboardingReadsSpent();
    reads++;
    return metered();
  };
  const stop = (error: unknown) => { if (error instanceof OnboardingReadsSpent || rpcStopReason(error) || isTransientRpcUnavailable(error)) throw error; };
  const mints = (token: string, from: bigint, to: bigint) => client().request({ method: 'eth_getLogs',
    params: [{ address: token as Hex, topics: [TRANSFER, ZERO_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] } as never) as Promise<{ blockNumber: Hex; logIndex: Hex; transactionHash: Hex; topics: Hex[] }[]>;
  const earliest = async (token: string, from: bigint, to: bigint, budget: { left: number }): Promise<{ blockNumber: Hex; logIndex: Hex; transactionHash: Hex; topics: Hex[] } | null> => {
    let logs;
    if (budget.left-- <= 0) throw new Error('Mint search exceeded its request budget');
    try { logs = await mints(token, from, to); }
    catch (error) {
      stop(error);
      // A token that mints constantly returns more logs than one reply holds: its first mint is in the lower half.
      if (!sizeLimited(error) || from >= to) throw error;
      const mid = from + (to - from) / 2n;
      return await earliest(token, from, mid, budget) ?? await earliest(token, mid + 1n, to, budget);
    }
    return logs.reduce<typeof logs[number] | null>((first, log) => !first || BigInt(log.blockNumber) < BigInt(first.blockNumber)
      || (BigInt(log.blockNumber) === BigInt(first.blockNumber) && BigInt(log.logIndex) < BigInt(first.logIndex)) ? log : first, null);
  };
  const transaction = async (tx: string) => {
    try {
      const found = (await client().request({ method: 'eth_getTransactionByHash', params: [tx as Hex] } as never)) as { from?: string; to?: string | null } | null;
      return found?.from ? { from: found.from.toLowerCase(), to: found.to?.toLowerCase() ?? null } : null;
    } catch (error) { stop(error); return null; }
  };
  return {
    async sent(wallet) {
      try { return Number(BigInt((await client().request({ method: 'eth_getTransactionCount', params: [wallet as Hex, 'latest'] } as never)) as Hex)); }
      catch (error) { stop(error); return null; }
    },
    async facts(token) {
      const calls = Object.values(SELECTORS).map(callData => ({ target: token as Hex, allowFailure: true, callData: callData as Hex }));
      let results: readonly { success: boolean; returnData: Hex }[];
      try { results = await withRpcOrigin('server.coin_onboarding.L212',()=>client().readContract({ address: multicall, abi: multicall3, functionName: 'aggregate3', args: [calls] })); }
      catch (error) { stop(error); return { decimals: null, symbol: null, name: null, totalSupply: null }; }
      const [decimals, symbol, name, supply] = results;
      const number = (r: { success: boolean; returnData: Hex }) => { try { return r.success && r.returnData.length === 66 ? BigInt(r.returnData) : null; } catch { return null; } };
      const d = number(decimals), total = number(supply);
      return { decimals: d != null && d <= 36n ? Number(d) : null, symbol: symbol.success ? decodeText(symbol.returnData) : null, name: name.success ? decodeText(name.returnData) : null, totalSupply: total };
    },
    async firstMint(token, upTo) {
      let found: Awaited<ReturnType<typeof earliest>> = null, first = false;
      const budget = { left: MINT_REQUESTS };
      // Newest window first. The mint found is the first one only when the window below it has none (or the chain
      // starts there): running out of windows while every one still holds mints establishes nothing.
      for (let hi = upTo, windows = 0; hi >= 0n && windows < MINT_WINDOWS; windows++) {
        let log: Awaited<ReturnType<typeof earliest>>;
        const lo = hi > MINT_SPAN ? hi - MINT_SPAN : 0n;
        try { log = await earliest(token, lo, hi, budget); }
        catch (error) { stop(error); return null; }
        if (log) found = log; else if (found) { first = true; break; }
        if (lo === 0n) { first = found != null; break; }
        hi = lo - 1n;
      }
      if (!found || !first) return null;
      const sent = await transaction(found.transactionHash);
      return sent ? { wallet: sent.from, to: sent.to, block: BigInt(found.blockNumber), tx: found.transactionHash, mintTo: found.topics[2] ? `0x${found.topics[2].slice(-40)}`.toLowerCase() : null } : null;
    },
  };
}

interface Candidate { coin: Uint8Array; first_block: string }
/** Swaps in the last hour from which a coin not yet onboarded goes ahead of the hour's launches. */
export const BUSY_SWAPS = 50;
/** How long a coin's chain reads are kept: a coin read ahead of its turn is not read again when its turn comes. */
const READS_KEPT_MS = 3_600_000;
export interface OnboardingOptions { now?: () => number; intervalMs?: number; budgetMs?: number; perTick?: number; batch?: number; assets?: PricingAssets; addresses?: AttributionAddresses;
  /** Seconds the newest indexed block may be behind the clock before a pass does nothing (default 45). */
  maxLagSec?: number }
const HOUR = 3_600_000;
/**
 * Worker role. Every 30 s: price and name whatever swaps of already onboarded coins were stored without a wallet,
 * then onboard a few more coins: those with BUSY_SWAPS swaps in the last hour first (busiest first), then the hour's
 * launches (newest first), then the most traded in the last day. Onboarding a coin reads
 * its name, symbol, decimals and supply (one call) and the wallet that sent its first mint (its launch wallet, the
 * `deployer` every rating check is written against), prices its stored swaps and names their traders, and only then
 * records the launch wallet: that makes the coin visible to the rating engine and the Radar with its history complete.
 * A launch sent by a relayer, a bundler or a bot, or whose first mint is not found near its first pool, has no wallet
 * that is its creator's: the coin's own address is recorded instead, which every check reads as "no deployer wallet" (it never trades, holds only what
 * the contract holds, and has no other launches), so hundreds of unrelated coins are not tied to one sender.
 * A coin whose history does not fit a pass is resumed on the next. A token without readable decimals, or without a
 * name and symbol, is retried after a growing wait (six hours to two days).
 * Rewriting a coin's stored swaps competes with the indexer and the rating engine for the same database (the box ran
 * at a load of 5.7 on four cores on 2026-10-13): a pass works for ten of every thirty seconds, and does nothing while
 * the newest indexed block is more than `maxLagSec` behind the clock.
 * Within a pass the already onboarded coins get a third of the time, the busy coins a third and the launches what is
 * left, and time one group does not use goes to the next, so none holds up the others (on 2026-10-13 four listed coins
 * with swaps that cannot be priced took every pass, and the hour's launches kept the busiest coins from ever being
 * reached: 30 coins had 90% of the unlisted swaps).
 */
export class CoinOnboardingWorker {
  readonly heartbeat: LoopHeartbeat;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private rpcRetryAt = 0;
  private queue: Candidate[] = [];
  private busy: Candidate[] = [];
  private busiest: Candidate[] = [];
  private busiestAt = -Infinity;
  /** Coins whose onboarding threw, and when: left alone for five minutes so one coin's failing read does not end every pass. */
  private failed = new Map<string, number>();
  private traded: Candidate[] = [];
  private tradedAt = -Infinity;
  /**
   * Per coin being settled: the hours still to price and the minutes whose candles are still to rebuild, read once and
   * worked down across passes. Read again on every pass, the two lists were a scan of the coin's whole history each
   * (0.5 s each for a 71,000-swap coin on a copy of 2026-10-13, most of a busy coin's share of a pass in production).
   */
  private hours = new Map<string, Date[]>();
  private minutes = new Map<string, Date[]>();
  /** Listed coins with swaps or liquidity events still to name, read every two minutes. */
  private behind: Uint8Array[] = [];
  private behindAt = -Infinity;
  private pausedAt = -Infinity;
  private readonly now: () => number;
  private readonly addresses: AttributionAddresses;
  private assets?: PricingAssets;
  /**
   * Chain reads in flight or answered (a coin's facts and first mint, a wallet's transaction count). A failed read is
   * kept until the coin it was for has had its turn and been set to rest, so a read-ahead that failed is not sent twice.
   */
  private reads = new Map<string, { at: number; value: Promise<unknown> }>();
  private rejected = new Set<string>();
  private readonly chain: OnboardingChain;
  constructor(private readonly db: ChainDb, chain: OnboardingChain, private readonly log: (event: string, fields: Record<string, unknown>) => void,
    private readonly options: OnboardingOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.heartbeat = new LoopHeartbeat(options.intervalMs ?? 30_000, this.now);
    this.addresses = options.addresses ?? attributionAddresses();
    this.assets = options.assets;
    this.chain = {
      facts: token => this.read(`facts:${token}`, () => chain.facts(token)),
      firstMint: (token, upTo) => this.read(`mint:${token}:${upTo}`, () => chain.firstMint(token, upTo)),
      sent: wallet => this.read(`sent:${wallet}`, () => chain.sent(wallet)),
    };
  }
  private read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const held = this.reads.get(key);
    if (held && this.now() - held.at < READS_KEPT_MS) return held.value as Promise<T>;
    const value = load();
    this.reads.set(key, { at: this.now(), value });
    // Spent reads are refused before anything is sent: every pass asks again.
    value.catch(error => { if (this.reads.get(key)?.value !== value) return; if (error instanceof OnboardingReadsSpent) this.reads.delete(key); else this.rejected.add(key); });
    return value;
  }
  /**
   * Start the chain reads of the coins a pass is about to reach, all at once: read one coin at a time they took most
   * of a pass (about 180 coins an hour on 2026-10-13, against 335 launches an hour). `onboard` then finds them answered.
   */
  private async readAhead(candidates: Candidate[]) {
    if (!candidates.length) return;
    const rows = (await this.db.sql.query<{ coin: Uint8Array; facts: boolean; mint: boolean }>(`SELECT t.address AS coin,
        (t.decimals IS NULL OR t.name IS NULL OR t.symbol IS NULL OR t.total_supply IS NULL) AS facts,(o.data->>'launchWallet') IS NULL AS mint
      FROM tokens t LEFT JOIN coin_onboarding o ON o.coin=t.address WHERE t.address=ANY($1::bytea[]) AND t.deployer IS NULL AND t.launchpad IS NULL`, [candidates.map(row => row.coin)])).rows;
    const wanted = new Map(rows.map(row => [hex(row.coin), row]));
    for (const candidate of candidates) {
      const address = hex(candidate.coin), want = wanted.get(address), reads: Promise<unknown>[] = [];
      if (want?.facts) reads.push(this.chain.facts(address));
      if (want?.mint) reads.push(this.chain.firstMint(address, BigInt(candidate.first_block) + 100n).then(mint =>
        mint && !(mint.to && this.addresses.entryPoints?.includes(mint.to.toLowerCase())) ? this.chain.sent(mint.wallet) : null));
      // A read that fails here is reported when the coin's turn comes.
      void Promise.all(reads).catch(() => undefined);
    }
  }
  start() { if (this.timer) return; this.heartbeat.start(); void this.tick(); this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 30_000); this.timer.unref(); }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.running; }
  tick(): Promise<void> {
    if (this.running) return this.running;
    if (this.now()<this.rpcRetryAt) return Promise.resolve();
    this.running = this.pass().then(() => this.heartbeat.complete()).catch(error => {
      const retryAt=rpcPauseRetryAt(error); if(retryAt!==undefined){this.rpcRetryAt=retryAt;return;}
      // Spent reads are a pause, said once every five minutes; anything else is a failed pass.
      if (error instanceof OnboardingReadsSpent) { this.heartbeat.complete(); if (this.now() - this.pausedAt >= 300_000) { this.pausedAt = this.now(); this.log('coin_onboarding_paused', { reason: 'daily_reads_spent' }); } return; }
      this.log('coin_onboarding_failed', { error: String((error as Error)?.message ?? error).slice(0, 200) });
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  /**
   * Coins to onboard: those with BUSY_SWAPS swaps in the last hour (busiest first, read every five minutes), then the
   * hour's launches (newest first, read every pass), then by swaps in the last day (read every half hour: counting a
   * day of swaps took 2.5 s and 1.1 million buffers on a copy of 2026-10-13, the last hour 0.14 s and 22,000).
   */
  private async candidates(started: number) {
    const skip = `t.deployer IS NULL AND t.launchpad IS NULL AND NOT t.address=ANY($2::bytea[]) AND NOT EXISTS(SELECT 1 FROM coin_onboarding o WHERE o.coin=t.address
      AND o.status IN ('unreadable','no_launch_wallet','skipped') AND o.updated_at>to_timestamp($1::double precision)-interval '6 hours'*least(o.attempts,8))`;
    const params = [started / 1000, [ZERO, ...this.addresses.reference].map(binary)];
    const fresh = (await this.db.sql.query<Candidate>(`SELECT t.address AS coin,t.first_block::text FROM tokens t
      WHERE t.first_block>coalesce((SELECT number FROM chain_blocks WHERE ts<to_timestamp($1::double precision)-interval '1 hour' ORDER BY ts DESC LIMIT 1),0) AND ${skip}
        AND EXISTS(SELECT 1 FROM pools p WHERE p.currency0=t.address OR p.currency1=t.address) ORDER BY t.first_block DESC LIMIT 100`, params)).rows;
    if (started - this.busiestAt >= 300_000) {
      this.busiest = (await this.db.sql.query<Candidate>(`SELECT t.address AS coin,t.first_block::text FROM (SELECT s.coin,count(*) AS n FROM swaps s
          WHERE s.ts>to_timestamp($1::double precision)-interval '1 hour' AND s.venue<>'pons_curve' GROUP BY s.coin HAVING count(*)>=${BUSY_SWAPS}) a JOIN tokens t ON t.address=a.coin
        WHERE ${skip} ORDER BY a.n DESC,t.address LIMIT 200`, params)).rows;
      this.busiestAt = started;
    }
    if (started - this.tradedAt >= 1_800_000 || !this.traded.length && started - this.tradedAt >= 300_000) {
      this.traded = (await this.db.sql.query<Candidate>(`SELECT t.address AS coin,t.first_block::text FROM (SELECT s.coin,count(*) AS n FROM swaps s
          WHERE s.ts>to_timestamp($1::double precision)-interval '24 hours' AND s.venue<>'pons_curve' GROUP BY s.coin) a JOIN tokens t ON t.address=a.coin
        WHERE ${skip} ORDER BY a.n DESC,t.address LIMIT 400`, params)).rows;
      this.tradedAt = started;
    }
    for (const [key, at] of this.failed) if (started - at >= 300_000) this.failed.delete(key);
    for (const [key, held] of this.reads) if (started - held.at >= READS_KEPT_MS) this.reads.delete(key);
    this.busy = this.busiest.filter(row => !this.failed.has(hex(row.coin)));
    const seen = new Set([...this.busy.map(row => hex(row.coin)), ...this.failed.keys()]);
    this.queue = [...fresh, ...this.traded].filter(row => { const key = hex(row.coin); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  private done(coin: Uint8Array) {
    const key = hex(coin), other = (row: Candidate) => hex(row.coin) !== key;
    this.hours.delete(key); this.minutes.delete(key); this.traded = this.traded.filter(other); this.busiest = this.busiest.filter(other); this.busy = this.busy.filter(other); this.queue = this.queue.filter(other);
  }
  private async mark(coin: Uint8Array, status: string, data: Record<string, unknown> = {}) {
    // Waits are measured on the worker's clock, so the row's time is too.
    await this.db.sql.query(`INSERT INTO coin_onboarding(coin,status,attempts,data,created_at,updated_at) VALUES($1,$2,1,$3::jsonb,to_timestamp($4::double precision),to_timestamp($4::double precision))
      ON CONFLICT(coin) DO UPDATE SET status=excluded.status,attempts=coin_onboarding.attempts+1,data=coin_onboarding.data||excluded.data,updated_at=excluded.updated_at`, [coin, status, JSON.stringify(data), this.now() / 1000]);
  }
  /**
   * Why a launch's sender is not the coin's own launch wallet, or null when it is: the transaction went through an
   * ERC-4337 entry point (sent by a bundler), the sender has sent AUTOMATED_SENDER_TXS transactions or its count
   * cannot be read, or this worker has seen it launch SHARED_LAUNCHES coins in a week.
   */
  private async shared(sent: { from: string; to: string | null }): Promise<string | null> {
    if (sent.to && this.addresses.entryPoints?.includes(sent.to.toLowerCase())) return 'entry_point';
    const launches = Number((await this.db.sql.query<{ n: string }>(`SELECT count(*) AS n FROM coin_onboarding WHERE data->>'sender'=$1 AND created_at>to_timestamp($2::double precision)-interval '7 days'`,
      [sent.from, this.now() / 1000])).rows[0].n);
    if (launches >= SHARED_LAUNCHES) return 'many_launches';
    const txs = await this.chain.sent(sent.from);
    return txs == null ? 'unreadable_sender' : txs >= AUTOMATED_SENDER_TXS ? 'automated_sender' : null;
  }
  /**
   * A coin's stored swaps priced, then named, a batch at a time, and its liquidity events the same way; false when the
   * pass ran out of time first (every step picks up where it stopped). Pricing goes an hour at a time, newest first:
   * each hour reads only that hour's ETH/USD reference swaps.
   */
  private async settle(coin: Uint8Array, deadline: number, bounds:RawMutationBounds): Promise<boolean> {
    try { return await this.settleLive(coin,deadline,bounds); }
    catch(error) {
      if(!sealedRawMutation(error))throw error;
      await this.mark(coin,'done',{settlement:'done_with_sealed_history'});
      this.hours.delete(hex(coin));this.minutes.delete(hex(coin));
      return true;
    }
  }
  private async settleLive(coin: Uint8Array, deadline: number, bounds:RawMutationBounds): Promise<boolean> {
    const batch = this.options.batch ?? ATTRIBUTE_BATCH, epoch = new Date(0), end = new Date(this.now() + HOUR), floor = new Date(this.now() - 2 * 24 * HOUR), key = hex(coin);
    let hours = this.hours.get(key);
    if (!hours) {
      const params:unknown[]=[coin],live=liveRawRows('s',bounds.swaps,params);
      hours = (await this.db.sql.query<{ hour: Date }>(`SELECT DISTINCT date_trunc('hour',ts) AS hour FROM swaps s WHERE ${live} AND coin=$1 AND usd IS NULL AND amount_coin>0 AND amount_quote>0 ORDER BY 1 DESC`, params)).rows.map(row => new Date(row.hour));
      this.hours.set(key, hours);
    }
    while (hours.length) {
      if (this.now() >= deadline) return false;
      const from = hours[0];
      if (await repricePonsSwaps(this.db, this.assets ??= pricingAssets(), from, new Date(from.getTime() + HOUR), ONBOARD_PRICE_BATCH, NO_CANDLES, [coin], bounds) < ONBOARD_PRICE_BATCH) hours.shift();
      this.minutes.delete(key);
    }
    // Candles of the last two days, newest first, CANDLE_MINUTES per transaction.
    let minutes = this.minutes.get(key);
    if (!minutes) {
      minutes = (await this.db.sql.query<{ minute: Date }>(`SELECT DISTINCT date_trunc('minute',ts) AS minute FROM swaps WHERE coin=$1 AND ts>=$2 AND ts<$3::timestamptz AND usd>0 ORDER BY 1 DESC`,
        [coin, floor, end])).rows.map(row => new Date(row.minute));
      this.minutes.set(key, minutes);
    }
    while (minutes.length) {
      if (this.now() >= deadline) return false;
      await rebuildCandles(this.db, minutes.slice(0, CANDLE_MINUTES).map(minute => ({ coin, minute })));
      minutes.splice(0, CANDLE_MINUTES);
    }
    for (;;) {
      if (this.now() >= deadline) return false;
      if (await attributeSwaps(this.db, this.addresses, epoch, end, batch, [coin], bounds) < batch) break;
    }
    for (;;) {
      if (this.now() >= deadline) return false;
      if (await attributeLiquidity(this.db, this.addresses, batch, [coin], bounds) < batch) break;
    }
    // Settled: the next time this coin has work (rows stored later), its lists are read afresh.
    this.hours.delete(key); this.minutes.delete(key);
    return true;
  }
  /** One coin, through to its launch wallet; 'unfinished' when the pass ran out of time first, 'set_aside' when it cannot be read yet. */
  private async onboard(candidate: Candidate, deadline: number, bounds:RawMutationBounds): Promise<'onboarded' | 'set_aside' | 'unfinished'> {
    const coin = candidate.coin, address = hex(coin);
    const token = (await this.db.sql.query<{ decimals: number | null; name: string | null; symbol: string | null; total_supply: string | null; deployer: Uint8Array | null; launchpad: string | null }>(
      'SELECT decimals,name,symbol,total_supply::text,deployer,launchpad FROM tokens WHERE address=$1', [coin])).rows[0];
    if (!token || token.deployer || token.launchpad) return 'set_aside';
    if (token.decimals == null || token.name == null || token.symbol == null || token.total_supply == null) {
      const facts = await this.chain.facts(address);
      // A token that answers only one of name and symbol is listed under the one it has.
      const name = facts.name ?? facts.symbol, symbol = facts.symbol ?? facts.name;
      if (facts.decimals == null || name == null || symbol == null) { await this.mark(coin, 'unreadable', { decimals: facts.decimals, named: name != null }); return 'set_aside'; }
      await this.db.sql.query(`UPDATE tokens SET decimals=coalesce(decimals,$2),name=coalesce(name,$3),symbol=coalesce(symbol,$4),
          total_supply=coalesce(total_supply,$5::numeric),supply_block=CASE WHEN total_supply IS NULL AND $5::numeric IS NOT NULL THEN (SELECT max(number) FROM chain_blocks) ELSE supply_block END
        WHERE address=$1`, [coin, facts.decimals, name, symbol, facts.totalSupply?.toString() ?? null]);
    }
    const state = (await this.db.sql.query<{ data: { launchWallet?: string } }>('SELECT data FROM coin_onboarding WHERE coin=$1', [coin])).rows[0];
    let wallet = state?.data.launchWallet;
    if (!wallet) {
      // The mint is at or before the coin's first pool or trade; a few blocks of slack for a pool opened in the same block.
      const mint = await this.chain.firstMint(address, BigInt(candidate.first_block) + 100n);
      // No first mint found near the coin's first pool (it was minted long before, or mints all the time): no wallet is
      // its launch wallet. The sender of some later transfer would be a guess.
      const shared = mint ? await this.shared({ from: mint.wallet, to: mint.to }) : 'mint_not_found';
      wallet = mint && !shared ? mint.wallet : address;
      await this.mark(coin, 'working', { launchWallet: wallet, ...(mint ? { sender: mint.wallet, senderTo: mint.to, mintBlock: mint.block.toString(), mintTx: mint.tx, mintTo: mint.mintTo } : {}), ...(shared ? { shared } : {}) });
    }
    if (!await this.settle(coin, deadline, bounds)) return 'unfinished';
    await this.db.tx(async tx => {
      await tx.sql.query('UPDATE tokens SET deployer=$2 WHERE address=$1 AND deployer IS NULL AND launchpad IS NULL', [coin, binary(wallet!)]);
      await tx.sql.query(`INSERT INTO coin_onboarding(coin,status,attempts,created_at,updated_at) VALUES($1,'done',1,to_timestamp($2::double precision),to_timestamp($2::double precision))
        ON CONFLICT(coin) DO UPDATE SET status='done',updated_at=excluded.updated_at`, [coin, this.now() / 1000]);
    });
    return 'onboarded';
  }
  private async pass() {
    const started = this.now();
    // The indexer comes first: no rewriting while it is behind.
    const newest = (await this.db.sql.query<{ ts: Date | null }>('SELECT ts FROM chain_blocks ORDER BY number DESC LIMIT 1')).rows[0]?.ts;
    const lagSec = newest ? (started - new Date(newest).getTime()) / 1000 : 0, maxLag = this.options.maxLagSec ?? 45;
    if (lagSec > maxLag) { if (started - this.pausedAt >= 300_000) { this.pausedAt = started; this.log('coin_onboarding_paused', { lagSec: Math.round(lagSec), maxLagSec: maxLag }); } return; }
    const budget = this.options.budgetMs ?? 10_000, deadline = started + budget, perTick = this.options.perTick ?? 8;
    // The chain reads of the coins this pass can reach start now and are answered while the database work below runs.
    const bounds=await rawMutationBounds(this.db);
    await this.candidates(started);
    await this.readAhead([...this.busy.slice(0, 2), ...this.queue.slice(0, perTick)]);
    // Onboarded coins first. The indexer names and prices their new swaps as it stores them; rows it stores without a
    // wallet arrive later, of any age (a backfill stream, or the stored raw events of a pool that has just become known).
    let settled = 0;
    // The probe is one index read per listed coin (1.2 s a pass with 720 coins listed on 2026-10-13), so the list is kept.
    if (started - this.behindAt >= 120_000) {
      const params:unknown[]=[],swapLive=liveRawRows('s',bounds.swaps,params),liquidityLive=liveRawRows('e',bounds.liquidity_events,params);
      this.behind = (await this.db.sql.query<{ coin: Uint8Array }>(`SELECT k.address AS coin FROM tokens k WHERE k.deployer IS NOT NULL AND k.launchpad IS NULL
        AND (EXISTS(SELECT 1 FROM swaps s WHERE ${swapLive} AND s.coin=k.address AND s.senders_pending AND s.venue<>'pons_curve')
          OR EXISTS(SELECT 1 FROM pools p JOIN liquidity_events e ON e.pool_id=p.id AND e.senders_pending WHERE ${liquidityLive} AND (p.currency0=k.address OR p.currency1=k.address))) LIMIT 20`,params)).rows.map(row => row.coin);
      this.behindAt = started;
    }
    const behind = this.behind.length, behindUntil = this.now() + (deadline - this.now()) / 3;
    try { while (this.behind.length) { if (this.now() >= behindUntil || !await this.settle(this.behind[0], behindUntil, bounds)) break; this.behind.shift(); settled++; } }
    // A statement that lost a deadlock leaves the coin for the next pass; the coins to onboard still get their turn.
    catch (error) { if (!['40P01', '40001'].includes(String((error as { code?: unknown })?.code))) throw error; this.log('coin_onboarding_retry', { coin: hex(this.behind[0]), reason: 'database_lock_contention' }); }
    let onboarded = 0, set = 0, unfinished = 0, tried = 0;
    // A coin that does not finish its group's time stays queued for the next pass: its work so far is stored.
    const work = async (list: () => Candidate[], until: number) => {
      for (; list().length && tried < perTick && this.now() < until; tried++) {
        const candidate = list()[0];
        let outcome: 'onboarded' | 'set_aside' | 'unfinished';
        try { outcome = await this.onboard(candidate, until, bounds); }
        catch (error) {
          if (error instanceof OnboardingReadsSpent || rpcPauseRetryAt(error)!==undefined) throw error;
          for (const key of this.rejected) this.reads.delete(key);
          this.rejected.clear();
          // Another writer held what this coin's statement needed (a deadlock or a serialization failure): nothing is
          // wrong with the coin, so it is tried again on the next pass instead of being left for five minutes.
          if (['40P01', '40001'].includes(String((error as { code?: unknown })?.code))) { unfinished++; this.log('coin_onboarding_retry', { coin: hex(candidate.coin), reason: 'database_lock_contention' }); return; }
          this.failed.set(hex(candidate.coin), started); this.busy = this.busy.filter(row => row !== candidate); this.queue = this.queue.filter(row => row !== candidate);
          this.log('coin_onboarding_failed', { coin: hex(candidate.coin), error: String((error as Error)?.message ?? error).slice(0, 200) });
          continue;
        }
        if (outcome === 'unfinished') { unfinished++; return; }
        this.done(candidate.coin);
        if (outcome === 'onboarded') onboarded++; else set++;
      }
    };
    await work(() => this.busy, Math.min(deadline, this.now() + budget / 3));
    await work(() => this.queue, deadline);
    if (settled || onboarded || set || unfinished) this.log('coin_onboarding', { settled, behind, onboarded, setAside: set, unfinished, busy: this.busy.length, queued: this.queue.length, lagSec: Math.round(lagSec), ms: this.now() - started });
  }
}
