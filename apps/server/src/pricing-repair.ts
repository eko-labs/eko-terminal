import { withRpcOrigin, rpcPauseRetryAt } from '@eko/chain';
import { LoopHeartbeat } from './loop-health.js';
import { parseAbi, type PublicClient } from 'viem';
import { binary, hex, refreshBars, type ChainDb } from '@eko/db';
import { isTransientRpcUnavailable, loadRegistry, rpcStopReason } from '@eko/chain';

export interface RawMutationBound { through: string; ranges: { start_ts: string; end_ts: string }[] }
export type RawMutationBounds = Record<'swaps'|'liquidity_events',RawMutationBound>;
export async function rawMutationBounds(db: ChainDb): Promise<RawMutationBounds> {
  const bounds:RawMutationBounds={swaps:{through:'-1',ranges:[]},liquidity_events:{through:'-1',ranges:[]}};
  const rows=(await db.sql.query<{name:keyof RawMutationBounds;through:string;ranges:RawMutationBound['ranges']}>(`SELECT name,max(through_block)::text AS through,
      coalesce(jsonb_agg(jsonb_build_object('start_ts',start_ts,'end_ts',end_ts)) FILTER(WHERE start_ts IS NOT NULL),'[]') AS ranges
    FROM (SELECT name,through_block,NULL::timestamptz AS start_ts,NULL::timestamptz AS end_ts FROM raw_history_watermarks
      UNION ALL SELECT name,through_block,start_ts,end_ts FROM raw_history_seals WHERE NOT dropped) f
    WHERE name IN ('swaps','liquidity_events') GROUP BY name`)).rows;
  for(const row of rows)bounds[row.name]={through:row.through,ranges:row.ranges};
  return bounds;
}
export function liveRawRows(alias:string,bound:RawMutationBound,params:unknown[]) {
  params.push(bound.through,JSON.stringify(bound.ranges));
  // A pending seal fences its timestamp range before its through_block has been folded (2026-10-17).
  return `${alias}.block>$${params.length-1}::bigint AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($${params.length}::jsonb) AS f(start_ts timestamptz,end_ts timestamptz)
    WHERE ${alias}.ts>=f.start_ts AND ${alias}.ts<f.end_ts)`;
}
export const sealedRawMutation = (error:unknown) => /Mutation crosses (sealed|compacted) raw history/.test(String((error as Error)?.message));

export interface PricingAssets { weth: string; usdg: string; usdgDecimals: number }
const NATIVE = '0x0000000000000000000000000000000000000000';
/** Swaps priced per transaction. */
export const REPRICE_BATCH = 5000;
export const pricingAssets = (registry = loadRegistry()): PricingAssets => ({
  weth: registry.requireAddress('tokens.WETH'), usdg: registry.requireAddress('tokens.USDG'), usdgDecimals: registry.data.tokens.USDG.decimals ?? 6,
});

/**
 * Price the swaps the decoder left without USD, newest first within [from, to), and refresh their candles: those of
 * Pons coins and of coins with a launch wallet (Uniswap launches the worker onboarded, coin-onboarding.ts), or of `coins`.
 * Two causes on 2026-10-11 (694,000 of 1.96 million Pons swaps in seven days): USDG quotes had no USD conversion,
 * though USDG is the dollar the ETH/USD reference is quoted in, and curve swaps decoded before the coin's decimals
 * were known stayed pricing_pending. A coin with one unpriced swap never gets its wash and curve checks, so it could
 * never be rated Clear. ETH and WETH quotes use the reference rate the decoder uses: the latest swap on the recorded
 * reference pool at or before the swap's block. Swaps without a reference stay unpriced. Returns the number priced.
 */
export async function repricePonsSwaps(db: ChainDb, assets: PricingAssets, from: Date, to: Date, limit = REPRICE_BATCH, candleFloor = new Date(Date.now() - 2 * 86_400_000),
  coins?: Uint8Array[], bounds?: RawMutationBounds): Promise<number> {
  bounds ??= await rawMutationBounds(db);
  const params:unknown[]=[[NATIVE, assets.weth, assets.usdg].map(binary), binary(assets.weth), binary(assets.usdg), assets.usdgDecimals, from, to, limit, ...(coins ? [coins] : [])];
  const live=liveRawRows('s',bounds.swaps,params);
  return db.tx(async tx => {
    // The latest reference swap below the batch and those inside its block range are read once, and the latest rate is
    // carried forward in block order (a per-swap lookup over every swaps partition priced about 4,000 swaps a minute on
    // 2026-10-11, and a six-hour lookback window with a pool check per reference swap was slower still).
    // A Pons curve paired with a stock token or another Pons coin quotes in that token: its USD price is its own latest
    // priced swap within a day (only swaps with such a price are selected, so unpriceable ones cannot fill a batch).
    const rows = (await tx.sql.query<{ coin: Uint8Array; ts: Date }>(`WITH c AS MATERIALIZED (
        SELECT s.ts,s.tx_hash,s.log_index,s.block,s.amount_coin,s.amount_quote,t.decimals,s.quote_asset,
          CASE WHEN s.quote_asset=$3 THEN 'dollar' WHEN s.quote_asset=ANY($1::bytea[]) THEN 'eth' ELSE 'token' END AS kind,
          CASE WHEN s.quote_asset=$3 THEN $4 WHEN s.quote_asset=ANY($1::bytea[]) THEN 18 ELSE q.decimals END AS qdec
        FROM swaps s JOIN tokens t ON t.address=s.coin LEFT JOIN tokens q ON q.address=s.quote_asset
        WHERE ${live} AND s.ts>=$5 AND s.ts<$6 AND s.usd IS NULL AND ${coins ? 's.coin=ANY($8::bytea[])' : "(t.launchpad='pons' OR t.deployer IS NOT NULL)"} AND t.decimals IS NOT NULL AND s.amount_coin>0 AND s.amount_quote>0
          AND (s.quote_asset=ANY($1::bytea[]) OR (q.decimals IS NOT NULL AND EXISTS(SELECT 1 FROM swaps x WHERE x.coin=s.quote_asset AND x.block<=s.block
            AND x.ts>=s.ts-interval '1 day' AND x.usd>0 AND x.amount_coin>0)))
        ORDER BY s.ts DESC LIMIT $7),
      span AS (SELECT min(block) AS lo,max(block) AS hi FROM c WHERE kind='eth'),
      -- The reference pool(s) on record (one in production); the latest reference swap below the batch, then those inside it.
      ref_pools AS (SELECT DISTINCT pool_id FROM eth_usd_reference_sources),
      -- The latest one is read per pool, backward through swaps(pool_id,block). As pool_id IN (...) the planner read every
      -- reference swap below the batch and sorted them: 1.34 million rows and 4.5 s per statement on 2026-10-13 (11 ms this way).
      ref AS (SELECT x.block,x.log_index,x.price_quote FROM span CROSS JOIN LATERAL (SELECT y.block,y.log_index,y.price_quote FROM ref_pools rp
          CROSS JOIN LATERAL (SELECT z.block,z.log_index,z.price_quote FROM ((SELECT x.block,x.log_index,x.price_quote FROM swaps x
            WHERE x.pool_id=rp.pool_id AND x.coin=$2 AND x.quote_asset=$3 AND x.block<span.lo
              AND x.price_quote>0 AND x.price_quote<'Infinity'::double precision ORDER BY x.block DESC,x.log_index DESC LIMIT 1)
            UNION ALL SELECT b.block,b.log_index,b.price_quote FROM reference_price_baselines b WHERE b.pool_id=rp.pool_id AND b.coin=$2 AND b.quote_asset=$3 AND b.block<span.lo
            ) z ORDER BY z.block DESC,z.log_index DESC LIMIT 1) y
          ORDER BY y.block DESC,y.log_index DESC LIMIT 1) x
        UNION ALL SELECT x.block,x.log_index,x.price_quote FROM swaps x,span
          WHERE x.pool_id IN (SELECT pool_id FROM ref_pools) AND x.coin=$2 AND x.quote_asset=$3 AND x.block BETWEEN span.lo AND span.hi
            AND x.ts>=$5::timestamptz-interval '1 hour' AND x.ts<$6 AND x.price_quote>0 AND x.price_quote<'Infinity'::double precision),
      -- An ETH-quoted swap carries its own amounts through the rate walk, so the rated swaps are read straight from it.
      -- Joined back to the batch by key, the update re-read the whole walk once per swap: 999,000 rows discarded and
      -- 16.3 s for a batch of 1,000 in a busy hour on a copy of 2026-10-13 (0.9 s this way, the same 1,000 prices).
      seq AS (SELECT block,log_index,price_quote AS rate,block AS rate_block,NULL::timestamptz AS ts,NULL::bytea AS tx_hash,NULL::integer AS idx,
          NULL::numeric AS amount_coin,NULL::numeric AS amount_quote,NULL::integer AS decimals,NULL::integer AS qdec FROM ref
        UNION ALL SELECT block,2147483647,NULL,NULL,ts,tx_hash,log_index,amount_coin,amount_quote,decimals,qdec FROM c WHERE kind='eth'),
      carried AS (SELECT ts,tx_hash,idx,amount_coin,amount_quote,decimals,qdec,count(rate) OVER w AS grp,rate,rate_block FROM seq WINDOW w AS (ORDER BY block,log_index)),
      filled AS (SELECT ts,tx_hash,idx,amount_coin,amount_quote,decimals,qdec,first_value(rate) OVER g AS rate,first_value(rate_block) OVER g AS rate_block
        FROM carried WINDOW g AS (PARTITION BY grp ORDER BY rate NULLS LAST)),
      r AS (SELECT f.ts,f.tx_hash,f.idx AS log_index,f.amount_coin,f.decimals,f.rate,f.rate_block,f.amount_quote::double precision/10^f.qdec AS quote FROM filled f WHERE f.ts IS NOT NULL
        UNION ALL SELECT c.ts,c.tx_hash,c.log_index,c.amount_coin,c.decimals,1::double precision,c.block,c.amount_quote::double precision/10^c.qdec FROM c WHERE c.kind='dollar'
        UNION ALL SELECT c.ts,c.tx_hash,c.log_index,c.amount_coin,c.decimals,k.price,k.block,c.amount_quote::double precision/10^c.qdec FROM c CROSS JOIN LATERAL (
          SELECT x.usd/(x.amount_coin::double precision/10^c.qdec) AS price,x.block FROM swaps x
          WHERE x.coin=c.quote_asset AND x.block<=c.block AND x.ts>=c.ts-interval '1 day' AND x.usd>0 AND x.amount_coin>0
          ORDER BY x.block DESC,x.log_index DESC LIMIT 1) k WHERE c.kind='token')
      UPDATE swaps s SET usd=r.quote*r.rate,price_quote=coalesce(s.price_quote,r.quote/(r.amount_coin::double precision/10^r.decimals)),
        pricing_pending=false,priced_block=r.rate_block
      FROM r WHERE ${live} AND s.ts=r.ts AND s.tx_hash=r.tx_hash AND s.log_index=r.log_index AND r.rate IS NOT NULL
      RETURNING s.coin,s.ts`, params)).rows;
    // Candles feed the radar's hour and day volume. Rebuilding every touched minute took as long as pricing on
    // 2026-10-11, so minutes older than two days keep their candles (as before the repair); the raw swaps carry the USD.
    const recent = rows.filter(row => new Date(row.ts).getTime() >= candleFloor.getTime());
    if (recent.length) await refreshBars(tx, recent.map(row => ({ coin: row.coin, minute: new Date(Math.floor(new Date(row.ts).getTime() / 60000) * 60000) })));
    return rows.length;
  });
}

/**
 * Re-tag up to `limit` Pons curve swaps of a non-native pair that were recorded as ETH quotes (every curve trade was,
 * before the decoder read the launch's pair token): quote_asset becomes the pair token and the derived price and USD are
 * cleared, so repricePonsSwaps prices them in the right asset. Returns the number re-tagged.
 */
export async function retagPairQuotes(db: ChainDb, limit = REPRICE_BATCH, bounds?:RawMutationBounds): Promise<number> {
  bounds ??= await rawMutationBounds(db);
  const params:unknown[]=[NATIVE, binary(NATIVE), limit],live=liveRawRows('s',bounds.swaps,params);
  return (await db.sql.query(`WITH pairs AS (SELECT DISTINCT ON (e.token) e.token,decode(substr(lower(e.data->>'curve'),3),'hex') AS curve,
        decode(substr(lower(e.data->>'pairToken'),3),'hex') AS pair FROM pons_events e
        WHERE e.kind='launch' AND e.data ? 'pairToken' AND e.data ? 'curve' AND lower(e.data->>'pairToken')<>$1 ORDER BY e.token,e.block),
      bad AS (SELECT s.ts,s.tx_hash,s.log_index,p.pair FROM swaps s JOIN pairs p ON p.token=s.coin AND p.curve=s.pool_id
        WHERE ${live} AND s.venue='pons_curve' AND s.quote_asset=$2 LIMIT $3)
    UPDATE swaps s SET quote_asset=bad.pair,usd=NULL,price_quote=NULL,priced_block=NULL,pricing_pending=false
    FROM bad WHERE ${live} AND s.ts=bad.ts AND s.tx_hash=bad.tx_hash AND s.log_index=bad.log_index RETURNING 1`, params)).rows.length;
}

/** The tokens Pons curves are quoted in, other than native ETH (USDG, stock tokens, other coins). */
export async function pairTokens(db: ChainDb): Promise<Uint8Array[]> {
  return (await db.sql.query<{ token: Uint8Array }>(`SELECT DISTINCT decode(substr(lower(data->>'pairToken'),3),'hex') AS token FROM pons_events
    WHERE kind='launch' AND data ? 'pairToken' AND lower(data->>'pairToken') ~ '^0x[0-9a-f]{40}$' AND lower(data->>'pairToken')<>$1`, [NATIVE])).rows.map(row => row.token);
}
/** A token's ERC-20 metadata read from the chain, any field null when unreadable. */
export type TokenMetaReader = (token: string) => Promise<{ decimals: number | null; symbol: string | null; name: string | null }>;
const erc20Metadata = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)']);
/** Reads token metadata at the latest block through the metered client; an unreadable field is null, stops and transient failures propagate. */
export function chainTokenMeta(client: () => PublicClient): TokenMetaReader {
  return async token => {
    const field = async <T,>(functionName: 'decimals' | 'symbol' | 'name'): Promise<T | null> => {
      try { return await withRpcOrigin('server.pricing_repair.L134',()=>client().readContract({ address: token as `0x${string}`, abi: erc20Metadata, functionName })) as T; }
      catch (error) { if (rpcStopReason(error) || isTransientRpcUnavailable(error)) throw error; return null; }
    };
    const reader=client();
    if(reader.multicall) {
      try {
        const values=await withRpcOrigin('worker.pricing_metadata.batch',()=>reader.multicall({allowFailure:true,contracts: (['decimals','symbol','name'] as const).map(functionName=>({
          address:token as `0x${string}`,abi:erc20Metadata,functionName}))}));
        const value=(i:number)=>values[i].status==='success' ? values[i].result : null;
        return {decimals:value(0) as number|null,symbol:value(1) as string|null,name:value(2) as string|null};
      } catch(error) {if(rpcStopReason(error) || isTransientRpcUnavailable(error))throw error;return {decimals:null,symbol:null,name:null};}
    }
    return { decimals: await field<number>('decimals'), symbol: await field<string>('symbol'), name: await field<string>('name') };
  };
}
/**
 * Fill the metadata of pair tokens that have none (fields stay as stored where present). The indexer reads a pair
 * token's metadata when its curve trades; a quiet curve's never was (38 of 65 had no decimals on 2026-10-12), so its
 * swaps could not be priced. Returns the tokens given decimals.
 */
export async function repairPairMetadata(db: ChainDb, read: TokenMetaReader, pairs: Uint8Array[]): Promise<number> {
  const missing = (await db.sql.query<{ address: Uint8Array }>('SELECT address FROM tokens WHERE address=ANY($1::bytea[]) AND decimals IS NULL', [pairs])).rows;
  let filled = 0;
  for (const { address } of missing) {
    const meta = await read(hex(address));
    if (meta.decimals == null || !Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 36) continue;
    filled += (await db.sql.query('UPDATE tokens SET decimals=coalesce(decimals,$2),symbol=coalesce(symbol,$3),name=coalesce(name,$4) WHERE address=$1 RETURNING 1',
      [address, meta.decimals, meta.symbol, meta.name])).rows.length;
  }
  return filled;
}

/**
 * Rebuild candles in a transaction of their own. The coins' read-model rows are marked first, in coin order: the candle
 * write marks them anyway (its trigger), and taking them only once the candle table's lock was held deadlocked with
 * writers that hold such a row from a swap write and then ask for that lock, the indexer above all (18 deadlocks on
 * 2026-10-13 by 10:45Z, 14 of them in the two hours coins with long histories were being onboarded).
 */
export async function rebuildCandles(db: ChainDb, keys: { coin: Uint8Array; minute: Date }[]) {
  if (!keys.length) return;
  const coins = [...new Map(keys.map(key => [hex(key.coin), key.coin])).entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([, coin]) => coin);
  await db.tx(async tx => {
    await tx.sql.query('INSERT INTO read_dirty(coin) SELECT c FROM unnest($1::bytea[]) AS c ORDER BY c ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision', [coins]);
    await refreshBars(tx, keys);
  });
}

/** A token's USD price at a block, or null when it has none (the worker reads Uniswap v3 USDG pools). */
export type TokenSpot = (token: string, decimals: number, block: bigint) => Promise<number | null>;
/**
 * Price Pons swaps in [from, to) quoted in a token with no indexed USD price within a day: Robinhood stock tokens trade
 * in Uniswap v3 pools against USDG that are not indexed, so their curves' swaps (and every check needing all of a
 * coin's swaps priced) stayed unpriced. Each token and hour is priced once, at the spot price at the hour's first such
 * swap (`prices` keeps the readings across passes); a token without a price stays unpriced. Returns swaps priced and
 * prices read.
 */
export async function repricePoolQuotes(db: ChainDb, assets: PricingAssets, spot: TokenSpot, from: Date, to: Date, prices: Map<string, number | null> = new Map(),
  candleFloor = new Date(Date.now() - 2 * 86_400_000), bounds?:RawMutationBounds): Promise<{ priced: number; reads: number }> {
  bounds ??= await rawMutationBounds(db);
  const unpriceable = `s.usd IS NULL AND (t.launchpad='pons' OR t.deployer IS NOT NULL) AND t.decimals IS NOT NULL AND q.decimals IS NOT NULL AND s.amount_coin>0 AND s.amount_quote>0
    AND NOT s.quote_asset=ANY($3::bytea[]) AND NOT EXISTS(SELECT 1 FROM swaps x WHERE x.coin=s.quote_asset AND x.block<=s.block
      AND x.ts>=s.ts-interval '1 day' AND x.usd>0 AND x.amount_coin>0)`;
  const quotes = [NATIVE, assets.weth, assets.usdg].map(binary);
  const groupParams:unknown[]=[from,to,quotes],groupLive=liveRawRows('s',bounds.swaps,groupParams);
  const groups = (await db.sql.query<{ quote: Uint8Array; decimals: number; hour: Date; block: string }>(`SELECT s.quote_asset AS quote,q.decimals,date_trunc('hour',s.ts) AS hour,min(s.block)::text AS block
    FROM swaps s JOIN tokens t ON t.address=s.coin JOIN tokens q ON q.address=s.quote_asset WHERE ${groupLive} AND s.ts>=$1 AND s.ts<$2 AND ${unpriceable} GROUP BY 1,2,3`, groupParams)).rows;
  let priced = 0, reads = 0;
  for (const g of groups) {
    const token = hex(g.quote), hour = new Date(g.hour), key = `${token}:${hour.toISOString()}`;
    if (!prices.has(key)) { reads++; prices.set(key, await spot(token, Number(g.decimals), BigInt(g.block))); }
    const price = prices.get(key);
    if (price == null || !(price > 0)) continue;
    const params:unknown[]=[from, to, quotes, g.quote, hour, price, g.block],live=liveRawRows('s',bounds.swaps,params);
    const rows = (await db.tx(tx => tx.sql.query<{ coin: Uint8Array; ts: Date }>(`UPDATE swaps s SET usd=(s.amount_quote::double precision/10^q.decimals)*$6,
        price_quote=coalesce(s.price_quote,(s.amount_quote::double precision/10^q.decimals)/(s.amount_coin::double precision/10^t.decimals)),pricing_pending=false,priced_block=$7
      FROM tokens t,tokens q WHERE t.address=s.coin AND q.address=s.quote_asset AND s.quote_asset=$4 AND s.ts>=greatest($1,$5::timestamptz) AND s.ts<least($2,$5::timestamptz+interval '1 hour')
        AND ${live} AND ${unpriceable} RETURNING s.coin,s.ts`, params))).rows;
    priced += rows.length;
    const recent = rows.filter(row => new Date(row.ts).getTime() >= candleFloor.getTime());
    await rebuildCandles(db, recent.map(row => ({ coin: row.coin, minute: new Date(Math.floor(new Date(row.ts).getTime() / 60000) * 60000) })));
  }
  return { priced, reads };
}

const HOUR = 3_600_000;
/**
 * Worker role: every 30 s, price the newest six hours of Pons swaps, then walk an in-memory cursor back one hour at a
 * time through the last eight days within a 28 s budget per pass. A restart walks the history again; hours already
 * priced cost one indexed range read each.
 */
export class PricingRepairWorker {
  readonly heartbeat: LoopHeartbeat;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private rpcRetryAt = 0;
  private cursor?: number;
  /** The process re-tagged every mispaired curve swap it found (new ones are decoded with their pair). */
  private retagged = false;
  /** Pool prices read per token and hour (repricePoolQuotes), kept for the process. */
  private spotPrices = new Map<string, number | null>();
  /** The process priced pair tokens' own swaps over the backfill window (after filling their metadata). */
  private pairsPriced = false;
  /** Pair tokens (read once per process) and the hour their oldest-first pricing walk has reached. */
  private pairs?: Uint8Array[];
  private pairCursor?: number;
  constructor(private readonly db: ChainDb, private readonly log: (event: string, fields: Record<string, unknown>) => void,
    private readonly now = () => Date.now(), private readonly intervalMs = 30_000, private readonly budgetMs = 28_000, private assets?: PricingAssets, private readonly batch = REPRICE_BATCH,
    private readonly spot?: TokenSpot, private readonly meta?: TokenMetaReader) { this.heartbeat = new LoopHeartbeat(intervalMs, now); }
  start() { if (this.timer) return; this.heartbeat.start(); void this.tick(); this.timer = setInterval(() => void this.tick(), this.intervalMs); this.timer.unref(); }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.running; }
  tick(): Promise<void> {
    if (this.running) return this.running;
    if (this.now()<this.rpcRetryAt) return Promise.resolve();
    this.running = this.pass().then(() => this.heartbeat.complete()).catch(error => { const retryAt=rpcPauseRetryAt(error); if(retryAt!==undefined){this.rpcRetryAt=retryAt;return;} this.log('pricing_repair_failed', {}); }).finally(() => { this.running = undefined; });
    return this.running;
  }
  /** Price one hour until done (`done`) or out of budget, so an unfinished hour is resumed rather than skipped. */
  private async hour(end: number, deadline: number, candleFloor: Date, bounds:RawMutationBounds) {
    let priced = 0;
    for (;;) {
      const n = await repricePonsSwaps(this.db, this.assets ??= pricingAssets(), new Date(end - HOUR), new Date(end), this.batch, candleFloor, undefined, bounds);
      priced += n;
      if (n < this.batch) break;
      if (this.now() >= deadline) return { priced, done: false };
    }
    // Then what has no indexed price: a provider failure leaves the hour for the next pass.
    if (this.spot) try { priced += (await repricePoolQuotes(this.db, this.assets!, this.spot, new Date(end - HOUR), new Date(end), this.spotPrices, candleFloor, bounds)).priced; }
    catch (error) { if(rpcPauseRetryAt(error)!==undefined)throw error; return { priced, done: false }; }
    return { priced, done: true };
  }
  private async pass() {
    const started = this.now(), deadline = started + this.budgetMs, top = Math.ceil(started / HOUR) * HOUR, candleFloor = new Date(started - 2 * 24 * HOUR);
    const bounds=await rawMutationBounds(this.db);
    let recent = 0, backfilled = 0, retagged = 0, pairs = 0;
    while (!this.retagged && this.now() < deadline) { const n = await retagPairQuotes(this.db, this.batch, bounds); retagged += n; if (n < this.batch) this.retagged = true; }
    // A token-quoted Pons swap is priced from its pair token's own priced swaps within the day before it, and the
    // backfill walks hours newest first, so the pair tokens' swaps over the window are priced first, an hour at a time
    // oldest first (one query over the whole window took ten minutes for 5,000 swaps on 2026-10-12).
    if (!this.pairsPriced && this.now() < deadline) {
      if (!this.pairs) { this.pairs = await pairTokens(this.db); if (this.meta) await repairPairMetadata(this.db, this.meta, this.pairs); }
      this.pairCursor ??= top - 8 * 24 * HOUR;
      while (this.pairCursor < top && this.now() < deadline) {
        const n = await repricePonsSwaps(this.db, this.assets ??= pricingAssets(), new Date(this.pairCursor), new Date(this.pairCursor + HOUR), this.batch, candleFloor, this.pairs, bounds);
        pairs += n;
        if (n < this.batch) this.pairCursor += HOUR;
      }
      if (this.pairCursor >= top) this.pairsPriced = true;
    }
    for (let end = top; end > top - 6 * HOUR && this.now() < deadline; end -= HOUR) recent += (await this.hour(end, deadline, candleFloor, bounds)).priced;
    this.cursor ??= top - 6 * HOUR;
    while (this.cursor > top - 8 * 24 * HOUR && this.now() < deadline) {
      const hour = await this.hour(this.cursor, deadline, candleFloor, bounds);
      backfilled += hour.priced;
      if (hour.done) this.cursor -= HOUR;
    }
    if (recent || backfilled || retagged || pairs) this.log('pricing_repair', { recent, backfilled, retagged, pairs, cursor: new Date(this.cursor).toISOString(), ms: this.now() - started });
  }
}
