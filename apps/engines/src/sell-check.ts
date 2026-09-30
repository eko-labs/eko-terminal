import { binary, hex, type ChainDb } from '@eko/db';
import { withRpcOrigin, balanceSlot, loadRegistry, poolSpotUsd, RpcGuardError, rpcStopReason, runSellProbe, sellRouteId, v4PoolId, SELL_CHECK_METHOD, type AddressRegistry, type SellProbe, type SellRoute, type SellRpc } from '@eko/chain';
import type { Address } from '@eko/shared';
import { getAddress, zeroAddress, type Hex } from 'viem';

/**
 * Live sell checks for Radar, coin pages and the quote guard (BACKEND §6.2, the eth_call probe fallback).
 * Readings are measurements at one block and route; anything not measured stays unavailable, never zero.
 */
export const SELL_CHECK_SIZES_USD = [100, 1000] as const;
export type SellCheckClass = 'first_live' | 'crash' | 'first_unlisted' | 'routine';
export type SellCheckStatus = 'sellable' | 'refused' | 'buy_failed' | 'unavailable' | 'unsupported';
export interface SellCheckResult {
  coin: Address; block: number; status: SellCheckStatus; route: SellRoute | null; ethUsd: number | null;
  /** On a token-paired Pons curve: the pair token's USD price the sizes used (probe amounts are in its units). */
  pairUsd?: number;
  /** Scheduler-only stop, after persisting any requests already dispatched. */
  stopReason?: ReturnType<typeof rpcStopReason>;
  /** Where that price came from: USDG at par, the pair's indexed swaps, or its Uniswap v3 USDG pool at the block. */
  pairUsdSource?: 'par' | 'swaps' | 'pool';
  probes: (SellProbe & { sizeUsd: number })[]; requests: number;
  exit100: number | null; exit1k: number | null;
}
export interface SellCheckReading {
  coin: Address; status: 'sellable' | 'refused'; block: number; checkedAt: Date;
  venue: SellRoute['venue']; exit100: number | null; exit1k: number | null;
}
const FEES = new Set([100, 500, 3000, 10000]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** ETH-USD as the indexer priced recent ETH-quoted swaps (their usd is the ETH amount times its ETH-USD reading). */
export async function indexedEthUsd(db: ChainDb, nowMs: number, registry: AddressRegistry = loadRegistry(), windowSec = 1800): Promise<number | null> {
  const weth = registry.requireAddress('tokens.WETH');
  const rows = (await db.sql.query<{ usd: number; amount_quote: string }>(`SELECT usd,amount_quote FROM swaps
    WHERE ts>to_timestamp($1::double precision) AND ts<=to_timestamp($2::double precision) AND quote_asset=ANY($3::bytea[]) AND usd>0 AND amount_quote>0
    ORDER BY ts DESC LIMIT 25`, [nowMs / 1000 - windowSec, nowMs / 1000, [binary(zeroAddress), binary(weth)]])).rows;
  const rates = rows.map(r => Number(r.usd) / (Number(r.amount_quote) / 1e18)).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!rates.length) return null;
  const mid = Math.floor(rates.length / 2);
  return rates.length % 2 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2;
}
/** USD size to wei at one ETH-USD reading. Display sizing only: the probe measures its own debit and credit. */
export function usdToWei(usd: number, ethUsd: number): bigint {
  if (!(usd > 0) || !(ethUsd > 0) || !Number.isFinite(usd) || !Number.isFinite(ethUsd)) throw new Error('Invalid sell-check size');
  return BigInt(Math.round(usd * 1e6)) * 10n ** 18n / BigInt(Math.max(1, Math.round(ethUsd * 1e6)));
}

/** USD size in a token's base units at one USD price. Sizing only: the probe measures its own debit and credit. */
export function usdToUnits(usd: number, price: number, decimals: number): bigint | null {
  const units = usd / price * 10 ** decimals;
  if (!(usd > 0) || !(price > 0) || !Number.isFinite(units) || units < 1 || units >= 2 ** 127) return null;
  return BigInt(Math.round(units));
}
/**
 * The USD price of a Pons curve's pair token: USDG at par, else the median of its 25 latest priced swaps as a coin within
 * a day at or below the block (the indexer's USD). Null without one: the $100 and $1,000 sizes cannot be expressed.
 */
export async function pairUsd(db: ChainDb, token: Address, block: number, nowMs: number, registry: AddressRegistry = loadRegistry()): Promise<{ usd: number; decimals: number } | null> {
  if (same(token, registry.requireAddress('tokens.USDG'))) return { usd: 1, decimals: registry.data.tokens.USDG.decimals ?? 6 };
  const rows = (await db.sql.query<{ price: number; decimals: number }>(`SELECT x.usd/(x.amount_coin::double precision/10^t.decimals) AS price,t.decimals FROM swaps x
    JOIN tokens t ON t.address=x.coin WHERE x.coin=$1 AND x.block<=$2 AND x.ts>=to_timestamp($3::double precision) AND x.usd>0 AND x.amount_coin>0 AND t.decimals IS NOT NULL
    ORDER BY x.block DESC,x.log_index DESC LIMIT 25`, [binary(token), block, nowMs / 1000 - 86400])).rows;
  const prices = rows.map(r => Number(r.price)).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  return { usd: prices.length % 2 ? prices[mid]! : (prices[mid - 1]! + prices[mid]!) / 2, decimals: Number(rows[0]!.decimals) };
}

/** About one day of Robinhood Chain blocks (~10 per second), for ranking pools by recent volume. */
const DAY_BLOCKS = 864_000;
/**
 * The route a check runs on, from indexed state only: the Pons curve until graduation, then the graduated pool, else
 * the native-ETH v3 or v4 pool with the most USD volume over about the last day.
 * TODO(spec): §6.1 picks the best route by output after fees among routes whose probe passes; this probes one route.
 */
export async function sellRoute(db: ChainDb, coin: Address, block: number, registry: AddressRegistry = loadRegistry()): Promise<SellRoute | null> {
  const token = (await db.sql.query<{ launchpad: string | null; curve: Uint8Array | null; graduated_block: string | null; graduated_pool: Uint8Array | null }>(
    'SELECT launchpad,curve,graduated_block,graduated_pool FROM tokens WHERE address=$1', [binary(coin)])).rows[0];
  if (!token) return null;
  const checksummed = getAddress(coin);
  if (token.launchpad === 'pons' && token.curve && (token.graduated_block == null || Number(token.graduated_block) > block)) {
    // A curve paired with another token (USDG, a stock token, another Pons coin) is probed in that token (PairProbe):
    // an ETH buy reverts UnexpectedNativeValue there. Its balance slot is found when the check runs (SellChecker).
    const pair = (await db.sql.query<{ pair: string | null }>("SELECT lower(data->>'pairToken') AS pair FROM pons_events WHERE token=$1 AND kind='launch' ORDER BY block LIMIT 1",
      [binary(coin)])).rows[0]?.pair;
    const route: SellRoute = { venue: 'pons_curve', coin: checksummed, curve: getAddress(hex(token.curve)) };
    return pair && /^0x[0-9a-f]{40}$/.test(pair) && pair !== zeroAddress ? { ...route, pair: { token: getAddress(pair) } } : route;
  }
  const pools = (await db.sql.query<{ id: Uint8Array; venue: string; currency0: Uint8Array; currency1: Uint8Array; fee: number; tick_spacing: number; hooks: Uint8Array | null; created_block: string }>(
    `SELECT id,venue,currency0,currency1,fee,tick_spacing,hooks,created_block FROM pools
     WHERE (currency0=$1 OR currency1=$1) AND created_block<=$2 AND venue IN ('uniswap_v3','uniswap_v4')`, [binary(coin), block])).rows;
  const weth = registry.addressOf('tokens.WETH'), router = registry.addressOf('uniswapV3.swapRouter02'), quoter = registry.addressOf('uniswapV3.quoterV2');
  const manager = registry.addressOf('uniswapV4.poolManager'), v4Quoter = registry.addressOf('uniswapV4.v4Quoter');
  const routes: { id: string; route: SellRoute; usd: number; created: number; graduated: boolean }[] = [];
  for (const p of pools) {
    const id = hex(p.id), c0 = hex(p.currency0), c1 = hex(p.currency1), other = same(c0, coin) ? c1 : c0;
    const graduated = !!token.graduated_pool && same(hex(token.graduated_pool), id), created = Number(p.created_block);
    if (p.venue === 'uniswap_v3' && weth && router && quoter && same(other, weth) && FEES.has(p.fee) && /^0x[0-9a-f]{40}$/.test(id))
      routes.push({ id, route: { venue: 'uniswap_v3', coin: checksummed, pool: getAddress(id), router, quoter, weth, fee: p.fee as 100 | 500 | 3000 | 10000 }, usd: 0, created, graduated });
    if (p.venue === 'uniswap_v4' && manager && v4Quoter && same(c0, zeroAddress) && same(c1, coin) && /^0x[0-9a-f]{64}$/.test(id)) {
      // V4Probe supports native ETH as currency0 only; the key must hash to the indexed PoolId.
      const key = { currency0: zeroAddress, currency1: checksummed, fee: p.fee, tickSpacing: p.tick_spacing, hooks: p.hooks ? getAddress(hex(p.hooks)) : zeroAddress };
      if (v4PoolId(key).toLowerCase() === id)
        routes.push({ id, route: { venue: 'uniswap_v4', coin: checksummed, poolId: id as Hex, manager, quoter: v4Quoter, key, hookData: '0x' }, usd: 0, created, graduated });
    }
  }
  // Volume only breaks a tie between several candidate pools; the coin/block index bounds the scan.
  if (routes.length > 1 && !routes.some(r => r.graduated)) {
    const volume = new Map((await db.sql.query<{ pool_id: Uint8Array; usd: number | null }>('SELECT pool_id,sum(usd) AS usd FROM swaps WHERE coin=$1 AND block>$2 AND block<=$3 GROUP BY pool_id',
      [binary(coin), block - DAY_BLOCKS, block])).rows.map(r => [hex(r.pool_id), Number(r.usd ?? 0)]));
    for (const r of routes) r.usd = volume.get(r.id as Hex) ?? 0;
  }
  routes.sort((a, b) => Number(b.graduated) - Number(a.graduated) || b.usd - a.usd || b.created - a.created);
  return routes[0]?.route ?? null;
}
export function combineSellProbes(probes: SellProbe[]): SellCheckStatus {
  if (probes.some(p => p.status === 'sell_failed')) return 'refused';
  if (probes.some(p => p.status === 'sellable')) return 'sellable';
  if (probes.length && probes.every(p => p.status === 'buy_failed')) return 'buy_failed';
  return 'unavailable';
}
/** Runs the probe on the coin's indexed route at the given block. Shared by the engines scheduler and the API quote guard. */
export class SellChecker {
  /** Balance layouts of pair tokens, found once per process (one paid eth_call per layout tried). */
  private balances = new Map<string, ReturnType<typeof balanceSlot>>();
  /** Pool spot prices of pair tokens without an indexed price, kept ten minutes (nine to twelve paid reads each). */
  private spots = new Map<string, { at: number; value: ReturnType<typeof poolSpotUsd> }>();
  constructor(readonly db: ChainDb, readonly rpc: SellRpc, readonly options: { registry?: AddressRegistry; now?: () => number; paidWorkAllowed?: (work: 'routine' | 'first_rating' | 'crash') => Promise<boolean> } = {}) {}
  private get registry() { return this.options.registry ??= loadRegistry(); }
  now() { return this.options.now?.() ?? Date.now(); }
  ethUsd() { return indexedEthUsd(this.db, this.now(), this.registry); }
  async check(coin: Address, block: number, sizesUsd: readonly number[], ethUsd?: number | null, admit?: () => boolean): Promise<SellCheckResult> {
    let requests = 0, limited = false;
    let stopReason: ReturnType<typeof rpcStopReason>;
    // Admission is at the actual request boundary: pair pricing and balance discovery can cost far more than four.
    const rpc: SellRpc = { request: async input => {
      if (stopReason || (admit && !admit())) { limited = true; throw new Error('Sell-check request allowance exhausted'); }
      requests++;
      try { return await withRpcOrigin('engines.sell_check.rawL139',()=>this.rpc.request(input)); }
      catch (error) {
        if (admit && rpcStopReason(error)) { stopReason = rpcStopReason(error); throw new Error('Sell-check RPC stopped'); }
        throw error;
      }
    } };
    const result = await this.checkWithRpc(coin, block, sizesUsd, ethUsd, rpc);
    return limited || stopReason ? { ...result, status: 'unavailable', probes: [], exit100: null, exit1k: null, requests, ...(stopReason ? { stopReason } : {}) }
      : { ...result, requests };
  }
  private async checkWithRpc(coin: Address, block: number, sizesUsd: readonly number[], ethUsd: number | null | undefined, rpc: SellRpc): Promise<SellCheckResult> {
    const base: SellCheckResult = { coin, block, status: 'unavailable', route: null, ethUsd: null, probes: [], requests: 0, exit100: null, exit1k: null };
    const route = await sellRoute(this.db, coin, block, this.registry);
    if (!route) return { ...base, status: 'unsupported' };
    if (route.venue === 'pons_curve' && route.pair) return this.checkPair(base, { ...route, pair: route.pair }, block, sizesUsd, rpc);
    const price = ethUsd === undefined ? await this.ethUsd() : ethUsd;
    if (price == null) return { ...base, route };
    const probes = await Promise.all(sizesUsd.map(async sizeUsd => ({ ...await runSellProbe(rpc, route, usdToWei(sizeUsd, price), BigInt(block), { nowSec: () => this.now() / 1000 }), sizeUsd })));
    const exit = (size: number) => { const p = probes.find(p => p.sizeUsd === size); return p && (p.status === 'sellable' || p.status === 'sell_failed') ? p.exitCostPct : null; };
    return { ...base, route, ethUsd: price, probes, requests: probes.reduce((n, p) => n + p.requests, 0), status: combineSellProbes(probes), exit100: exit(100), exit1k: exit(1000) };
  }
  /**
   * A token-paired Pons curve: the sizes are $100 and $1,000 of the pair token at its USD price (USDG at par, its indexed
   * swaps, else its Uniswap v3 USDG pool at the block), the probe holds it through its balance slot, and amounts are in
   * its units. Without a price or a found slot the route is unsupported.
   */
  private async checkPair(base: SellCheckResult, route: Extract<SellRoute, { venue: 'pons_curve' }> & { pair: NonNullable<Extract<SellRoute, { venue: 'pons_curve' }>['pair']> },
    block: number, sizesUsd: readonly number[], rpc: SellRpc): Promise<SellCheckResult> {
    let requests = 0, source: SellCheckResult['pairUsdSource'] = same(route.pair.token, this.registry.requireAddress('tokens.USDG')) ? 'par' : 'swaps';
    let quote = await pairUsd(this.db, route.pair.token, block, this.now(), this.registry);
    if (!quote) {
      const decimals = (await this.db.sql.query<{ decimals: number | null }>('SELECT decimals FROM tokens WHERE address=$1', [binary(route.pair.token)])).rows[0]?.decimals;
      if (decimals != null) {
        const key = route.pair.token.toLowerCase(), cached = this.spots.get(key), fresh = cached && this.now() - cached.at < 600_000;
        const value = fresh ? cached.value : poolSpotUsd(rpc, route.pair.token, Number(decimals), block, this.registry);
        if (!fresh) { this.spots.set(key, { at: this.now(), value }); value.catch(() => this.spots.delete(key)); }
        const spot = await value;
        if (!fresh) requests += spot.requests;
        if (spot.failed) { this.spots.delete(key); return { ...base, route, status: 'unavailable', requests }; }
        if (spot.usd != null) { quote = { usd: spot.usd, decimals: Number(decimals) }; source = 'pool'; }
      }
    }
    const sizes = quote ? sizesUsd.map(sizeUsd => ({ sizeUsd, units: usdToUnits(sizeUsd, quote!.usd, quote!.decimals) })) : [];
    if (!quote || !sizes.length || sizes.some(size => size.units == null)) return { ...base, route, status: 'unsupported', requests };
    const key = route.pair.token.toLowerCase();
    let found = this.balances.get(key);
    if (!found) {
      found = balanceSlot(rpc, route.pair.token, BigInt(block));
      this.balances.set(key, found);
      // A stop or a failed read is looked up again; only a token with no matching layout stays unsupported.
      found.then(result => { if (result.failed) this.balances.delete(key); }, () => this.balances.delete(key));
      requests += (await found).requests;
    }
    const { balance, failed } = await found;
    if (failed) return { ...base, route, status: 'unavailable', requests };
    if (!balance) return { ...base, route, status: 'unsupported', requests };
    const priced = { ...route, pair: { token: route.pair.token, balance } };
    const probes = await Promise.all(sizes.map(async ({ sizeUsd, units }) => ({ ...await runSellProbe(rpc, priced, units!, BigInt(block), { nowSec: () => this.now() / 1000 }), sizeUsd })));
    const exit = (size: number) => { const p = probes.find(p => p.sizeUsd === size); return p && (p.status === 'sellable' || p.status === 'sell_failed') ? p.exitCostPct : null; };
    return { ...base, route: priced, pairUsd: quote.usd, pairUsdSource: source, probes, requests: requests + probes.reduce((n, p) => n + p.requests, 0), status: combineSellProbes(probes), exit100: exit(100), exit1k: exit(1000) };
  }
}

/** Indexed route topology, without paid reads. Changes to a curve, pair or pool invalidate a cooldown. */
const routeStateSql = (block: string) => `jsonb_build_object(
  'curve',encode(t.curve,'hex'),'graduated_pool',CASE WHEN t.graduated_block<=${block} THEN encode(t.graduated_pool,'hex') END,
  'graduated',coalesce(t.graduated_block<=${block},false),
  'pair',(SELECT lower(data->>'pairToken') FROM pons_events WHERE token=t.address AND kind='launch' AND block<=${block} ORDER BY block LIMIT 1),
  'pools',coalesce((SELECT jsonb_agg(jsonb_build_array(encode(p.id,'hex'),p.venue,encode(p.currency0,'hex'),encode(p.currency1,'hex'),p.fee,p.tick_spacing,encode(p.hooks,'hex')) ORDER BY p.id)
    FROM pools p WHERE (p.currency0=t.address OR p.currency1=t.address) AND p.created_block<=${block} AND p.venue IN ('uniswap_v3','uniswap_v4')),'[]'::jsonb))`;

const MEASURED = new Set<SellCheckStatus>(['sellable', 'refused', 'buy_failed']);
/** Store one check: every run as evidence, and the current reading. A transient failure keeps the earlier reading of
 * the same route; a new route or a lost route replaces it, so a closed curve's reading never outlives graduation. */
export async function persistSellCheck(db: ChainDb, result: SellCheckResult, at: Date, activityAt: Date | null, scheduleClass?: SellCheckClass) {
  const routeId = result.route ? sellRouteId(result.route) : null;
  const data = { ethUsd: result.ethUsd, ...(result.pairUsd !== undefined ? { pairUsd: result.pairUsd, pairUsdSource: result.pairUsdSource } : {}), route: result.route, probes: result.probes.map(({ requests: _requests, ...p }) => p) };
  await db.tx(async tx => {
    await tx.sql.query('INSERT INTO sell_check_runs(coin,block,checked_at,status,requests,data,schedule_class) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [binary(result.coin), result.block, at, result.status, result.requests, JSON.stringify(data), scheduleClass ?? null]);
    const prior = (await tx.sql.query<{ route_id: string | null; status: SellCheckStatus; buy_failures: number }>('SELECT route_id,status,buy_failures FROM sell_check_latest WHERE coin=$1 FOR UPDATE', [binary(result.coin)])).rows[0];
    const state = (await tx.sql.query<{ route_state: unknown; price: number | null; peak_crash: boolean }>(`SELECT ${routeStateSql('$2')} AS route_state,p.price,
      coalesce(p.price<=p.peak*0.2,false) AS peak_crash FROM tokens t LEFT JOIN coin_rating_prices p ON p.coin=t.address AND p.block<=$2 WHERE t.address=$1`,
      [binary(result.coin), result.block])).rows[0];
    if (result.status === 'unavailable' && prior && MEASURED.has(prior.status) && prior.route_id === routeId) {
      await tx.sql.query('UPDATE sell_check_latest SET attempted_at=$2,attempt_status=$3,price=$4,peak_crash=$5,route_state=$6 WHERE coin=$1', [binary(result.coin), at, result.status, state?.price ?? null, state?.peak_crash ?? false, JSON.stringify(state?.route_state ?? null)]);
      return;
    }
    await tx.sql.query(`INSERT INTO sell_check_latest(coin,block,checked_at,activity_at,venue,route_id,status,exit_cost_100_pct,exit_cost_1k_pct,method_version,data,attempted_at,attempt_status,buy_failures,route_state,price,peak_crash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$3,$7,$12,$13,$14,$15) ON CONFLICT(coin) DO UPDATE SET block=excluded.block,checked_at=excluded.checked_at,activity_at=excluded.activity_at,
      venue=excluded.venue,route_id=excluded.route_id,status=excluded.status,exit_cost_100_pct=excluded.exit_cost_100_pct,exit_cost_1k_pct=excluded.exit_cost_1k_pct,
      method_version=excluded.method_version,data=excluded.data,attempted_at=excluded.attempted_at,attempt_status=excluded.attempt_status,
      buy_failures=excluded.buy_failures,route_state=excluded.route_state,price=excluded.price,peak_crash=excluded.peak_crash`,
      [binary(result.coin), result.block, at, activityAt, result.route?.venue ?? null, routeId, result.status,
        MEASURED.has(result.status) ? result.exit100 : null, MEASURED.has(result.status) ? result.exit1k : null, SELL_CHECK_METHOD, JSON.stringify(data), result.status === 'buy_failed' ? (prior?.status === 'buy_failed' && prior.route_id === routeId ? prior.buy_failures : 0) + 1 : 0,
        JSON.stringify(state?.route_state ?? null), state?.price ?? null, state?.peak_crash ?? false]);
  });
}

/** Current sellable/refused readings for the read model. Older than maxAgeMs means not checked any more, never stale data. */
export async function readSellChecks(db: ChainDb, coins: Address[], nowMs: number, maxAgeMs = 48 * 3600_000): Promise<Map<Address, SellCheckReading>> {
  if (!coins.length) return new Map();
  const rows = (await db.sql.query<{ coin: Uint8Array; status: 'sellable' | 'refused'; block: string; checked_at: Date; venue: SellRoute['venue']; exit_cost_100_pct: number | null; exit_cost_1k_pct: number | null }>(
    `SELECT coin,status,block,checked_at,venue,exit_cost_100_pct,exit_cost_1k_pct FROM sell_check_latest
     WHERE coin=ANY($1::bytea[]) AND status IN ('sellable','refused') AND checked_at>to_timestamp($2::double precision)`, [coins.map(binary), (nowMs - maxAgeMs) / 1000])).rows;
  return new Map(rows.map(r => [hex(r.coin), { coin: hex(r.coin), status: r.status, block: Number(r.block), checkedAt: new Date(r.checked_at), venue: r.venue,
    exit100: r.exit_cost_100_pct, exit1k: r.exit_cost_1k_pct }]));
}

/** A buy quote refused because the sell failed at the quoted size. Counted per coin; no account or wallet is stored. */
export async function recordSellRefusal(db: ChainDb, result: SellCheckResult, at: Date, sizeUsd: number) {
  await db.sql.query('INSERT INTO sell_check_refusals(coin,refused_at,block,data) VALUES($1,$2,$3,$4)', [binary(result.coin), at, result.block,
    JSON.stringify({ sizeUsd, route: result.route ? sellRouteId(result.route) : null, probes: result.probes.map(p => ({ status: p.status, reason: p.reason, exitCostPct: p.exitCostPct, sizeWei: p.sizeWei })) })]);
}
/** Distinct coins refused since UTC midnight, and per hour over the last 24 hours (oldest first). */
export async function sellRefusalTotals(db: ChainDb, nowMs: number) {
  const midnight = Math.floor(nowMs / 86400000) * 86400, from = Math.floor(nowMs / 3600000) * 3600 - 23 * 3600;
  const [today, hourly] = await Promise.all([
    db.sql.query<{ n: string }>('SELECT count(DISTINCT coin) AS n FROM sell_check_refusals WHERE refused_at>=to_timestamp($1::double precision) AND refused_at<to_timestamp($2::double precision)', [midnight, nowMs / 1000]),
    db.sql.query<{ h: number; n: string }>(`SELECT floor((extract(epoch FROM refused_at)-$1)/3600)::int AS h,count(DISTINCT coin) AS n FROM sell_check_refusals
      WHERE refused_at>=to_timestamp($1::double precision) AND refused_at<to_timestamp($2::double precision) GROUP BY 1`, [from, nowMs / 1000]),
  ]);
  return { today: Number(today.rows[0]?.n ?? 0), byHour: Array.from({ length: 24 }, (_, i) => Number(hourly.rows.find(r => Number(r.h) === i)?.n ?? 0)) };
}

export interface SellCheckSchedule {
  batch?: number; parallel?: number; minAgeSec?: number; minIntervalSec?: number;
  /** Routine refused-reading refresh and provider-failure retry. */
  maxAgeSec?: number; retrySec?: number;
  unsupportedDays?: number; buyFailedHours?: number; sellableHours?: number; reservePct?: number;
  dailyRequests?: number;
}
const DEFAULTS: Required<SellCheckSchedule> = {
  batch: 8, parallel: 4, minAgeSec: 30, minIntervalSec: 600, maxAgeSec: 86400, retrySec: 900,
  unsupportedDays: 7, buyFailedHours: 24, sellableHours: 24, reservePct: 20, dailyRequests: 60_000,
};
/** Oldest launches first within each budget class. Cooldowns survive process restarts. */
export class SellCheckScheduler {
  private readonly cfg: Required<SellCheckSchedule>;
  private stopped = false; private wake?: () => void;
  private pausedUntil = 0; private prunedAt = 0;
  constructor(readonly db: ChainDb, readonly checker: SellChecker, schedule: SellCheckSchedule = {}, readonly log: (event: string, fields: Record<string, unknown>) => void = () => {}) {
    this.cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(schedule).filter(([, v]) => v !== undefined)) };
    for (const [key, value] of Object.entries(this.cfg)) if (!Number.isSafeInteger(value) || value < 0 || (['batch', 'parallel'].includes(key) && value < 1)) throw new Error(`Invalid sell-check ${key}`);
    if (this.cfg.reservePct > 100) throw new Error('Invalid sell-check reservePct');
  }
  stop() { this.stopped = true; this.wake?.(); }
  async run(pollMs: number) {
    while (!this.stopped) {
      let attempted = 0;
      try { attempted = await this.tick(); }
      catch (error) {
        const reason = rpcStopReason(error);
        if (reason === 'rpc_budget_exhausted') { this.pausedUntil = (Math.floor(this.checker.now() / 86400000) + 1) * 86400000; this.log('sell_check_paused', { reason }); }
        else if (reason) { this.log('sell_check_stopped', { reason }); return; }
        else this.log('sell_check_failed', {});
      }
      if (this.stopped) return;
      if (attempted >= this.cfg.batch) continue;
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, pollMs); timer.unref?.(); this.wake = () => { clearTimeout(timer); resolve(); }; });
    }
  }
  private async head(): Promise<number | null> {
    const row = (await this.db.sql.query<{ block: string | null }>(`SELECT coalesce((SELECT block FROM ingest_cursors WHERE stream='head'),(SELECT max(number) FROM chain_blocks)) AS block`)).rows[0];
    return row?.block == null ? null : Number(row.block);
  }
  /** Actual stored requests, including other writers, rather than a restart-local estimate. */
  private async budget(now: number) {
    const spent = Number((await this.db.sql.query<{ n: string }>(`SELECT coalesce(sum(requests),0) AS n FROM sell_check_runs
      WHERE checked_at>=to_timestamp($1::double precision) AND checked_at<to_timestamp($2::double precision)`,
      [Math.floor(now / 86400000) * 86400, (Math.floor(now / 86400000) + 1) * 86400])).rows[0]!.n);
    return Math.max(0, this.cfg.dailyRequests - spent);
  }
  /** First live, crash rechecks, first unlisted, routine; a batch cannot starve an older launch in its class. */
  async due(now: number, head?: number) {
    const block = head ?? await this.head();
    if (block == null) return [];
    const c = this.cfg;
    return (await this.db.sql.query<{ coin: Uint8Array; activity: Date | null; class: SellCheckClass }>(`WITH candidates AS (
      SELECT t.address AS coin,r.activity,t.first_block,l.coin IS NULL AS first,
        l.status,l.attempt_status,l.attempted_at,l.checked_at,l.block AS checked_block,l.buy_failures,
        coalesce(v.high_block>l.block,false) AS new_trades,
        -- Same price-crash thresholds as ratingPriceMove; the sell-check baseline is independent of card rewrites.
        coalesce(p.block>l.block AND p.block<=$2 AND
          (p.price<=coalesce(l.price,rc.full_price)*0.5 OR (p.price<=p.peak*0.2 AND NOT l.peak_crash)),false) AS crash,
        CASE WHEN l.route_state IS NOT NULL THEN l.route_state IS DISTINCT FROM ${routeStateSql('$2')}
          ELSE (l.venue='pons_curve' AND t.graduated_block<= $2)
            OR EXISTS(SELECT 1 FROM pools p WHERE (p.currency0=t.address OR p.currency1=t.address) AND p.created_block>l.block AND p.created_block<=$2)
            OR (l.data->'route'->>'curve' IS NOT NULL AND lower(l.data->'route'->>'curve') IS DISTINCT FROM '0x'||encode(t.curve,'hex')) END AS route_changed
      FROM tokens t LEFT JOIN read_coins r ON r.coin=t.address LEFT JOIN sell_check_latest l ON l.coin=t.address
      LEFT JOIN engine_block_times bt ON bt.number=t.first_block LEFT JOIN chain_blocks cb ON cb.number=t.first_block
      LEFT JOIN engine_swap_versions v ON v.coin=t.address LEFT JOIN coin_rating_prices p ON p.coin=t.address
      LEFT JOIN coin_rating_checks rc ON rc.coin=t.address
      WHERE t.first_block<=$2 AND coalesce(bt.ts,cb.ts,r.activity)<=to_timestamp($1::double precision-$3)
        AND (l.coin IS NULL OR greatest(r.activity,p.ts,bt.ts,cb.ts)>to_timestamp($1::double precision-604800))
    ), due AS (
      SELECT *,CASE WHEN first AND activity>to_timestamp($1::double precision-86400) THEN 'first_live'
        WHEN NOT first AND crash THEN 'crash' WHEN first THEN 'first_unlisted' ELSE 'routine' END AS class
      FROM candidates WHERE first OR crash OR route_changed
        OR (attempt_status='unavailable' AND attempted_at<=to_timestamp($1::double precision-$4))
        OR (attempt_status<>'unavailable' AND CASE status
          WHEN 'unsupported' THEN attempted_at<=to_timestamp($1::double precision-$5)
          WHEN 'buy_failed' THEN attempted_at<=to_timestamp($1::double precision-least(604800,$6::double precision*power(2,least(20,greatest(0,buy_failures-1)))))
          WHEN 'sellable' THEN (new_trades AND attempted_at<=to_timestamp($1::double precision-$7)) OR checked_at<=to_timestamp($1::double precision-$8)
          ELSE (new_trades AND attempted_at<=to_timestamp($1::double precision-$7)) OR attempted_at<=to_timestamp($1::double precision-$9) END)
    ) SELECT coin,activity,class FROM due
      ORDER BY CASE class WHEN 'first_live' THEN 0 WHEN 'crash' THEN 1 WHEN 'first_unlisted' THEN 2 ELSE 3 END,first_block,coin LIMIT $10`,
      [now / 1000, block, c.minAgeSec, c.retrySec, c.unsupportedDays * 86400, c.buyFailedHours * 3600, c.minIntervalSec, c.sellableHours * 3600, c.maxAgeSec, c.batch])).rows
      .map(r => ({ coin: hex(r.coin), activity: r.activity ? new Date(r.activity) : null, class: r.class }));
  }
  /** One bounded pass; reserve admission covers every RPC, including token-pair discovery. */
  async tick() {
    const now = this.checker.now();
    if (now < this.pausedUntil) return 0;
    if (now - this.prunedAt >= 3600_000) { await this.db.sql.query('DELETE FROM sell_check_runs WHERE checked_at<to_timestamp($1::double precision)', [now / 1000 - 30 * 86400]); this.prunedAt = now; }
    const block = await this.head();
    if (block == null) return 0;
    const coins = await this.due(now, block);
    if (!coins.length) return 0;
    const ethUsd = await this.checker.ethUsd();
    if (ethUsd == null) { this.log('sell_check_waiting', { reason: 'eth_usd_unavailable' }); return 0; }
    let attempted = 0;
    for (let i = 0; i < coins.length && !this.stopped;) {
      const kind = coins[i]!.class, urgent = kind === 'first_live' || kind === 'crash';
      const work=kind === 'first_live' ? 'first_rating' : kind === 'crash' ? 'crash' : 'routine';
      if(this.checker.options.paidWorkAllowed && !(await this.checker.options.paidWorkAllowed(work))) {i++;continue;}
      const reserve = urgent ? 0 : Math.ceil(this.cfg.dailyRequests * this.cfg.reservePct / 100);
      let allowance = Math.max(0, await this.budget(this.checker.now()) - reserve);
      if (allowance < SELL_CHECK_SIZES_USD.length * 2) {
        this.log(reserve ? 'sell_check_reserve' : 'sell_check_daily_cap', { cap: this.cfg.dailyRequests, remaining: allowance + reserve }); break;
      }
      const group = coins.slice(i, i + Math.min(this.cfg.parallel, Math.floor(allowance / 4))).filter(c => c.class === kind);
      const results = await Promise.all(group.map(({ coin }) => withRpcOrigin('engines.sell_check',()=>this.checker.check(coin, block, SELL_CHECK_SIZES_USD, ethUsd,
        () => { if (allowance <= 0) return false; allowance--; return true; }),work)));
      for (let j = 0; j < results.length; j++) {
        await persistSellCheck(this.db, results[j]!, new Date(this.checker.now()), group[j]!.activity, kind);
        attempted++;
      }
      const stop = results.find(r => r.stopReason)?.stopReason;
      if (stop) throw new RpcGuardError(stop);
      i += group.length;
    }
    return attempted;
  }
}
