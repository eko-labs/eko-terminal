import { loadRegistry } from '@eko/chain';
import { binary, hex, type ChainDb, type Lifetime, unpackSwap } from '@eko/db';
import { isSink, rowHex } from './aggregates.js';
import { holdingsAt, type LoadedSources, type PoolRow } from './sources.js';

type MeasurementSources = {lifetime?:Lifetime} & Pick<LoadedSources, 'coin' | 'asOfBlock' | 'createdAtSec' | 'launchpad' | 'swaps' | 'events' | 'holdings' | 'blueChipHolderCount'> & {
  poolRefs: Pick<LoadedSources['poolRefs'][number], 'id' | 'quote'>[];
  token: Pick<LoadedSources['token'], 'curve' | 'graduated_block'>;
};

/** Both sides of each indexed position, valued at that pool's latest priced swap at the rating block. */
export function blueChipMeasurements(s: MeasurementSources) {
  const pools = new Map(s.poolRefs.map(p => [p.id, p]));
  const latest = new Map<string, LoadedSources['swaps'][number]>();
  const samples=[...Object.values(s.lifetime?.poolLastPriced ?? {}).map(unpackSwap),...s.swaps];
  for (const swap of samples) if (Number(swap.block) <= s.asOfBlock && swap.venue !== 'pons_curve' &&
    swap.usd != null && swap.usd > 0 && Number(swap.amount_coin) > 0 && Number(swap.amount_quote) > 0) {
      const key=rowHex(swap.pool_id),prior=latest.get(key);
      if(!prior || Number(swap.block)>Number(prior.block) || Number(swap.block)===Number(prior.block) && (swap.log_index>prior.log_index || swap.log_index===prior.log_index && rowHex(swap.tx_hash)>rowHex(prior.tx_hash)))latest.set(key,swap as LoadedSources['swaps'][number]);
    }
  const positions = new Map<string, { pool: string; lower: number; upper: number; liquidity: number }>();
  for(const [pool,data] of Object.entries(s.lifetime?.liquidity ?? {}))for(const [range,p] of Object.entries(data.moneyPositions ?? {}))
    positions.set(`${pool}:${range}`,{pool,lower:p.lower,upper:p.upper,liquidity:Number(p.liquidity)});
  for (const e of s.events) {
    if(s.lifetime?.liquidity?.[rowHex(e.pool_id)])continue;
    if (Number(e.block) > s.asOfBlock || !['Mint', 'Burn', 'ModifyLiquidity'].includes(e.kind)) continue;
    const pool = rowHex(e.pool_id), lower = Number(e.data.tickLower), upper = Number(e.data.tickUpper);
    if (!pools.has(pool) || !Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) continue;
    const key = `${pool}:${lower}:${upper}`, position = positions.get(key) ?? { pool, lower, upper, liquidity: 0 };
    position.liquidity += Number(e.data.liquidityDelta ?? e.data.amount) * (e.kind === 'Burn' ? -1 : 1);
    positions.set(key, position);
  }
  let liquidity = 0, measured = false, incomplete = false;
  for (const p of positions.values()) {
    const swap = latest.get(p.pool), ref = pools.get(p.pool)!;
    if (!swap) { if(p.liquidity>0)incomplete=true; continue; }
    measured = true;
    const coinFirst = s.coin.toLowerCase() < ref.quote.toLowerCase();
    const coin = Number(swap.amount_coin), quote = Number(swap.amount_quote);
    const sqrt = Math.sqrt(coinFirst ? quote / coin : coin / quote);
    const low = Math.pow(1.0001, p.lower / 2), high = Math.pow(1.0001, p.upper / 2), at = Math.min(high, Math.max(low, sqrt));
    const amount0 = Math.max(0, p.liquidity) * (1 / at - 1 / high), amount1 = Math.max(0, p.liquidity) * (at - low);
    liquidity += coinFirst ? amount0 * swap.usd! / coin + amount1 * swap.usd! / quote : amount1 * swap.usd! / coin + amount0 * swap.usd! / quote;
  }
  const manager = loadRegistry().addressOf('uniswapV4.poolManager')?.toLowerCase();
  const holders = s.holdings.filter(h => {
    const wallet = rowHex(h.holder);
    return BigInt(h.amount) > 0n && !isSink(wallet, s.coin) && wallet !== manager &&
      (!s.token.curve || wallet !== rowHex(s.token.curve)) && !pools.has(wallet);
  }).length;
  const graduated = s.token.graduated_block != null && Number(s.token.graduated_block) <= s.asOfBlock;
  return { realPool: latest.size > 0 && (graduated || (!s.token.curve && s.launchpad !== 'pons')),
    liquidityUsd: measured && !incomplete && Number.isFinite(liquidity) ? liquidity : null, holders:s.blueChipHolderCount ?? holders };
}
export async function publishBlueChipMeasurements(tx: ChainDb, s: MeasurementSources) {
  const m = blueChipMeasurements(s);
  await tx.sql.query(`INSERT INTO read_blue_chip(coin,as_of_block,created_at,real_pool,liquidity_usd,holders)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(coin) DO UPDATE SET as_of_block=excluded.as_of_block,
    created_at=excluded.created_at,real_pool=excluded.real_pool,liquidity_usd=excluded.liquidity_usd,holders=excluded.holders
    WHERE read_blue_chip.as_of_block<=excluded.as_of_block`, [binary(s.coin),s.asOfBlock,new Date(s.createdAtSec*1000),m.realPool,m.liquidityUsd,m.holders]);
}

export const BLUE_CHIP_BACKFILL_WIDTH = 250;
/** Latest-card snapshots only, using indexed data. No rating, receipt, acquisition or public read-model writes. */
export async function backfillBlueChip(db: ChainDb): Promise<number> {
  const rows = (await db.sql.query<{coin:Uint8Array;as_of_block:string;created_at:Date;curve:Uint8Array|null;graduated_block:string|null;launchpad:LoadedSources['launchpad'];has_card:boolean}>(`SELECT r.coin,
    coalesce(c.as_of_block,t.first_block)::text AS as_of_block,
    coalesce((c.data->'identity'->>'createdAt')::timestamptz,bt.ts,cb.ts,r.activity) AS created_at,
    t.curve,t.graduated_block,coalesce(t.launchpad,'other') AS launchpad,c.coin IS NOT NULL AS has_card
    FROM read_coins r JOIN tokens t ON t.address=r.coin LEFT JOIN coin_card_latest c ON c.coin=r.coin
    LEFT JOIN engine_block_times bt ON bt.number=t.first_block LEFT JOIN chain_blocks cb ON cb.number=t.first_block
    LEFT JOIN read_blue_chip b ON b.coin=r.coin WHERE b.coin IS NULL ORDER BY r.coin LIMIT $1`,[BLUE_CHIP_BACKFILL_WIDTH])).rows;
  for(const r of rows) {
    // Retention cannot reconstruct the latest card's original snapshot. Keep unknowns null, never invented zeroes.
    // No-card rows cannot qualify. Their timestamp fallback is replaced by the first successful rating.
    if(!r.has_card || (await db.sql.query('SELECT 1 FROM history_prunes WHERE coin=$1',[r.coin])).rows.length) {
      await db.sql.query(`INSERT INTO read_blue_chip(coin,as_of_block,created_at,real_pool,liquidity_usd,holders)
        VALUES($1,$2,$3,false,NULL,NULL) ON CONFLICT DO NOTHING`,[r.coin,r.as_of_block,r.created_at]);
      continue;
    }
    const coin=hex(r.coin),block=Number(r.as_of_block);
    const pools=(await db.sql.query<PoolRow>('SELECT * FROM pools WHERE (currency0=$1 OR currency1=$1) AND created_block<=$2 ORDER BY id',[r.coin,block])).rows;
    const [swaps,events,holdings]=await Promise.all([
      db.sql.query<LoadedSources['swaps'][number]>(`SELECT DISTINCT ON(pool_id) * FROM swaps WHERE coin=$1 AND block<=$2
        AND venue<>'pons_curve' AND usd>0 AND amount_coin>0 AND amount_quote>0 ORDER BY pool_id,block DESC,log_index DESC,tx_hash DESC`,[r.coin,block]),
      db.sql.query<LoadedSources['events'][number]>(`SELECT e.* FROM liquidity_events e JOIN pools p ON p.id=e.pool_id
        WHERE (p.currency0=$1 OR p.currency1=$1) AND e.block<=$2 ORDER BY e.block,e.log_index,e.tx_hash`,[r.coin,block]),
      holdingsAt(db,coin,block),
    ]);
    const sources:MeasurementSources={coin,asOfBlock:block,createdAtSec:r.created_at.getTime()/1000,launchpad:r.launchpad,token:r,
      poolRefs:pools.map(p=>({id:hex(p.id),quote:hex(hex(p.currency0)===coin ? p.currency1 : p.currency0)})),
      swaps:swaps.rows,events:events.rows,holdings};
    await db.tx(async tx=>{
      const current=(await tx.sql.query<{as_of_block:string}>('SELECT as_of_block FROM coin_card_latest WHERE coin=$1 FOR SHARE',[r.coin])).rows[0];
      if(current && Number(current.as_of_block)===block)await publishBlueChipMeasurements(tx,sources);
    });
  }
  return rows.length;
}
