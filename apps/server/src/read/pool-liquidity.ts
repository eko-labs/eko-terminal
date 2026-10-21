import { binary, hex, type ChainDb } from '@eko/db';
import type { Address } from '@eko/shared';

/** Top N of each source suffice for top N of their union, including retained tails and their original ties. */
function latestSwaps(limit:number,condition='') {
  const fields='s.coin,s.pool_id,s.block,s.log_index,s.tx_hash,s.amount_coin,s.amount_quote,s.usd,s.ts';
  const order='ORDER BY s.block DESC,s.log_index DESC,s.tx_hash DESC';
  return `SELECT * FROM (
    (SELECT ${fields} FROM swaps s WHERE s.coin=t.address ${condition} ${order} LIMIT ${limit})
    UNION ALL
    (SELECT ${fields} FROM (SELECT l.coin,decode(substring(r->>'pool_id' FROM 3),'hex') AS pool_id,(r->>'block')::bigint AS block,
      (r->>'log_index')::int AS log_index,decode(substring(r->>'tx_hash' FROM 3),'hex') AS tx_hash,
      (r->>'amount_coin')::numeric AS amount_coin,(r->>'amount_quote')::numeric AS amount_quote,(r->>'usd')::float8 AS usd,(r->>'ts')::timestamptz AS ts
      FROM coin_lifetime l CROSS JOIN LATERAL jsonb_array_elements(coalesce(l.data->'tail','[]') ||
        CASE WHEN l.data->'lastPositivePriced' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(l.data->'tail','[]')) kept
          WHERE kept->>'tx_hash'=l.data->'lastPositivePriced'->>'tx_hash' AND kept->>'log_index'=l.data->'lastPositivePriced'->>'log_index')
        THEN jsonb_build_array(l.data->'lastPositivePriced') ELSE '[]'::jsonb END) r WHERE l.coin=t.address) s
      WHERE true ${condition} ${order} LIMIT ${limit})
    ) s ${order} LIMIT ${limit}`;
}

/**
 * USD value of both sides of a full-range Uniswap position with liquidity L, from one trade on the pool: the reserves are
 * L*sqrt(p) of the quote and L/sqrt(p) of the coin at price p (quote per coin, base units), each worth
 * L*usd/sqrt(quote*coin) by a trade of `coin` for `quote` base units priced at `usd`. The trade's amounts include the
 * hook's fee, so the price is off by that fee and the value by about half of it.
 */
export function poolValueUsd(liquidity: number, coinAmount: number, quoteAmount: number, usd: number): number | null {
  if (!(coinAmount > 0) || !(quoteAmount > 0) || !(usd > 0) || !Number.isFinite(liquidity)) return null;
  return Math.max(0, 2 * liquidity * usd / Math.sqrt(quoteAmount * coinAmount));
}
/**
 * Liquidity of graduated coins' pools in USD, by coin: the pool's full-range positions (a Pons graduation deposits one,
 * tick -887200 to 887200) valued at the pool's latest priced trade. Absent for a coin that has not graduated, has no
 * such position on record, or has not traded on its pool yet. Narrower positions are not counted.
 */
export async function readPoolLiquidity(db: ChainDb, coins: Address[]): Promise<Map<Address, number>> {
  const found = new Map<Address, number>();
  if (!coins.length) return found;
  const rows = (await db.sql.query<{ coin: Uint8Array; liquidity: number | null; coin_amount: number | null; quote_amount: number | null; usd: number | null }>(`
    SELECT t.address AS coin,CASE WHEN l.liquidity IS NOT NULL OR life.data->'liquidity'->('0x'||encode(t.graduated_pool,'hex')) ? 'fullRangeDelta' THEN (coalesce(l.liquidity,0)+coalesce((life.data->'liquidity'->('0x'||encode(t.graduated_pool,'hex'))->>'fullRangeDelta')::numeric,0))::float8 END AS liquidity,s.amount_coin::float8 AS coin_amount,s.amount_quote::float8 AS quote_amount,s.usd
    FROM tokens t LEFT JOIN coin_lifetime life ON life.coin=t.address
    LEFT JOIN LATERAL (SELECT sum(e.liquidity) FILTER(WHERE e.n_amount>0) AS liquidity FROM read_pool_positions e
      WHERE e.pool_id=t.graduated_pool AND e.kind='ModifyLiquidity' AND e.n>0 AND nullif(e.lower_tick,'')::int<=-887000 AND nullif(e.upper_tick,'')::int>=887000) l ON true
    -- The coin's latest 50 swaps by its (coin, block) index, then the newest of them on its pool with a price. Filtering
    -- by pool inside the index scan made the planner sort every swap of a busy coin: 2.5 s for one Radar page.
    LEFT JOIN LATERAL (SELECT recent.amount_coin,recent.amount_quote,recent.usd FROM (
        ${latestSwaps(50,'AND s.block>=t.graduated_block')}) recent
      WHERE recent.pool_id=t.graduated_pool AND recent.usd>0 AND recent.amount_coin>0 AND recent.amount_quote>0 ORDER BY recent.block DESC,recent.log_index DESC,recent.tx_hash DESC LIMIT 1) s ON true
    WHERE t.address=ANY($1::bytea[]) AND t.graduated_pool IS NOT NULL AND t.graduated_block IS NOT NULL`, [coins.map(binary)])).rows;
  for (const row of rows) {
    if (row.liquidity == null || row.coin_amount == null || row.quote_amount == null || row.usd == null) continue;
    const value = poolValueUsd(Number(row.liquidity), Number(row.coin_amount), Number(row.quote_amount), Number(row.usd));
    if (value != null) found.set(hex(row.coin) as Address, value);
  }
  return found;
}

/**
 * Where a Pons launch curve stands at its latest priced trade: progress toward graduation (percent of the graduation
 * reserve raised) and the USD held in the curve, which is what sellers can take out in all. A Pons curve is a
 * constant product over a virtual quote reserve of 0.4 times the graduation reserve and the whole token supply
 * (measured 2026-10-12: card progress = 40 x s/(1-s) for s = share of supply bought, median 40.0 on every curve size),
 * so a trade at price p (quote per coin, base units) puts the quote side at sqrt(0.4 x T x supply x p) and the real
 * reserve at that less 0.4 x T. The trade's amounts include the fee, which moves the result by under one point of
 * progress (checked against 14 current cards). Absent without a launch record, a supply or a priced trade.
 */
export function curveState(threshold: number, supply: number, coinAmount: number, quoteAmount: number, usd: number): { curvePct: number; usd: number } | null {
  if (!(threshold > 0) || !(supply > 0) || !(coinAmount > 0) || !(quoteAmount > 0) || !(usd > 0)) return null;
  const virtual = 0.4 * threshold, reserve = Math.min(threshold, Math.max(0, Math.sqrt(virtual * supply * quoteAmount / coinAmount) - virtual));
  return { curvePct: 100 * reserve / threshold, usd: reserve * usd / quoteAmount };
}
/** `curveState` for Pons coins that have not graduated, by coin, from indexed rows only. */
export async function readCurveStates(db: ChainDb, coins: Address[]): Promise<Map<Address, { curvePct: number; usd: number }>> {
  const found = new Map<Address, { curvePct: number; usd: number }>();
  if (!coins.length) return found;
  const rows = (await db.sql.query<{ coin: Uint8Array; threshold: number | null; supply: number | null; coin_amount: number | null; quote_amount: number | null; usd: number | null }>(`
    SELECT t.address AS coin,coalesce(e.data->>'graduationThreshold',life.data->'curve'->>'launchThreshold')::numeric::float8 AS threshold,t.total_supply::float8 AS supply,
      s.amount_coin::float8 AS coin_amount,s.amount_quote::float8 AS quote_amount,s.usd
    FROM tokens t LEFT JOIN coin_lifetime life ON life.coin=t.address
    LEFT JOIN LATERAL (SELECT data FROM pons_events e WHERE e.token=t.address AND e.kind='launch' ORDER BY e.block,e.log_index LIMIT 1) e ON true
    JOIN LATERAL (${latestSwaps(1,'AND s.usd>0 AND s.amount_quote>0 AND s.amount_coin>0')}) s ON true
    WHERE t.address=ANY($1::bytea[]) AND t.launchpad='pons' AND t.graduated_block IS NULL AND t.total_supply>0`, [coins.map(binary)])).rows;
  for (const row of rows) {
    const state = curveState(Number(row.threshold), Number(row.supply), Number(row.coin_amount), Number(row.quote_amount), Number(row.usd));
    if (state) found.set(hex(row.coin) as Address, state);
  }
  return found;
}

/** Square root of the price at a tick (token1 per token0, base units). */
const sqrtAt = (tick: number) => Math.pow(1.0001, tick / 2);
/**
 * Base units of the quote currency a position holds at the pool's price, from its range and liquidity (Uniswap v3 and
 * v4 use the same formula). `sqrtPrice` is the square root of token1 per token0; `quoteIsToken1` says which side the
 * quote currency is on. Above its range a position holds only token1, below it only token0.
 */
export function positionQuote(liquidity: number, tickLower: number, tickUpper: number, sqrtPrice: number, quoteIsToken1: boolean): number {
  if (!(liquidity > 0) || !(tickUpper > tickLower) || !(sqrtPrice > 0)) return 0;
  const lower = sqrtAt(tickLower), upper = sqrtAt(tickUpper), at = Math.min(upper, Math.max(lower, sqrtPrice));
  return quoteIsToken1 ? liquidity * (at - lower) : liquidity * (1 / at - 1 / upper);
}
interface Position { lower: number; upper: number; liquidity: number }
interface PoolPositions { at: number; positions: Position[]; seen: boolean }
/**
 * Positions per pool come from incrementally maintained sums and are kept per database handle. They are used as
 * read for a minute. After that a request still gets them at once while they are read again behind it, one read at a
 * time, until they are three minutes old; older ones, and pools not seen before, are read before answering. Read
 * inline on every expiry, the Radar's first page paid for 119,283 events of 196 pools once a minute (0.6 s warm and
 * 11.7 s cold on a copy of 2026-10-13).
 */
const positionCache = new WeakMap<object, Map<string, PoolPositions>>();
const positionRefresh = new WeakMap<object, Promise<void>>();
const POSITIONS_TTL_MS = 60_000, POSITIONS_STALE_MS = 180_000;
async function loadPositions(db: ChainDb, cache: Map<string, PoolPositions>, ids: string[], now: number) {
  const read = new Map<string, PoolPositions>(ids.map(id => [id, { at: now, positions: [], seen: false }]));
  for (const row of (await db.sql.query<{ pool_id: Uint8Array; lower: number; upper: number; liquidity: number }>(`
    SELECT pool_id,lower,upper,sum(liquidity)::float8 AS liquidity FROM (
      SELECT e.pool_id,nullif(e.lower_tick,'')::int AS lower,nullif(e.upper_tick,'')::int AS upper,e.liquidity
      FROM read_pool_positions e WHERE e.pool_id=ANY($1::bytea[]) AND e.n>0
      UNION ALL
      SELECT p.id,(v.value->>'lower')::int,(v.value->>'upper')::int,(v.value->>'liquidity')::numeric FROM pools p
      JOIN LATERAL (SELECT l.data->'liquidity'->('0x'||encode(p.id,'hex'))->'moneyPositions' AS positions FROM coin_lifetime l
        WHERE l.coin IN(p.currency0,p.currency1) AND l.data->'liquidity' ? ('0x'||encode(p.id,'hex')) LIMIT 1) kept ON true
      CROSS JOIN LATERAL jsonb_each(coalesce(kept.positions,'{}')) v WHERE p.id=ANY($1::bytea[])
    ) combined GROUP BY 1,2,3`, [ids.map(binary)])).rows) { const entry = read.get(hex(row.pool_id))!; entry.seen = true; if (Number(row.liquidity) > 0) entry.positions.push({ lower: Number(row.lower), upper: Number(row.upper), liquidity: Number(row.liquidity) }); }
  for (const [id, entry] of read) cache.set(id, entry);
  // A long-lived process sees every pool on the Radar in time: old entries go first.
  if (cache.size > 5000) for (const key of [...cache.keys()].slice(0, cache.size - 4000)) cache.delete(key);
}
/**
 * USD of the quote currency (ETH, WETH or USDG) held in the pools of coins that never had a Pons curve, by coin: what
 * all sellers together could take out at this moment. Every position of each pool the coin traded in recently (its
 * latest 60 swaps) is valued at that pool's latest priced trade: a position holds quote currency only for the part of
 * its range below the price, so supply a launch placed above the price counts for nothing until it is bought. The
 * trade's amounts include the pool fee, which moves the result by about half the fee. Zero when every position has
 * been taken out. Absent for a coin with no priced trade or no liquidity event on record.
 */
export async function readPoolMoney(db: ChainDb, coins: Address[], now = Date.now(), fresh = false): Promise<Map<Address, number>> {
  const found = new Map<Address, number>();
  if (!coins.length) return found;
  const pools = (await db.sql.query<{ coin: Uint8Array; pool_id: Uint8Array; coin_first: boolean; coin_amount: number; quote_amount: number; usd: number }>(`
    SELECT t.address AS coin,r.pool_id,(p.currency0=t.address) AS coin_first,r.amount_coin::float8 AS coin_amount,r.amount_quote::float8 AS quote_amount,r.usd
    FROM tokens t CROSS JOIN LATERAL (SELECT DISTINCT ON (x.pool_id) x.pool_id,x.amount_coin,x.amount_quote,x.usd FROM (
        ${latestSwaps(60)}) x
      WHERE x.usd>0 AND x.amount_coin>0 AND x.amount_quote>0 ORDER BY x.pool_id,x.block DESC,x.log_index DESC,x.tx_hash DESC) r
    JOIN pools p ON p.id=r.pool_id
    WHERE t.address=ANY($1::bytea[]) AND t.curve IS NULL AND t.graduated_block IS NULL`, [coins.map(binary)])).rows;
  if (!pools.length) return found;
  const handle = db.sql as object;
  let cache = fresh ? new Map<string, PoolPositions>() : positionCache.get(handle);
  if (!cache) { cache = new Map(); positionCache.set(handle, cache); }
  const held = cache, ids = [...new Set(pools.map(row => hex(row.pool_id)))], age = (id: string) => { const hit = held.get(id); return hit ? now - hit.at : Infinity; };
  const due = ids.filter(id => age(id) >= POSITIONS_STALE_MS), aging = ids.filter(id => age(id) >= POSITIONS_TTL_MS && age(id) < POSITIONS_STALE_MS);
  if (due.length) await loadPositions(db, held, due, now);
  if (aging.length && !positionRefresh.has(handle)) {
    positionRefresh.set(handle, loadPositions(db, held, aging, now).catch(() => undefined).finally(() => { positionRefresh.delete(handle); }));
  }
  for (const row of pools) {
    const entry = cache.get(hex(row.pool_id)), positions = entry?.positions ?? [];
    // A pool with liquidity events and nothing left (all of it taken out) holds $0, which is said; a pool with no
    // liquidity event on record says nothing.
    if (!entry?.seen) continue;
    const coinAmount = Number(row.coin_amount), quoteAmount = Number(row.quote_amount), usd = Number(row.usd);
    // token1 per token0: quote per coin when the coin sorts first, coin per quote otherwise.
    const sqrtPrice = Math.sqrt(row.coin_first ? quoteAmount / coinAmount : coinAmount / quoteAmount);
    const quote = positions.reduce((sum, p) => sum + positionQuote(p.liquidity, p.lower, p.upper, sqrtPrice, row.coin_first), 0);
    const value = quote * usd / quoteAmount;
    if (Number.isFinite(value) && value >= 0) found.set(hex(row.coin) as Address, (found.get(hex(row.coin) as Address) ?? 0) + value);
  }
  return found;
}
