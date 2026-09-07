import { ratingPriceMove, type Address, type Verdict } from '@eko/shared';
import type { ChainDb } from './client.js';
import { binary, hex } from './types.js';

export interface RatingPrices {
  coin: Uint8Array; price: number | null; peak: number | null; full_price: number | null;
  peak_recorded: boolean | null; checked_block: string | null; checked_at: Date | null;
}
/** A small per-coin join, with no receipt or card payload reads. Facts update as soon as a priced swap commits. */
export async function readRatingPrices(db: ChainDb, coins: readonly Address[]): Promise<Map<Address, RatingPrices>> {
  if (!coins.length) return new Map();
  const rows = (await db.sql.query<RatingPrices>(`SELECT a.coin,p.price,p.peak,c.full_price,c.peak_recorded,c.checked_block,c.checked_at
    FROM unnest($1::bytea[]) a(coin) LEFT JOIN coin_rating_prices p ON p.coin=a.coin LEFT JOIN coin_rating_checks c ON c.coin=a.coin`,[coins.map(binary)])).rows;
  return new Map(rows.map(r=>[hex(r.coin),r]));
}
export function liveRating(verdict: Verdict, prices: RatingPrices | undefined): Verdict {
  if (!prices) return verdict;
  // A forced record's fact references the preceding full price. Reconstruct that reference after resetting the
  // trigger baseline, then recompute from today's trade so a recovery cannot leave a stale decline on the screen.
  const recorded=verdict.priceMove?.downSinceRatedPct;
  const reference=recorded != null && recorded<100 && prices.full_price != null ? prices.full_price/(1-recorded/100) : prices.full_price;
  const priceMove=ratingPriceMove(prices.price,reference,prices.peak,true).fact;
  return {...verdict, priceMove: Object.keys(priceMove).length ? priceMove : undefined,
    ...(prices.checked_at && prices.checked_block != null ? {lastChecked:{block:Number(prices.checked_block),at:new Date(prices.checked_at).toISOString()}} : {})};
}
/** Broad price-decline candidates are cheap rows. The shared trigger decides exactly which moves need a record. */
export async function priceMovedCoins(db: ChainDb, limit: number): Promise<{coin:Address;card:string}[]> {
  if (limit<=0) return [];
  const rows=(await db.sql.query<RatingPrices & {card:string}>(`SELECT p.coin,p.price,p.peak,c.full_price,c.peak_recorded,c.checked_block,c.checked_at,l.card_id AS card
    FROM coin_rating_prices p JOIN coin_card_latest l ON l.coin=p.coin LEFT JOIN coin_rating_checks c ON c.coin=p.coin
    WHERE p.block>coalesce(c.checked_block,l.as_of_block) AND (p.price<c.full_price OR p.price<p.peak)
    ORDER BY p.price/nullif(c.full_price,0),p.ts DESC,p.coin`)).rows;
  return rows.filter(r=>ratingPriceMove(r.price,r.full_price,r.peak,r.peak_recorded ?? false).force).slice(0,limit).map(r=>({coin:hex(r.coin),card:r.card}));
}

/** Reorg rollback repairs only affected price rows after swaps and minute bars have been rebuilt. */
export async function repairRatingPricesAfterReorg(db: ChainDb, through: bigint) {
  const exists=(await db.sql.query<{present:boolean}>("SELECT to_regclass('coin_rating_prices') IS NOT NULL AS present")).rows[0]?.present;
  if(!exists)return; // Chain-only databases have no engines ledger yet.
  const affected=(await db.sql.query<{coin:Uint8Array}>('SELECT coin FROM coin_rating_prices WHERE block>$1',[through.toString()])).rows.map(r=>r.coin);
  if(!affected.length)return;
  await db.sql.query('DELETE FROM coin_rating_prices WHERE coin=ANY($1::bytea[])',[affected]);
  await db.sql.query(`INSERT INTO coin_rating_prices(coin,price,peak,ts,block,log_index,tx_hash)
    SELECT a.coin,coalesce(s.usd/s.amount_coin::double precision,b.close/power(10,coalesce(t.decimals,18))),
      greatest(hi.peak,bhi.peak/power(10,coalesce(t.decimals,18)),(life.data->>'peakRawPrice')::double precision),coalesce(s.ts,b.minute),coalesce(s.block,b.last_block),coalesce(s.log_index,0),coalesce(s.tx_hash,decode(repeat('00',32),'hex'))
    FROM unnest($1::bytea[]) a(coin) LEFT JOIN tokens t ON t.address=a.coin LEFT JOIN coin_lifetime life ON life.coin=a.coin
    LEFT JOIN LATERAL (SELECT * FROM retention_read_swaps WHERE coin=a.coin AND usd>0 AND amount_coin>0 ORDER BY ts DESC,block DESC,log_index DESC,tx_hash DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT max(usd/amount_coin::double precision) AS peak FROM retention_read_swaps WHERE coin=a.coin AND usd>0 AND amount_coin>0) hi ON true
    LEFT JOIN LATERAL (SELECT close,minute,last_block FROM bars_1m WHERE coin=a.coin ORDER BY minute DESC LIMIT 1) b ON true
    LEFT JOIN LATERAL (SELECT max(high) AS peak FROM bars_1m WHERE coin=a.coin) bhi ON true
    WHERE s.coin IS NOT NULL OR b.close IS NOT NULL`,[affected]);
}
