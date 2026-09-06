import type { ChainDb } from './client.js';
import { binary, hex, type Hex } from './types.js';

// Balances are a sum over event identities: a replayed event is never counted twice. WETH's
// Deposit/Withdrawal are redundant with its Transfer events and are not counted twice.
// Compacted history (retention.ts) survives as one net baseline per holder, so recomputed balances stay exact.
const movements = `SELECT token,to_address AS holder,amount,block FROM raw_history_live_transfers WHERE kind='Transfer'
  UNION ALL SELECT token,from_address AS holder,-amount,block FROM raw_history_live_transfers WHERE kind='Transfer'
  UNION ALL SELECT token,holder,amount,through_block AS block FROM transfer_baselines`;
export async function rebuildBalances(db: ChainDb, touched?: { token: Uint8Array; holder: Uint8Array }[]) {
  await db.sql.query('LOCK TABLE balances IN EXCLUSIVE MODE');
  if (!touched) {
    await db.sql.query('DELETE FROM balances');
    await db.sql.query(`INSERT INTO balances SELECT token,holder,sum(amount),max(block) FROM (${movements}) m GROUP BY token,holder`);
    return;
  }
  const unique = [...new Map(touched.map(r => [`${hex(r.token)}:${hex(r.holder)}`, r])).values()];
  for (let offset = 0; offset < unique.length; offset += 250) {
    const params: unknown[] = [];
    const values = unique.slice(offset, offset + 250).map(r => {
      params.push(r.token, r.holder); return `($${params.length - 1}::bytea,$${params.length}::bytea)`;
    });
    await db.sql.query(`WITH touched(token,holder) AS (VALUES ${values.join(',')})
      INSERT INTO balances SELECT t.token,t.holder,coalesce(sum(m.amount),0),coalesce(max(m.block),0)
      FROM touched t LEFT JOIN (${movements}) m ON m.token=t.token AND m.holder=t.holder GROUP BY t.token,t.holder
      ON CONFLICT(token,holder) DO UPDATE SET amount=excluded.amount,last_block=excluded.last_block`, params);
  }
}

/**
 * Apply newly inserted transfers to stored balances exactly once. Callers pass only the rows the insert actually
 * created (ON CONFLICT DO NOTHING RETURNING), in the same transaction, so a replayed transfer is never applied twice;
 * a reorg still rebuilds affected balances from history. Recomputing every touched (token, holder) from its whole
 * history made busy pool and router addresses cost their entire transfer count on every batch.
 */
export async function applyBalanceDeltas(db: ChainDb, inserted: readonly Record<string, unknown>[]) {
  const deltas = new Map<string, { token: Uint8Array; holder: Uint8Array; amount: bigint; block: bigint }>();
  for (const row of inserted) {
    if ((row.kind ?? 'Transfer') !== 'Transfer') continue;
    const amount = BigInt(String(row.amount)), block = BigInt(String(row.block));
    for (const [holder, signed] of [[row.to_address, amount], [row.from_address, -amount]] as const) {
      const key = `${hex(row.token as Uint8Array)}:${hex(holder as Uint8Array)}`;
      const found = deltas.get(key);
      if (found) { found.amount += signed; if (block > found.block) found.block = block; }
      else deltas.set(key, { token: row.token as Uint8Array, holder: holder as Uint8Array, amount: signed, block });
    }
  }
  if (!deltas.size) return;
  // Same lock as a rebuild, so a reorg rebuild and a delta never interleave; sorted keys keep row-lock order stable.
  await db.sql.query('LOCK TABLE balances IN EXCLUSIVE MODE');
  const list = [...deltas.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, d]) => d);
  for (let offset = 0; offset < list.length; offset += 250) {
    const params: unknown[] = [];
    const values = list.slice(offset, offset + 250).map(d => {
      params.push(d.token, d.holder, d.amount.toString(), d.block.toString());
      const i = params.length;
      return `($${i - 3}::bytea,$${i - 2}::bytea,$${i - 1}::numeric,$${i}::bigint)`;
    });
    await db.sql.query(`INSERT INTO balances(token,holder,amount,last_block) VALUES ${values.join(',')}
      ON CONFLICT(token,holder) DO UPDATE SET amount=balances.amount+excluded.amount,last_block=greatest(balances.last_block,excluded.last_block)`, params);
  }
}

const activeVenue = `(t.launchpad IS DISTINCT FROM 'pons' OR
    (s.venue='pons_curve' AND (t.graduated_block IS NULL OR s.block < t.graduated_block)) OR
    (s.venue <> 'pons_curve' AND t.graduated_block IS NOT NULL AND s.block >= t.graduated_block))`;
const eligible = `SELECT s.*,s.usd / (s.amount_coin::double precision / power(10,t.decimals)) AS price
  FROM raw_history_live_swaps s JOIN tokens t ON t.address=s.coin WHERE s.usd IS NOT NULL AND s.usd > 0 AND s.amount_coin > 0 AND t.decimals IS NOT NULL
  AND ${activeVenue}`;
const summarize = `SELECT coin,minute,(array_agg(price ORDER BY ts,block,log_index,tx_hash))[1] AS open,
  max(price) AS high,min(price) AS low,(array_agg(price ORDER BY ts DESC,block DESC,log_index DESC,tx_hash DESC))[1] AS close,
  sum(usd) AS volume_usd,count(*)::integer AS trades,min(block) AS first_block,max(block) AS last_block`;
interface BarKey { coin: Uint8Array; minute: Date | string }
/**
 * `perKey` reads each touched minute separately through swaps(coin,ts). As a plain join the planner bounds the index
 * scan by coin only and filters the minute afterwards, so every refreshed minute read the coin's entire swap history:
 * the per-batch cost grew with history (the largest write phase once coins have thousands of swaps).
 * OFFSET 0 keeps the lateral subquery from being flattened back into that join. Same rows, same aggregates.
 */
async function writeBars(db: ChainDb, keys: string, params: unknown[], perKey = false) {
  // refreshBars holds read_lock_coins for the entire key set before any bar DELETE or INSERT.
  // A bar whose minute has no raw swap left is the summary history retention keeps for a pruned coin (retention.ts
  // deletes a coin's swaps in whole minutes), so it is never rebuilt from what remains. Reorgs delete their bars first
  // (deleteAbove), and every other rebuild has the minute's swaps.
  // As EXISTS the planner turns the check into a semi-join bounded by coin only, so deleting one minute's bar read the
  // coin's entire swap history (6.2 million rows for 44 bars on 2026-10-13). The lateral LIMIT 1 keeps it per key.
  const present = perKey
    ? `SELECT k.coin,k.minute FROM (SELECT DISTINCT coin,minute FROM (${keys}) keyed) k
      CROSS JOIN LATERAL (SELECT 1 FROM raw_history_live_swaps s WHERE s.coin=k.coin AND s.ts >= k.minute AND s.ts < k.minute + interval '1 minute' LIMIT 1) present`
    : `SELECT k.coin,k.minute FROM (${keys}) k
      WHERE EXISTS(SELECT 1 FROM raw_history_live_swaps s WHERE s.coin=k.coin AND s.ts >= k.minute AND s.ts < k.minute + interval '1 minute')`;
  const mutable = `SELECT k.* FROM (${present}) k WHERE NOT EXISTS(SELECT 1 FROM raw_history_bar_keys a WHERE a.coin=k.coin AND a.minute=k.minute)`;
  await db.sql.query(`DELETE FROM bars_1m b USING (${mutable}) k WHERE b.coin=k.coin AND b.minute=k.minute`, params);
  const priced = perKey
    ? `SELECT e.*,date_trunc('minute',e.ts) AS minute FROM (SELECT DISTINCT coin,minute FROM (${keys}) keyed) k
      CROSS JOIN LATERAL (${eligible} AND s.coin=k.coin AND s.ts >= k.minute AND s.ts < k.minute + interval '1 minute' OFFSET 0) e`
    : `SELECT e.*,date_trunc('minute',e.ts) AS minute FROM (${eligible}) e
      JOIN (${keys}) k ON k.coin=e.coin AND e.ts >= k.minute AND e.ts < k.minute + interval '1 minute'`;
  await db.sql.query(`INSERT INTO bars_1m ${summarize}
    FROM (${priced}) priced WHERE NOT EXISTS(SELECT 1 FROM raw_history_bar_keys a WHERE a.coin=priced.coin AND a.minute=priced.minute) GROUP BY coin,minute
    ON CONFLICT(coin,minute) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
      volume_usd=excluded.volume_usd,trades=excluded.trades,first_block=excluded.first_block,last_block=excluded.last_block`, params);
}
/** Small applied-block batches use the coin/time index instead of scanning historical swaps. */
export async function refreshBars(db: ChainDb, touched: BarKey[]) {
  const unique = [...new Map(touched.map(r => [`${hex(r.coin)}:${new Date(r.minute).toISOString()}`,r])).values()];
  for (const row of unique) await db.ensurePartitions(new Date(row.minute));
  // Acquire the whole set before chunking: a later chunk must never introduce a lower coin lock.
  await db.lockReadCoins([...new Map(unique.map(r=>[hex(r.coin),r.coin])).values()]);
  // Serialize same-coin writers, including absent bars, without blocking unrelated live minutes.
  for (const coin of [...new Map(unique.map(r => [hex(r.coin), r.coin])).entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,coin])=>coin)) {
    await db.sql.query('INSERT INTO bar_write_locks(coin) VALUES($1) ON CONFLICT DO NOTHING',[coin]);
    await db.sql.query('SELECT coin FROM bar_write_locks WHERE coin=$1 FOR UPDATE',[coin]);
  }
  for (let offset=0;offset<unique.length;offset+=250) {
    const params: unknown[]=[];
    const values=unique.slice(offset,offset+250).map(r=>{params.push(r.coin,r.minute);return `($${params.length-1}::bytea,$${params.length}::timestamptz)`;});
    await writeBars(db,`SELECT DISTINCT * FROM (VALUES ${values.join(',')}) AS touched(coin,minute)`,params,true);
  }
}
/** Inclusive block range; recompute entire boundary minutes, including swaps outside the range. */
export async function rebuildBars(db: ChainDb, from: bigint, to: bigint, coin?: Hex) {
  if (from < 0n || to < from) throw new Error('Invalid bars interval');
  const params = [from.toString(), to.toString(), ...(coin ? [binary(coin)] : [])];
  const filter = coin ? ' AND coin=$3' : '';
  const keys = `SELECT DISTINCT coin,date_trunc('minute',ts) AS minute FROM raw_history_live_swaps WHERE block BETWEEN $1 AND $2${filter}
    UNION SELECT coin,minute FROM bars_1m WHERE first_block <= $2 AND last_block >= $1${filter}`;
  // Materialize keys before locking so the write cannot introduce an unlocked coin on a later snapshot.
  const touched=(await db.sql.query<BarKey>(keys,params)).rows;
  await refreshBars(db,touched);
}

export async function holders(db: ChainDb, token: Hex, block: bigint, limit = 20) {
  if (block < 0n || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid holder query');
  // TODO(spec): A 30-day Transfer window has no opening balances for older tokens.
  // These are observed holdings until genesis transfers or an archive baseline is available.
  const result = await db.sql.query<{ holder: Uint8Array; amount: string; is_curve: boolean; count: string; top10: string; held: string }>(`WITH held AS (
    SELECT holder,sum(amount) AS amount FROM (${movements}) m WHERE token=$1 AND block <= $2 GROUP BY holder HAVING sum(amount)>0
  ), ranked AS (
    SELECT h.*,row_number() OVER(ORDER BY amount DESC,holder) AS rank FROM held h
    WHERE holder <> $1 AND holder <> decode(repeat('00',20),'hex') AND holder <> decode(repeat('00',18)||'dead','hex')
  ), stats AS (SELECT count(*) AS count,coalesce(sum(amount),0) AS held,coalesce(sum(amount) FILTER(WHERE rank<=10),0) AS top10 FROM ranked)
  SELECT r.holder,r.amount,r.holder=t.curve AS is_curve,s.* FROM stats s LEFT JOIN ranked r ON r.rank <= $3
  LEFT JOIN tokens t ON t.address=$1 ORDER BY r.rank`, [binary(token), block.toString(), limit]);
  const stat = result.rows[0];
  // Share uses observed non-sink holdings; expose the denominator explicitly.
  return { asOfBlock: Number(block), coverage: 'observed_transfers' as const, holderCount: Number(stat.count),
    top10Share: Number(stat.held) > 0 ? Number(stat.top10) / Number(stat.held) : 0, heldAmount: stat.held,
    holders: result.rows.filter(r => r.holder).map(r => ({ address: hex(r.holder), amount: r.amount, isPonsCurve: !!r.is_curve })) };
}
export const timeframes = { '1s': 1, '15s': 15, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 } as const;
export type Timeframe = keyof typeof timeframes;
/** Times are Unix seconds, [from,to). Sub-minute history is clipped against current time. */
export async function candles(db: ChainDb, coin: Hex, tf: Timeframe, from: number, to: number, now = Date.now() / 1000) {
  if (!(tf in timeframes) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('Invalid candles query');
  const small = tf === '1s' || tf === '15s';
  if (small && !Number.isFinite(now)) throw new Error('Invalid candles clock');
  const start = small ? Math.max(from, now - 6 * 3600) : from;
  const end = small ? Math.min(to, now) : to;
  const bucket = `to_timestamp(floor(extract(epoch FROM ts)/$4)*$4)`;
  const source = small ? `SELECT coin,ts,price AS open,price AS high,price AS low,price AS close,usd AS volume_usd,1 AS trades,block AS first_block,block AS last_block,log_index,tx_hash FROM (${eligible}) e WHERE NOT e.pricing_pending` :
    'SELECT coin,minute AS ts,open,high,low,close,volume_usd,trades,first_block,last_block,0 AS log_index,coin AS tx_hash FROM bars_1m';
  const rows = start >= end ? [] : (await db.sql.query<{ ts: string; o: number; h: number; l: number; c: number; v: number; trades: number; last_block: string }>(`SELECT extract(epoch FROM ${bucket}) AS ts,
    (array_agg(open ORDER BY ts,first_block,log_index,tx_hash))[1] AS o,max(high) AS h,min(low) AS l,
    (array_agg(close ORDER BY ts DESC,last_block DESC,log_index DESC,tx_hash DESC))[1] AS c,sum(volume_usd) AS v,sum(trades)::integer AS trades,max(last_block) AS last_block
    FROM (${source}) s WHERE coin=$1 AND ts >= to_timestamp($2) AND ts < to_timestamp($3) GROUP BY ${bucket} ORDER BY ${bucket}`,
  [binary(coin), start, end, timeframes[tf]])).rows;
  // TODO(spec): CA-4 has no raw-history completeness watermark. Availability here
  // means retained observations, not certified chain coverage; never infer it from minute bars.
  const history = small ? (await db.sql.query<{ first: Date | null; last: Date | null; unpriced: boolean | null }>(`
    SELECT min(s.ts) AS first,max(s.ts) AS last,
      bool_or(s.ts >= to_timestamp($4) AND s.ts < to_timestamp($5) AND
        (s.usd IS NULL OR s.usd <= 0 OR s.amount_coin <= 0 OR t.decimals IS NULL OR s.pricing_pending)) AS unpriced
    FROM raw_history_live_swaps s JOIN tokens t ON t.address=s.coin
    WHERE s.coin=$1 AND s.ts >= to_timestamp($2) AND s.ts < to_timestamp($3) AND ${activeVenue}`,
    [binary(coin), now - 6 * 3600, now, start, end])).rows[0] : undefined;
  const token = (await db.sql.query<{ total_supply: string | null; decimals: number | null; supply_block: string | null }>('SELECT total_supply,decimals,supply_block FROM tokens WHERE address=$1', [binary(coin)])).rows[0];
  // TODO(spec): Locks, vesting, burn-wallet inventory and historical supply are not indexed yet.
  // Use the latest total-supply sample for cap, with its block exposed; never invent circulating supply.
  const supply = token?.total_supply != null && token.decimals != null ? Number(token.total_supply) / 10 ** token.decimals : null;
  return { tf, bars: rows.map(r => ({ ts: Number(r.ts), o: r.o, h: r.h, l: r.l, c: r.c, vUsd: r.v, trades: r.trades,
    marketCapUsd: supply == null ? null : r.c * supply })), asOfBlock: rows.reduce((n, r) => Math.max(n, Number(r.last_block)), 0),
    supplyBasis: 'total_supply' as const, supplyAsOfBlock: token?.supply_block == null ? null : Number(token.supply_block),
    ...(small ? { firstTradeTs: history?.first ? new Date(history.first).getTime()/1000 : null,
      lastTradeTs: history?.last ? new Date(history.last).getTime()/1000 : null,
      unavailable: start >= end || !history?.first || history.unpriced ? ['subMinuteBars'] : [] } : {}) };
}
