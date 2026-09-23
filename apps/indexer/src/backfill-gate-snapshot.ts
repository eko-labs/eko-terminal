import { binary, type ChainDb } from '@eko/db';
import { GatePlanSchema, GateSnapshotSchema, evidenceHash, type GatePlan, type GateSnapshot } from './backfill-gate.js';

/** Read an existing database under one read-only snapshot. No migrations, collectors or RPC. */
export async function captureBackfillSnapshot(db: ChainDb, input: unknown, meta: { origin: GateSnapshot['origin']; checkpoint: string; capturedAt?: string }): Promise<GateSnapshot> {
  const plan: GatePlan = GatePlanSchema.parse(input);
  return db.tx(async tx => {
    await tx.sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await tx.sql.query("SET LOCAL statement_timeout = '30s'");
    const query = async <T>(sql: string, params: unknown[] = []) => (await tx.sql.query<T>(sql, params)).rows;
    const bounded = async <T>(sql: string, params: unknown[] = []) => {
      const rows = await query<T>(`${sql} LIMIT ${plan.maxRows + 1}`, params);
      if (rows.length > plan.maxRows) throw new Error('Evidence row bound exceeded; split the declared scope without changing its denominator');
      return rows;
    };
    const head = plan.head.block, recent = plan.recent.block;
    const compacted=(await query<{present:boolean}>("SELECT to_regclass('raw_history_watermarks') IS NOT NULL AS present"))[0]?.present;
    if(compacted && (await query(`SELECT 1 FROM raw_history_watermarks WHERE (name='token_transfers' AND through_block>=0) OR (name='swaps' AND through_block>=$1) LIMIT 1`,[recent])).length)
      throw new Error('Backfill evidence crosses compacted raw history: use an archive');
    const ranges = await bounded<GateSnapshot['ranges'][number]>(`SELECT stream,from_block::text AS "from",to_block::text AS "to",status,lease_owner AS "leaseOwner",to_char(lease_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "leaseUntil",attempts
      FROM ingest_ranges WHERE stream=ANY($1::text[]) AND from_block <= $2 ORDER BY stream,from_block`, [Object.values(plan.streams), head]);
    const checkpoints = await bounded<GateSnapshot['checkpoints'][number]>(`SELECT c.stream,c.block::text,CASE WHEN c.hash IS NOT NULL THEN '0x'||encode(c.hash,'hex') END AS hash,
      CASE WHEN b.hash IS NOT NULL THEN '0x'||encode(b.hash,'hex') END AS "canonicalHash" FROM ingest_cursors c LEFT JOIN chain_blocks b ON b.number=c.block ORDER BY c.stream`);
    const headers = await bounded<GateSnapshot['headers'][number]>(`SELECT number::text AS block,'0x'||encode(hash,'hex') AS hash,to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp
      FROM chain_blocks WHERE number=ANY($1::bigint[]) ORDER BY number`, [[head, recent, plan.recent.previous.block, plan.sevenDay.block, plan.sevenDay.previous.block]]);
    const available = await bounded<{ id: string; sourceRevision: string; replayMode: string; cutBlock: string; watermarkBlock: string; invalidations: string; data: unknown }>(`SELECT m.id,m.source_revision AS "sourceRevision",m.replay_mode AS "replayMode",
      m.known_position[1]::text AS "cutBlock",m.watermark_position[1]::text AS "watermarkBlock",m.data,
      (SELECT count(*)::text FROM guard_source_events e WHERE e.target_id=m.id) AS invalidations
      FROM guard_availability m WHERE m.chain_id=4663 ORDER BY m.id`);
    const guardSources = available.map(({ data, ...m }) => ({ ...m, contentHash: evidenceHash(data) }));
    const inventories: GateSnapshot['inventories'] = [];
    // Partition keys contain timestamps, so check transaction/log identity independently.
    for (const [table, identity, blockColumn, from] of [
      ['pons_events', 'tx_hash,log_index', 'block', '0'], ['pools', 'id', 'created_block', recent],
      ['swaps', 'tx_hash,log_index', 'block', recent], ['token_transfers', 'tx_hash,log_index', 'block', '0'],
      ['balances', 'token,holder', 'last_block', '0'], ['bars_1m', 'coin,minute', 'last_block', recent],
    ] as const) {
      const [stats] = await query<{ rows: string; duplicates: string }>(`SELECT coalesce(sum(n),0)::text AS rows,coalesce(sum(n-1),0)::text AS duplicates FROM
        (SELECT count(*) AS n FROM ${table} WHERE ${blockColumn} BETWEEN $1 AND $2 GROUP BY ${identity}) grouped`, [from, head]);
      inventories.push({ table, ...stats });
    }
    const supplies: GateSnapshot['supplies'] = [];
    for (const token of plan.tokens) {
      const rows = await query<GateSnapshot['supplies'][number]>(`WITH movements AS (
          SELECT to_address AS holder,amount FROM token_transfers WHERE token=$1 AND block <= $2 AND kind='Transfer'
          UNION ALL SELECT from_address,-amount FROM token_transfers WHERE token=$1 AND block <= $2 AND kind='Transfer'
        ), expected AS (SELECT holder,sum(amount) AS amount FROM movements GROUP BY holder), actual AS (SELECT holder,amount,last_block FROM balances WHERE token=$1),
        mismatch AS (SELECT count(*) AS n FROM expected e FULL JOIN actual a USING(holder) WHERE coalesce(e.amount,0)<>coalesce(a.amount,0) OR a.last_block>$2),
        totals AS (SELECT coalesce(sum(amount) FILTER(WHERE from_address=$3 AND to_address<>$3),0) AS minted,
          coalesce(sum(amount) FILTER(WHERE to_address=$3 AND from_address<>$3),0) AS burned,count(*) AS n
          FROM token_transfers WHERE token=$1 AND block <= $2 AND kind='Transfer')
        SELECT '0x'||encode(t.address,'hex') AS token,t.first_block::text AS "firstBlock",$2::text AS "to",totals.minted::text,totals.burned::text,
          (SELECT coalesce(sum(amount),0)::text FROM actual WHERE holder<>$3) AS held,
          (SELECT count(*)::text FROM actual WHERE holder<>$3 AND amount<0) AS "negativeHolders",mismatch.n::text AS "mismatchedHolders",
          t.total_supply::text AS "totalSupply",t.supply_block::text AS "supplyBlock",totals.n::text AS "transferRows"
        FROM tokens t CROSS JOIN totals CROSS JOIN mismatch WHERE t.address=$1`, [binary(token), head, Buffer.alloc(20)]);
      supplies.push(...rows);
    }
    // Compare complete minute aggregates, including boundary-minute swaps, against stored OHLCV.
    const [candles] = await query<GateSnapshot['candles']>(`WITH keys AS (
        SELECT DISTINCT coin,date_trunc('minute',ts) AS minute FROM swaps WHERE block BETWEEN $1 AND $2
        UNION SELECT coin,minute FROM bars_1m WHERE first_block <= $2 AND last_block >= $1
      ), eligible AS (SELECT s.*,date_trunc('minute',s.ts) AS minute,s.usd/(s.amount_coin::double precision/power(10,t.decimals)) AS price
        FROM swaps s JOIN tokens t ON t.address=s.coin JOIN keys k ON k.coin=s.coin AND s.ts >= k.minute AND s.ts<k.minute+interval '1 minute'
        WHERE s.block <= $2 AND s.usd>0 AND s.amount_coin>0 AND t.decimals IS NOT NULL
        AND (t.launchpad IS DISTINCT FROM 'pons' OR (t.graduated_block IS NULL AND s.venue='pons_curve') OR
          (t.graduated_block IS NOT NULL AND ((s.block<t.graduated_block AND s.venue='pons_curve') OR (s.block>=t.graduated_block AND s.venue<>'pons_curve'))))),
      expected AS (SELECT coin,minute,(array_agg(price ORDER BY ts,block,log_index,tx_hash))[1] AS open,max(price) AS high,min(price) AS low,
        (array_agg(price ORDER BY ts DESC,block DESC,log_index DESC,tx_hash DESC))[1] AS close,sum(usd) AS volume_usd,count(*) AS trades,min(block) AS first_block,max(block) AS last_block
        FROM eligible GROUP BY coin,minute),
      actual AS (SELECT b.* FROM bars_1m b JOIN keys k USING(coin,minute)),
      compared AS (SELECT e.coin AS ec,a.coin AS ac FROM expected e FULL JOIN actual a USING(coin,minute)
        WHERE e.coin IS NULL OR a.coin IS NULL OR (e.open,e.high,e.low,e.close,e.volume_usd,e.trades,e.first_block,e.last_block)
          IS DISTINCT FROM (a.open,a.high,a.low,a.close,a.volume_usd,a.trades,a.first_block,a.last_block))
      SELECT (SELECT count(*)::text FROM expected) AS expected,(SELECT count(*)::text FROM actual) AS actual,(SELECT count(*)::text FROM compared) AS mismatches,
        (SELECT count(*)::text FROM swaps s LEFT JOIN tokens t ON t.address=s.coin WHERE s.block BETWEEN $1 AND $2 AND (s.usd IS NULL OR t.decimals IS NULL OR s.pricing_pending)) AS "unpricedSwaps"`, [recent, head]);
    return GateSnapshotSchema.parse({ version: 1, chainId: 4663, ...meta, capturedAt: meta.capturedAt ?? new Date().toISOString(), plan,
      ranges, checkpoints, headers, guardSources, inventories, supplies, candles, follower: null, cost: null });
  });
}
