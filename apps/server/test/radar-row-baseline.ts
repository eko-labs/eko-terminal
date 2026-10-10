/** Row reader before 0223, retained for byte equivalence and offline EXPLAIN ANALYZE. */
import { ReadStore } from '../src/read/store.js';
import { BlueChipReader } from '../src/read/blue-chip.js';
import { binary, hex, readFlows, readRatingPrices, liveRating, unavailableFlow, type ChainDb } from '@eko/db';
import { readSellChecks, type SellCheckReading } from '@eko/engines';
import { limitRefresh, refreshTimedOut } from '../src/read/refresh-limits.js';
import { LIQUIDITY_PROBE_KEYS, prepareLiquidityModels, writeLiquidityModels } from '../src/read/liquidity-model.js';
import { CoinCardSchema, VerdictSchema, findingsFirst, isHardDanger, type Address, type CoinCard, type RadarRow, type Verdict } from '@eko/shared';
import { toUntrusted } from '@eko/untrusted';
import { reportError } from '../src/obs/errors.js';
interface Stored {
  liquidity_usd:number|null;liquidity_unavailable:boolean|null;curve_pct:number|null;
  buyers_pending:boolean;pricing_pending:boolean;eligible:boolean;address: Uint8Array; name: string | null; symbol: string | null; launchpad: string | null;
  curve: Uint8Array | null; graduated_block: string | null; total_supply: string | null; decimals: number | null;
  first_block:string; created_at: Date | null; activity: Date | null; data: unknown | null; verdict: unknown | null;
  price: number | null; previous1h: number | null; previous24h: number | null; volume: number; spark: number[] | null;
  trades: string | number; prior_volume: number; first_minute: Date | null;
}
function activity(t: Pick<Stored, 'volume' | 'trades' | 'prior_volume' | 'first_minute'>, now: number) {
  const start = Math.max(now - 86400, t.first_minute ? new Date(t.first_minute).getTime() / 1000 : now), hours = (now - 3600 - start) / 3600;
  return { volume1hUsd: Number(t.volume), trades1h: Number(t.trades), ...(hours >= 1 ? { volumeBaselineUsd: Number(t.prior_volume) / hours } : {}) };
}
import { withSellCheck, type ReadRow } from '../src/read/store.js';
export class BaselineRows extends ReadStore {
  override async rows(address?: Address, addresses?: Address[]): Promise<ReadRow[]> {
    await this.currentModels();
    const now = this.now() / 1000;
    const params:unknown[]=[now];
    const bounded=address ? [address] : addresses;
    const filter=bounded ? 't.address=ANY($2::bytea[])' : 'r.coin IS NOT NULL';
    if(bounded)params.push(bounded.map(binary));
    // Candidate ordering is owned by read_coins. Keep payloads out of the multi-use CTE and
    // aggregate bars through indexed per-coin ranges, keeping sorts and intermediate rows bounded.
    const result = await this.db.sql.query<Stored>(`WITH selected AS (
      SELECT t.*,l.usd AS liquidity_usd,l.unavailable AS liquidity_unavailable,l.curve_pct,r.activity,coalesce(r.buyers_pending,false) AS buyers_pending,coalesce(r.pricing_pending,false) AS pricing_pending,(r.coin IS NOT NULL) AS eligible FROM ${bounded ? 'unnest($2::bytea[]) k(coin) CROSS JOIN LATERAL (SELECT * FROM tokens WHERE address=k.coin OFFSET 0) t' : 'tokens t'}
      LEFT JOIN read_coins r ON r.coin=t.address ${bounded ? 'AND r.coin=ANY($2::bytea[])' : ''} LEFT JOIN read_coin_liquidity l ON l.coin=t.address ${bounded ? 'AND l.coin=ANY($2::bytea[])' : ''} WHERE ${filter}
    ), market AS (
      SELECT t.address AS coin,last.close AS price,hour.close AS previous1h,day.close AS previous24h,first.minute AS first_minute,
        coalesce(v.volume,0) AS volume,coalesce(v.trades,0) AS trades,coalesce(v.prior_volume,0) AS prior_volume
      FROM selected t
      LEFT JOIN LATERAL (SELECT close FROM bars_1m WHERE coin=t.address ORDER BY minute DESC LIMIT 1) last ON true
      LEFT JOIN LATERAL (SELECT close FROM bars_1m WHERE coin=t.address AND minute<=to_timestamp($1::double precision-3600) ORDER BY minute DESC LIMIT 1) hour ON true
      LEFT JOIN LATERAL (SELECT close FROM bars_1m WHERE coin=t.address AND minute<=to_timestamp($1::double precision-86400) ORDER BY minute DESC LIMIT 1) day ON true
      LEFT JOIN LATERAL (SELECT minute FROM bars_1m WHERE coin=t.address ORDER BY minute LIMIT 1) first ON true
      LEFT JOIN LATERAL (SELECT sum(volume_usd) FILTER(WHERE minute>=to_timestamp($1::double precision-3600)) AS volume,
        sum(trades) FILTER(WHERE minute>=to_timestamp($1::double precision-3600)) AS trades,
        sum(volume_usd) FILTER(WHERE minute<to_timestamp($1::double precision-3600)) AS prior_volume FROM bars_1m
        WHERE coin=t.address AND minute>=to_timestamp($1::double precision-86400)) v ON true
    ), span AS MATERIALIZED (
      -- One indexed first-minute probe and bucket-width calculation per page coin.
      SELECT t.address AS coin,b.minute AS first,
        60*greatest(1,ceil(extract(epoch FROM to_timestamp($1::double precision)-b.minute)/5760.0)) AS width
      FROM selected t CROSS JOIN LATERAL (SELECT minute FROM bars_1m WHERE coin=t.address
        AND minute>=to_timestamp($1::double precision-28800) AND minute<=to_timestamp($1::double precision)
        ORDER BY minute LIMIT 1) b
    ), buckets AS (
      -- Sort at most eight hours of one coin at a time, instead of spilling the entire page's bar window.
      -- The last close of each bucket preserves the series and its original first-minute anchor.
      SELECT s.coin,b.bucket,b.close FROM span s CROSS JOIN LATERAL (
        SELECT DISTINCT ON (bucket) floor(extract(epoch FROM b.minute-s.first)/s.width) AS bucket,b.close
        FROM bars_1m b WHERE b.coin=s.coin
          AND b.minute>=to_timestamp($1::double precision-28800) AND b.minute<=to_timestamp($1::double precision)
        ORDER BY bucket,b.minute DESC) b
    ), sparks AS (SELECT coin,array_agg(close ORDER BY bucket) AS points FROM buckets GROUP BY coin)
    SELECT t.*,c.data,c.data->'verdict' AS verdict,coalesce(bt.ts,cb.ts) AS created_at,
      b.price,b.previous1h,b.previous24h,coalesce(b.volume,0) AS volume,coalesce(b.trades,0) AS trades,coalesce(b.prior_volume,0) AS prior_volume,b.first_minute,s.points AS spark
    FROM selected t LEFT JOIN LATERAL (SELECT data FROM coin_card_latest WHERE coin=t.address OFFSET 0) c ON true
    LEFT JOIN market b ON b.coin=t.address LEFT JOIN sparks s ON s.coin=t.address
    LEFT JOIN LATERAL (SELECT ts FROM engine_block_times WHERE number=t.first_block OFFSET 0) bt ON true
    LEFT JOIN LATERAL (SELECT ts FROM chain_blocks WHERE number=t.first_block OFFSET 0) cb ON true`,params);
    const readAddresses=result.rows.map(t=>hex(t.address));
    const [prices,flows,sells]=await Promise.all([
      readRatingPrices(this.db,readAddresses),readFlows(this.db,readAddresses),readSellChecks(this.db,readAddresses,this.now()),
    ]);
    // A coin with only a few minutes of bars gets its series from its trades instead (the latest 96 priced ones), so a
    // launch shows a line from its second trade on.
    const thin=result.rows.filter(t=>!t.pricing_pending && (t.spark?.length ?? 0)<6).map(t=>t.address);
    const trades=new Map<string,number[]>();
    if(thin.length)for(const row of (await this.db.sql.query<{coin:Uint8Array;points:number[]}>(`SELECT t.address AS coin,array_agg(s.usd/(s.amount_coin::double precision/power(10,coalesce(t.decimals,18))) ORDER BY s.block,s.log_index) AS points
      FROM tokens t CROSS JOIN LATERAL (WITH candidates AS MATERIALIZED (SELECT block,log_index,usd,amount_coin FROM swaps s
        WHERE s.coin=t.address AND s.ts>to_timestamp($2::double precision-28800) AND s.ts<=to_timestamp($2::double precision)
          AND s.usd>0 AND s.amount_coin>0) SELECT * FROM candidates ORDER BY block DESC,log_index DESC LIMIT 96) s
      WHERE t.address=ANY($1::bytea[]) GROUP BY t.address,t.decimals`,[thin,now])).rows)trades.set(hex(row.coin),row.points.map(Number));
    const memberships = await this.blueChip?.members(result.rows.map(t=>hex(t.address)));
    return result.rows.map(t => {
      const sell=sells.get(hex(t.address)),traded=trades.get(hex(t.address));
      const spark=traded && traded.length>(t.spark?.length ?? 0) ? traded : t.spark;
      const card = t.data ? withSellCheck(CoinCardSchema.parse(t.data),sell) : null;
      const verdict = t.verdict ? liveRating(VerdictSchema.parse(t.verdict),prices.get(hex(t.address))) : null;
      if(card && verdict) {card.verdict=verdict;if(verdict.lastChecked)card.freshness.ageSec=Math.max(0,Math.floor(now-Date.parse(verdict.lastChecked.at)/1000));}
      const flow=flows.get(hex(t.address))??unavailableFlow('1h');
      const {meta:flowMeta,...flowValues}=flow;
      if(card){card.flow=flowValues;card.meta={...card.meta,flow:flowMeta};}
      // CA-35: exit cost at $1K is a measurement only when the sell check measured that size.
      const unavailable: NonNullable<RadarRow['unavailable']> = sell?.exit1k==null ? ['exitCost'] : [];
      if(flow.meta?.unavailable)unavailable.push('flow');
      // Depth is structural in current engine cards, even when LP ownership is known. A graduated coin's row shows its
      // pool's value (both sides of the graduation position) instead, read from indexed events.
      if (t.liquidity_unavailable ?? true) unavailable.push('liquidity');
      if (!card?.signal) unavailable.push('signal');
      if(t.buyers_pending)unavailable.push('buyers');
      if(t.pricing_pending)unavailable.push('volume','spark');
      if (t.pricing_pending || !t.previous1h || t.price == null) unavailable.push('change');
      const supply = t.total_supply != null && t.decimals != null ? Number(t.total_supply) / 10 ** t.decimals : null;
      if (t.pricing_pending || supply == null || t.price == null) unavailable.push('marketCap');
      // TODO(spec): CoinSummary requires priceUsd even before the first priced swap; priceUnavailable masks it.
      // TODO(spec): CA-31 circulating supply is not indexed; cap uses observed total supply, as market.ts does.
      const row: RadarRow = {
        address: hex(t.address), name: toUntrusted(t.name ?? '',120), symbol: toUntrusted(t.symbol ?? '',32),
        launchpad: t.launchpad === 'pons' ? 'pons' : 'other',
        // A Pons coin is on its curve until its graduation is indexed. Its token row exists a moment before its curve
        // address does; reading that gap as graduated sent brand-new launches to Migrated and tagged them "Pons → pool".
        stage: t.graduated_block != null ? 'graduated' : card?.identity.stage ?? (t.curve || t.launchpad === 'pons' ? 'curve' : 'graduated'),
        curvePct: t.curve_pct ?? card?.identity.curvePct, priceUsd: t.pricing_pending ? 0 : t.price ?? 0, priceUnavailable: t.pricing_pending || t.price == null,
        change1hPct: !t.pricing_pending && t.price != null && t.previous1h ? 100 * (t.price/t.previous1h-1) : 0,
        change24hPct: !t.pricing_pending && t.price != null && t.previous24h ? 100 * (t.price/t.previous24h-1) : undefined,
        liquidityUsd: t.liquidity_usd ?? 0,
        marketCapUsd: !t.pricing_pending && supply != null && t.price != null ? t.price*supply : undefined,
        verdict: verdict?.level ?? 'pending', verdictPending: !verdict,
        lastChecked:verdict?.lastChecked, priceMove:verdict?.priceMove,
        ratingAgeSec:verdict?.lastChecked ? Math.max(0,Math.floor(now-Date.parse(verdict.lastChecked.at)/1000)) : undefined,
        ...(verdict?.playbooks.some(m => m.level === 'danger' && isHardDanger(m.id)) ? { hardDanger: true } : {}),
        evaluatedPlaybooks: verdict?.evaluatedPlaybooks,
        missingChecks: [...new Set(Object.values(card?.meta ?? {}).flatMap(m => m.missing ?? []))],
        topPlaybook: verdict ? findingsFirst(verdict.playbooks)[0]?.id : undefined, ageSec: Math.max(0,now-(t.created_at ? new Date(t.created_at).getTime()/1000 : now)),
        flow:flowValues, exitCost1kPct:sell?.exit1k ?? 0,
        ...(sell ? {sellCheck:{status:sell.status,asOfBlock:sell.block,checkedAt:sell.checkedAt.toISOString()}} : {}),
        rank:0, signal:card?.signal, spark8h:t.pricing_pending ? undefined : spark ?? [], beta:verdict?.beta, unavailable,
        ...(t.pricing_pending ? {} : activity(t, now)),
      };
      const member = memberships?.get(row.address);
      if(member) { row.blueChip=member; if(card) { card.blueChip=member;card.blueChipCriteria=this.blueChip!.criteria; } }
      return { eligible:t.eligible,row,card,volume:t.pricing_pending ? 0 : t.volume,firstBlock:Number(t.first_block),graduationBlock:Number(t.graduated_block ?? 0),activity:t.activity ? new Date(t.activity).getTime() : this.now(),exit100:sell?.exit100 ?? null };
    });
  }
}
