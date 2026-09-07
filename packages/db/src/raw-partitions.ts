import { retentionPhase } from './retention-errors.js';
import type { ChainDb } from './client.js';
import { addLifetimeSwaps, emptyLifetime, packSwap, type Lifetime, type LifetimeIdentity } from './lifetime.js';
import { GRADE_CUTS } from './rating-retention.js';

export type RawTable = 'swaps' | 'token_transfers';
export interface RawSealOptions { tsBefore?: Date; firstBlocks?: number; cohortSec?: number; poolManager?: string; now?: Date; checkpointBefore?: Date; coinBatchSize?: number; onProgress?: (progress: {day:string;coins:number;rows:number;seconds:number}) => void }
export interface RawSeal { name: RawTable; partition_name: string; start_ts: Date; end_ts: Date; rows: string; through_block: string; sealed: boolean; dropped: boolean }
export function rawPartitionName(table: RawTable, date: Date) { return `${table}_d${date.toISOString().slice(0,10).replaceAll('-','_')}`; }
function validate(table: RawTable, partition: string) {
  if (!['swaps','token_transfers'].includes(table) || !new RegExp(`^${table}_(?:d\\d{4}_\\d{2}_\\d{2}|\\d{4}_\\d{2})$`).test(partition)) throw new Error('Invalid raw partition');
}
export async function rawMaintenance<T>(db: ChainDb, work: (session: ChainDb) => Promise<T>): Promise<T> {
  return db.session(async session => {
    const acquired=(await session.sql.query<{acquired:boolean}>('SELECT pg_try_advisory_lock(4663,208) AS acquired')).rows[0]?.acquired;
    if (!acquired) throw Object.assign(new Error('Raw history mutex is busy'),{code:'55P03'});
    let failed=false;
    try { return await work(session); } catch(error) { failed=true; throw error; } finally {
      // Cleanup must not replace a partition's original error with (for example) 25P02.
      try { await retentionPhase('raw_mutex_release', () => session.sql.query('SELECT pg_advisory_unlock(4663,208)')); }
      catch(error) { if(!failed)throw error; }
    }
  });
}
const packed = (alias: string) => `jsonb_build_object('block',${alias}.block::text,'ts',to_char(${alias}.ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'tx_hash','0x'||encode(${alias}.tx_hash,'hex'),'log_index',${alias}.log_index,'trader',CASE WHEN ${alias}.trader IS NOT NULL THEN '0x'||encode(${alias}.trader,'hex') END,
 'recipient',CASE WHEN ${alias}.recipient IS NOT NULL THEN '0x'||encode(${alias}.recipient,'hex') END,'senders_pending',${alias}.senders_pending,'side',${alias}.side,
 'amount_coin',${alias}.amount_coin::text,'amount_quote',${alias}.amount_quote::text,'price_quote',${alias}.price_quote,'usd',${alias}.usd,'venue',${alias}.venue,
 'pool_id','0x'||encode(${alias}.pool_id,'hex'),'quote_asset','0x'||encode(${alias}.quote_asset,'hex'))`;

export function rawSealStatementMs() {
  const seconds=Number(process.env.RAW_SEAL_STATEMENT_SEC ?? 300);
  if(!Number.isFinite(seconds) || seconds<=0 || seconds>2147483)throw new Error('Invalid RAW_SEAL_STATEMENT_SEC');
  return Math.max(1,Math.floor(seconds*1000));
}
export async function sealTx<T>(db:ChainDb,work:(tx:ChainDb)=>Promise<T>) {
  return db.tx(async tx=>{
    await tx.sql.query(`SET LOCAL statement_timeout='${rawSealStatementMs()}ms'`);
    await tx.sql.query("SET LOCAL lock_timeout='5s'");
    return work(tx);
  });
}
/** Fence once, then commit one ordered coin batch per UTC day. */
export async function sealRawPartition(db: ChainDb, table: RawTable, partition: string, options: RawSealOptions = {}): Promise<RawSeal> {
  validate(table,partition);
  return rawMaintenance(db, session=>sealRawPartitionOnSession(session,table,partition,options));
}
/** Caller owns the raw maintenance mutex; no nested session lock/cleanup on this path. */
export async function sealRawPartitionOnSession(db: ChainDb, table: RawTable, partition: string, options: RawSealOptions): Promise<RawSeal> {
  validate(table,partition);
  const batchSize=options.coinBatchSize ?? 200;
  if(!Number.isInteger(batchSize) || batchSize<1 || batchSize>1000)throw new Error('Invalid seal coin batch size');
  const previous=await sealTx(db,async tx=>(await tx.sql.query<RawSeal>('SELECT * FROM raw_history_seals WHERE name=$1 AND partition_name=$2',[table,partition])).rows[0]);
  if(previous && options.tsBefore && +new Date(previous.end_ts)!==+options.tsBefore) throw new Error('Seal cutoff differs from persisted cutoff');
  if(previous?.sealed)return previous;
  // This barrier waits only for in-flight insert/update statements, not for the aggregate work.
  // Their boundary triggers take FOR SHARE on the same row and see the committed range fence.
  if(!previous) await sealTx(db,async tx=>{
    await tx.sql.query('SELECT through_block FROM raw_history_watermarks WHERE name=$1 FOR UPDATE',[table]);
    const bound=(await tx.sql.query<{bound:string}>(`SELECT pg_get_expr(c.relpartbound,c.oid) AS bound FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid=c.oid WHERE c.oid=to_regclass($1) AND i.inhparent=$2::regclass`,[partition,table])).rows[0];
    const dates=[...(bound?.bound ?? '').matchAll(/'([^']+)'/g)].map(m=>new Date(m[1]!));
    if(dates.length!==2)throw new Error('Source must be an attached range partition');
    const [start,end]=dates as [Date,Date], before=options.tsBefore ?? end;
    if(!Number.isFinite(+before) || +before<=+start || +before>+end)throw new Error('Invalid seal cutoff');
    await tx.sql.query(`INSERT INTO raw_history_seals(name,partition_name,start_ts,end_ts,rows,through_block)
      VALUES($1,$2,$3,$4,0,-1) ON CONFLICT DO NOTHING`,[table,partition,start,before]);
  });
  const seal=await sealTx(db,async tx=>(await tx.sql.query<RawSeal>('SELECT * FROM raw_history_seals WHERE name=$1 AND partition_name=$2',[table,partition])).rows[0]!);
  const swaps=table==='swaps',key=swaps?'coin':'token';
  for(let time=+new Date(seal.start_ts);time<+new Date(seal.end_ts);) {
    const day=new Date(time),end=new Date(Math.min(Date.parse(day.toISOString().slice(0,10))+86400000,+new Date(seal.end_ts)));
    await sealTx(db,async tx=>{
      await tx.sql.query(`INSERT INTO raw_history_seal_days(name,partition_name,day,end_ts) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[table,partition,day,end]);
    });
    // Drain and commit global rankings before the first coin cursor can hide source rows.
    const untouched=swaps && await sealTx(db,async tx=>(await tx.sql.query<{untouched:boolean}>(
      'SELECT coins=0 AND NOT complete AS untouched FROM raw_history_seal_days WHERE name=$1 AND partition_name=$2 AND day=$3',[table,partition,day])).rows[0]?.untouched);
    if(untouched) {
      // Preserve the first coin batch's identity-clock publication before rankings, as before.
      await sealTx(db,tx=>tx.sql.query(`INSERT INTO engine_block_times(number,ts,hash,source)
        SELECT b.number,b.ts,b.hash,'head' FROM (
          SELECT coin FROM ${partition} WHERE ts>=$1 AND ts<$2 GROUP BY coin ORDER BY coin LIMIT $3
        )k JOIN tokens t ON t.address=k.coin JOIN chain_blocks b ON b.number=t.first_block
        WHERE t.deployer IS NOT NULL ON CONFLICT DO NOTHING`,[day,end,batchSize]));
      await retentionPhase('trending_snapshots', () => sealRankings(db,{...seal,end_ts:end}));
    }
    while(true) {
      const started=performance.now();
      const progress=await sealTx(db,async tx=>{
        const cursor=(await tx.sql.query<{last_coin:Uint8Array|null;complete:boolean;coins:string;rows:string}>(`SELECT * FROM raw_history_seal_days WHERE name=$1 AND partition_name=$2 AND day=$3 FOR UPDATE`,[table,partition,day])).rows[0]!;
        if(cursor.complete)return null;
        const coins=(await tx.sql.query<{coin:Uint8Array}>(`SELECT ${key} AS coin FROM ${partition}
          WHERE ts>=$1 AND ts<$2 AND ${key}>coalesce($3::bytea,''::bytea) GROUP BY ${key} ORDER BY ${key} LIMIT $4`,[day,end,cursor.last_coin,batchSize])).rows.map(r=>r.coin);
        if(!coins.length) {
          await tx.sql.query('UPDATE raw_history_seal_days SET complete=true WHERE name=$1 AND partition_name=$2 AND day=$3',[table,partition,day]);
          return null;
        }
        // One indexed coin range at a time; never materialize the entire old monthly prefix.
        await tx.sql.query(`CREATE TEMP TABLE raw_seal_rows ON COMMIT DROP AS SELECT s.* FROM unnest($3::bytea[])k(coin)
          CROSS JOIN LATERAL(SELECT * FROM ${partition} s WHERE s.${key}=k.coin AND s.ts>=$1 AND s.ts<$2 OFFSET 0)s`,[day,end,coins]);
        await tx.sql.query(`CREATE INDEX ON raw_seal_rows(${key},block)`);
        await tx.sql.query('ANALYZE raw_seal_rows');
        await tx.sql.query(`CREATE TEMP TABLE raw_seal_coins ON COMMIT DROP AS SELECT k.coin,t.first_block,t.graduated_block,t.deployer,
          coalesce(e.ts,c.ts) AS created,l.opening_holdings,l.graduation_holdings,l.revision,
          coalesce(l.data,$1::jsonb || CASE WHEN EXISTS(SELECT 1 FROM history_prunes p WHERE p.coin=k.coin AND p.transfers+p.swaps+p.liquidity+p.pons>0)
            THEN '{"legacyIncomplete":true,"earlyComplete":false,"usdComplete":false}'::jsonb ELSE '{}'::jsonb END) AS data
          FROM (SELECT DISTINCT ${key} AS coin FROM raw_seal_rows) k LEFT JOIN tokens t ON t.address=k.coin
          LEFT JOIN engine_block_times e ON e.number=t.first_block LEFT JOIN chain_blocks c ON c.number=t.first_block LEFT JOIN coin_lifetime l ON l.coin=k.coin`,[JSON.stringify(emptyLifetime())]);
        await tx.sql.query('CREATE UNIQUE INDEX ON raw_seal_coins(coin)');
        const outOfOrder=(await tx.sql.query(`SELECT 1 FROM raw_seal_coins c WHERE (c.data->'last'->>'block')::bigint >=
          (SELECT min(block) FROM raw_seal_rows r WHERE r.${key}=c.coin) LIMIT 1`)).rows.length;
        if(swaps && outOfOrder)throw new Error('Seal raw swap partitions in chronological order');
        await tx.sql.query(`INSERT INTO engine_block_times(number,ts,hash,source) SELECT b.number,b.ts,b.hash,'head'
          FROM raw_seal_coins t JOIN chain_blocks b ON b.number=t.first_block WHERE t.deployer IS NOT NULL ON CONFLICT DO NOTHING`);
        await tx.sql.query(`INSERT INTO engine_block_times(number,ts,hash,source) SELECT DISTINCT b.number,b.ts,b.hash,'head'
          FROM raw_seal_coins t JOIN engine_block_times c ON c.number=t.first_block CROSS JOIN (VALUES(3600),(86400),(604800)) h(sec)
          CROSS JOIN LATERAL(SELECT number,ts,hash FROM chain_blocks WHERE ts>=c.ts+h.sec*interval '1 second' ORDER BY ts,number LIMIT 1)b
          WHERE t.deployer IS NOT NULL ON CONFLICT DO NOTHING`);
        await tx.sql.query(`CREATE TEMP TABLE raw_seal_cuts ON COMMIT DROP AS SELECT DISTINCT t.coin,e.number AS block,e.ts,
          (SELECT number FROM engine_block_times WHERE ts<=e.ts-interval '1 hour' AND number<=e.number ORDER BY ts DESC,number DESC LIMIT 1) AS prior
          FROM raw_seal_coins t JOIN engine_block_times c ON c.number=t.first_block CROSS JOIN (VALUES(3600),(86400),(604800)) h(sec)
          CROSS JOIN LATERAL(SELECT number,ts FROM engine_block_times WHERE ts>=c.ts+h.sec*interval '1 second' ORDER BY ts,number LIMIT 1)e WHERE t.deployer IS NOT NULL`);
        await tx.sql.query(`UPDATE raw_seal_coins l SET opening_holdings=x.data FROM (
          SELECT t.coin,coalesce(jsonb_object_agg(encode(h.holder,'hex'),h.amount::text) FILTER(WHERE h.holder IS NOT NULL),'{}') AS data
          FROM raw_seal_coins t LEFT JOIN LATERAL(SELECT holder,sum(amount) AS amount FROM (
            SELECT to_address AS holder,amount FROM raw_history_live_transfers WHERE token=t.coin AND block<=t.first_block AND kind='Transfer'
            UNION ALL SELECT from_address,-amount FROM raw_history_live_transfers WHERE token=t.coin AND block<=t.first_block AND kind='Transfer'
            UNION ALL SELECT holder,amount FROM transfer_baselines WHERE token=t.coin AND through_block<=t.first_block
          ) a GROUP BY holder HAVING sum(amount)>0)h ON true GROUP BY t.coin
        )x WHERE l.coin=x.coin AND l.first_block IS NOT NULL AND l.opening_holdings IS NULL`);
        await tx.sql.query(`UPDATE raw_seal_coins l SET graduation_holdings=x.data FROM (
          SELECT t.coin,coalesce(jsonb_object_agg(encode(h.holder,'hex'),h.amount::text) FILTER(WHERE h.holder IS NOT NULL),'{}') AS data
          FROM raw_seal_coins t LEFT JOIN LATERAL(SELECT holder,sum(amount) AS amount FROM (
            SELECT to_address AS holder,amount FROM raw_history_live_transfers WHERE token=t.coin AND block<t.graduated_block AND kind='Transfer'
            UNION ALL SELECT from_address,-amount FROM raw_history_live_transfers WHERE token=t.coin AND block<t.graduated_block AND kind='Transfer'
            UNION ALL SELECT holder,amount FROM transfer_baselines WHERE token=t.coin AND through_block<t.graduated_block
          ) a GROUP BY holder HAVING sum(amount)>0)h ON true WHERE t.graduated_block<=(SELECT max(block) FROM raw_seal_rows) GROUP BY t.coin
        )x WHERE l.coin=x.coin AND l.graduation_holdings IS NULL`);
        if(swaps)await sealSwaps(tx,{...seal,end_ts:end},options);else await sealTransfers(tx);
        // DETACH/DROP do not fire parent statement triggers. Publish their cache invalidations with the summaries.
        if(swaps) {
          await tx.sql.query(`INSERT INTO engine_swap_versions AS v(coin,revision,high_block) SELECT coin,1,max(block) FROM raw_seal_rows GROUP BY coin
            ON CONFLICT(coin) DO UPDATE SET revision=v.revision+1`);
          await tx.sql.query(`INSERT INTO engine_window_versions AS v(bucket,revision) SELECT DISTINCT block/10000,1 FROM raw_seal_rows ON CONFLICT(bucket) DO UPDATE SET revision=v.revision+1`);
        }
        await tx.sql.query(`INSERT INTO engine_activity_changes(source,coins,blocks)
          SELECT $1,array_agg(coin ORDER BY coin),array_agg(block ORDER BY coin) FROM (SELECT ${key} AS coin,min(block) AS block FROM raw_seal_rows GROUP BY ${key})k
          WHERE EXISTS(SELECT 1 FROM engine_activity_feed WHERE seen_at>now()-interval '1 day') HAVING count(*)>0`,[table]);
        const totals=(await tx.sql.query<{rows:string;high:string}>('SELECT count(*) AS rows,coalesce(max(block),-1) AS high FROM raw_seal_rows')).rows[0]!;
        await tx.sql.query(`UPDATE raw_history_seal_days SET last_coin=$4,coins=coins+$5,rows=rows+$6,through_block=greatest(through_block,$7)
          WHERE name=$1 AND partition_name=$2 AND day=$3`,[table,partition,day,coins.at(-1),coins.length,totals.rows,totals.high]);
        await tx.sql.query(`UPDATE raw_history_seals SET rows=rows+$3,through_block=greatest(through_block,$4) WHERE name=$1 AND partition_name=$2`,[table,partition,totals.rows,totals.high]);
        return {day:day.toISOString().slice(0,10),coins:Number(cursor.coins)+coins.length,rows:Number(totals.rows)};
      });
      if(!progress)break;
      options.onProgress?.({...progress,seconds:(performance.now()-started)/1000});
    }
    time=+end;
  }
  return sealTx(db,async tx=>(await tx.sql.query<RawSeal>('UPDATE raw_history_seals SET sealed=true WHERE name=$1 AND partition_name=$2 RETURNING *',[table,partition])).rows[0]!);
}

async function sealTransfers(db: ChainDb) {
  await db.sql.query(`INSERT INTO coin_holder_checkpoints(coin,block,data)
    SELECT t.coin,k.block,coalesce(jsonb_object_agg(encode(h.holder,'hex'),jsonb_build_object('amount',h.amount::text,'block',h.block::text)) FILTER(WHERE h.holder IS NOT NULL),'{}')
    FROM raw_seal_coins t JOIN (SELECT coin,block FROM raw_seal_cuts UNION SELECT coin,prior FROM raw_seal_cuts WHERE prior IS NOT NULL)k USING(coin)
    LEFT JOIN LATERAL(SELECT holder,sum(amount) AS amount,max(block) AS block FROM (
      SELECT to_address AS holder,amount,block FROM raw_history_live_transfers WHERE token=t.coin AND block<=k.block AND kind='Transfer'
      UNION ALL SELECT from_address,-amount,block FROM raw_history_live_transfers WHERE token=t.coin AND block<=k.block AND kind='Transfer'
      UNION ALL SELECT holder,amount,through_block FROM transfer_baselines WHERE token=t.coin AND through_block<=k.block
    )a GROUP BY holder HAVING sum(amount)>0)h ON true
    WHERE k.block<=(SELECT max(block) FROM raw_seal_rows WHERE token=t.coin) GROUP BY t.coin,k.block ON CONFLICT DO NOTHING`);
  await db.sql.query(`INSERT INTO transfer_baselines(token,holder,amount,through_block)
    SELECT token,holder,sum(amount),max(block) FROM (
      SELECT token,to_address AS holder,amount,block FROM raw_seal_rows WHERE kind='Transfer'
      UNION ALL SELECT token,from_address,-amount,block FROM raw_seal_rows WHERE kind='Transfer'
    )a GROUP BY token,holder ORDER BY token,holder ON CONFLICT(token,holder) DO UPDATE SET
    amount=transfer_baselines.amount+excluded.amount,through_block=greatest(transfer_baselines.through_block,excluded.through_block)`);
  await db.sql.query(`INSERT INTO coin_lifetime(coin,data,opening_holdings,graduation_holdings)
    SELECT coin,data,opening_holdings,graduation_holdings FROM raw_seal_coins ON CONFLICT(coin) DO UPDATE SET
    opening_holdings=coalesce(coin_lifetime.opening_holdings,excluded.opening_holdings),graduation_holdings=coalesce(coin_lifetime.graduation_holdings,excluded.graduation_holdings),revision=coin_lifetime.revision+1`);
}
async function sealSwaps(db: ChainDb, seal: RawSeal, options: RawSealOptions) {
  // Preserve only the watcher fields that cannot be reconstructed from coin aggregates.
  // Publication is atomic with the existing day/coin checkpoint and its live-source fence.
  await db.sql.query(`INSERT INTO watcher_swap_evidence(ts,tx_hash,log_index,block,coin,pool_id,trader,side,usd,priced_block,senders_pending,pricing_pending,tx_to,quote_asset,amount_quote)
    SELECT ts,tx_hash,log_index,block,coin,pool_id,trader,side,usd,priced_block,senders_pending,pricing_pending,tx_to,quote_asset,amount_quote FROM raw_seal_rows WHERE ts>=$1::timestamptz
    ON CONFLICT DO NOTHING`,[new Date(Math.floor(+(options.now ?? new Date())/86400000)*86400000-7*86400000)]);
  await db.sql.query(`ALTER TABLE raw_seal_coins ADD COLUMN identity jsonb`);
  await db.sql.query(`UPDATE raw_seal_coins c SET identity=jsonb_build_object('deployer',coalesce('0x'||encode(c.deployer,'hex'),''),'firstBlock',coalesce(c.first_block,0),
    'createdSec',coalesce(extract(epoch FROM c.created),0),'firstBlocks',$1::integer,'cohortSec',$2::integer,'pools',coalesce((SELECT jsonb_agg('0x'||encode(p.id,'hex')) FROM pools p WHERE p.currency0=c.coin OR p.currency1=c.coin),'[]')||$3::jsonb)`,[options.firstBlocks ?? 35,options.cohortSec ?? 60,JSON.stringify(options.poolManager?[options.poolManager.toLowerCase()]:[])]);
  await db.sql.query(`UPDATE raw_seal_coins c SET data=c.data||jsonb_build_object('graduation',jsonb_build_object('block',c.graduated_block,'atSec',extract(epoch FROM e.ts),
    'first',${packed('f')},'count',0,'missing',0,'volume',0,'missingVolume',0,'unknown',0,'actors','{}'::jsonb)||
      CASE WHEN b.block IS NOT NULL THEN jsonb_build_object('before',${packed('b')}) WHEN c.data->'last' IS NOT NULL THEN jsonb_build_object('before',c.data->'last') ELSE '{}'::jsonb END)
    FROM engine_block_times e,raw_seal_coins t
    CROSS JOIN LATERAL(SELECT s.* FROM raw_history_live_swaps s WHERE s.coin=t.coin AND s.block>=t.graduated_block AND s.venue<>'pons_curve' ORDER BY block,log_index,tx_hash LIMIT 1)f
    LEFT JOIN LATERAL(SELECT s.* FROM raw_history_live_swaps s WHERE s.coin=t.coin AND s.block<t.graduated_block ORDER BY block DESC,log_index DESC,tx_hash DESC LIMIT 1)b ON true
    WHERE c.coin=t.coin AND e.number=c.graduated_block AND c.data->'graduation' IS NULL`);
  await db.sql.query(`INSERT INTO reference_price_baselines(pool_id,coin,quote_asset,block,log_index,price_quote)
    SELECT DISTINCT ON(pool_id,coin,quote_asset) pool_id,coin,quote_asset,block,log_index,price_quote FROM raw_seal_rows s
    WHERE price_quote>0 AND price_quote<'Infinity'::double precision AND EXISTS(SELECT 1 FROM eth_usd_reference_sources r WHERE r.pool_id=s.pool_id)
    ORDER BY pool_id,coin,quote_asset,block DESC,log_index DESC ON CONFLICT(pool_id,coin,quote_asset) DO UPDATE SET
    block=excluded.block,log_index=excluded.log_index,price_quote=excluded.price_quote WHERE (excluded.block,excluded.log_index)>(reference_price_baselines.block,reference_price_baselines.log_index)`);
  await db.sql.query(`INSERT INTO coin_outcome_hours(coin,block,total,missing,volume,missing_volume,unknown)
    SELECT c.coin,c.block,count(*),count(*) FILTER(WHERE s.trader IS NULL OR s.senders_pending),coalesce(sum(s.usd),0),
    coalesce(sum(s.usd) FILTER(WHERE s.trader IS NULL OR s.senders_pending),0),count(*) FILTER(WHERE (s.trader IS NULL OR s.senders_pending) AND s.usd IS NULL)
    FROM raw_seal_cuts c JOIN raw_seal_rows s ON s.coin=c.coin AND s.block<=c.block AND s.ts>c.ts-interval '1 hour' GROUP BY c.coin,c.block
    ON CONFLICT(coin,block) DO UPDATE SET total=coin_outcome_hours.total+excluded.total,missing=coin_outcome_hours.missing+excluded.missing,
    volume=coin_outcome_hours.volume+excluded.volume,missing_volume=coin_outcome_hours.missing_volume+excluded.missing_volume,unknown=coin_outcome_hours.unknown+excluded.unknown`);
  await foldLifetimeBatch(db,seal,options);
  await sealBars(db);
  await sealGradePrices(db,seal,options.now ?? new Date());
  // Publish hot buyer projections only after all long folds/scans finish. The retained-firsts trigger's
  // maintenance branch avoids one heavyweight advisory lock per coin; atomic earliest-event upserts suffice.
  await db.sql.query('SELECT read_lock_coins(coalesce(array_agg(coin ORDER BY coin),ARRAY[]::bytea[])) FROM raw_seal_coins');
  await db.sql.query("SELECT set_config('eko.raw_partition_seal','on',true)");
  await db.sql.query(`INSERT INTO coin_buyer_firsts(coin,trader,first_block,pool_id,tx_hash,log_index)
    SELECT DISTINCT ON(coin,trader) coin,trader,block,pool_id,tx_hash,log_index FROM raw_seal_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending
    ORDER BY coin,trader,block,tx_hash,log_index ON CONFLICT(coin,trader) DO UPDATE SET first_block=excluded.first_block,pool_id=excluded.pool_id,tx_hash=excluded.tx_hash,log_index=excluded.log_index
    WHERE (excluded.first_block,excluded.tx_hash,excluded.log_index)<(coin_buyer_firsts.first_block,coin_buyer_firsts.tx_hash,coin_buyer_firsts.log_index)`);
  await db.sql.query(`INSERT INTO read_buyers(coin,trader) SELECT DISTINCT coin,trader FROM raw_seal_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending ON CONFLICT DO NOTHING`);
  await db.sql.query(`INSERT INTO coin_unknown_buys(coin,block,n) SELECT coin,block,count(*) FROM raw_seal_rows WHERE side=1 AND (trader IS NULL OR senders_pending)
    GROUP BY coin,block ON CONFLICT(coin,block) DO UPDATE SET n=coin_unknown_buys.n+excluded.n`);

  await db.sql.query(`INSERT INTO read_buyer_firsts(coin,trader,first_block,pool_id,tx_hash,log_index)
    SELECT DISTINCT ON(coin,trader) coin,trader,block,pool_id,tx_hash,log_index FROM raw_seal_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending
    ORDER BY coin,trader,block,tx_hash,log_index ON CONFLICT(coin,trader) DO UPDATE SET first_block=excluded.first_block,pool_id=excluded.pool_id,tx_hash=excluded.tx_hash,log_index=excluded.log_index
    WHERE (excluded.first_block,excluded.tx_hash,excluded.log_index)<(read_buyer_firsts.first_block,read_buyer_firsts.tx_hash,read_buyer_firsts.log_index)`);
  // Parent DELETE no longer fires watcher_schedule_delete: subtract the sealed unknowns from its raw lane.
  await db.sql.query(`INSERT INTO read_unknown_buys(coin,block,n) SELECT coin,block,-count(*) FROM raw_seal_rows WHERE side=1 AND (trader IS NULL OR senders_pending)
    GROUP BY coin,block ON CONFLICT(coin,block) DO UPDATE SET n=read_unknown_buys.n+excluded.n`);
  await db.sql.query(`INSERT INTO history_prunes(coin,rule,through_block,swaps_through_block,first_trade_ts,last_trade_ts,buyers,swaps,buyer_stats_complete)
    SELECT s.coin,'raw_cap',max(s.block),max(s.block),min(s.ts),max(s.ts),
      (SELECT count(*) FROM coin_buyer_firsts WHERE coin=s.coin)+(SELECT coalesce(sum(n),0) FROM coin_unknown_buys WHERE coin=s.coin),count(*),true
    FROM raw_seal_rows s GROUP BY s.coin ON CONFLICT(coin) DO UPDATE SET through_block=greatest(history_prunes.through_block,excluded.through_block),
    swaps_through_block=greatest(history_prunes.swaps_through_block,excluded.swaps_through_block),first_trade_ts=least(history_prunes.first_trade_ts,excluded.first_trade_ts),
    last_trade_ts=greatest(history_prunes.last_trade_ts,excluded.last_trade_ts),buyers=excluded.buyers,swaps=history_prunes.swaps+excluded.swaps,buyer_stats_complete=true,updated_at=now()`);

}
/** The original reducer avoids repeatedly copying growing JSONB state on every event. */
async function foldLifetimeBatch(db:ChainDb,seal:RawSeal,options:RawSealOptions) {
  const coins=(await db.sql.query<{coin:Uint8Array;data:Lifetime;identity:Omit<LifetimeIdentity,'pools'>&{pools:string[]}}>('SELECT coin,data,identity FROM raw_seal_coins ORDER BY coin')).rows;
  const checkpointBefore=options.checkpointBefore ?? options.tsBefore ?? new Date(+(options.now ?? new Date())-Number(process.env.RETENTION_SWAP_DAYS ?? 1)*86400000);
  const summaries:unknown[]=[];
  const checkpoints:unknown[]=[];
  for(const coin of coins) {
    const cuts=(await db.sql.query<{block:string;hour:Lifetime['checkpointHour']}>(`SELECT c.block::text,jsonb_build_object('totalCount',coalesce(h.total,0),'unattributedCount',coalesce(h.missing,0),
      'totalVolumeUsd',coalesce(h.volume,0),'unattributedVolumeUsd',coalesce(h.missing_volume,0),'unknownVolumeCount',coalesce(h.unknown,0)) AS hour
      FROM raw_seal_cuts c LEFT JOIN coin_outcome_hours h USING(coin,block) WHERE c.coin=$1 AND c.ts<$3
      AND coalesce(($4::jsonb->'last'->>'block')::bigint,-1)<=c.block
      AND NOT EXISTS(SELECT 1 FROM raw_history_live_swaps s WHERE s.coin=c.coin AND s.block<=c.block AND s.ts>=$2)
      ORDER BY c.block`,[coin.coin,seal.end_ts,checkpointBefore,JSON.stringify(coin.data)])).rows;
    const identity={...coin.identity,pools:new Set(coin.identity.pools)};
    // Read from the indexed batch in key order. Each coin is packed once; checkpoint folds share its prefix.
    const rows=(await db.sql.query<Record<string,unknown>>('SELECT * FROM raw_seal_rows WHERE coin=$1 ORDER BY block,log_index,tx_hash',[coin.coin])).rows.map(packSwap);
    let offset=0;
    for(const cut of cuts) {
      let end=offset;while(end<rows.length && BigInt(rows[end]!.block)<=BigInt(cut.block))end++;
      addLifetimeSwaps(coin.data,rows.slice(offset,end),identity);offset=end;
      checkpoints.push({coin:Buffer.from(coin.coin).toString('hex'),block:cut.block,data:{...structuredClone(coin.data),checkpointHour:cut.hour}});
    }
    addLifetimeSwaps(coin.data,rows.slice(offset),identity);
    summaries.push({coin:Buffer.from(coin.coin).toString('hex'),data:coin.data});
  }
  if(checkpoints.length)await db.sql.query(`INSERT INTO coin_lifetime_checkpoints(coin,block,data)
    SELECT decode(x.coin,'hex'),x.block,x.data FROM jsonb_to_recordset($1::jsonb)x(coin text,block bigint,data jsonb) ON CONFLICT DO NOTHING`,[JSON.stringify(checkpoints)]);
  await db.sql.query(`INSERT INTO coin_lifetime(coin,data,opening_holdings,graduation_holdings)
    SELECT t.coin,x.data,t.opening_holdings,t.graduation_holdings FROM jsonb_to_recordset($1::jsonb)x(coin text,data jsonb)
    JOIN raw_seal_coins t ON t.coin=decode(x.coin,'hex') ON CONFLICT(coin) DO UPDATE SET data=excluded.data,
    opening_holdings=coalesce(coin_lifetime.opening_holdings,excluded.opening_holdings),graduation_holdings=coalesce(coin_lifetime.graduation_holdings,excluded.graduation_holdings),revision=coin_lifetime.revision+1`,[JSON.stringify(summaries)]);
}
async function sealBars(db: ChainDb) {
  await db.sql.query(`CREATE TEMP TABLE raw_seal_bar_rows ON COMMIT DROP AS SELECT s.* FROM
    (SELECT DISTINCT coin,date_trunc('minute',ts) AS minute FROM raw_seal_rows)k
    CROSS JOIN LATERAL(SELECT s.* FROM raw_history_live_swaps s WHERE s.coin=k.coin AND s.ts>=k.minute AND s.ts<k.minute+interval '1 minute' OFFSET 0)s`);
  await db.sql.query(`INSERT INTO bars_1m(coin,minute,open,high,low,close,volume_usd,trades,first_block,last_block)
    SELECT coin,date_trunc('minute',ts),(array_agg(price ORDER BY ts,block,log_index,tx_hash))[1],max(price),min(price),
    (array_agg(price ORDER BY ts DESC,block DESC,log_index DESC,tx_hash DESC))[1],sum(usd),count(*),min(block),max(block)
    FROM (SELECT s.*,s.usd/(s.amount_coin::double precision/power(10,t.decimals)) AS price FROM raw_seal_bar_rows s JOIN tokens t ON t.address=s.coin
      WHERE s.usd>0 AND s.amount_coin>0 AND t.decimals IS NOT NULL AND (t.launchpad IS DISTINCT FROM 'pons' OR
        (s.venue='pons_curve' AND (t.graduated_block IS NULL OR s.block<t.graduated_block)) OR (s.venue<>'pons_curve' AND t.graduated_block IS NOT NULL AND s.block>=t.graduated_block)))p
    WHERE NOT EXISTS(SELECT 1 FROM raw_history_bar_keys k WHERE k.coin=p.coin AND k.minute=date_trunc('minute',p.ts)) GROUP BY coin,date_trunc('minute',ts)
    ON CONFLICT(coin,minute) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume_usd=excluded.volume_usd,trades=excluded.trades,first_block=excluded.first_block,last_block=excluded.last_block`);
  await db.sql.query(`INSERT INTO raw_history_bar_keys SELECT DISTINCT coin,date_trunc('minute',ts) FROM raw_seal_rows ON CONFLICT DO NOTHING`);
}
/** Session-local inputs survive batch commits; only queue deletions are the durable resume cursor. */
export async function sealRankings(db: ChainDb, seal: RawSeal) {
  let failed=false;
  try {
    const queued=await sealTx(db,async tx=>{
      await tx.sql.query(`CREATE TEMP TABLE raw_seal_rankings ON COMMIT PRESERVE ROWS AS
        SELECT q.created_block,coalesce(e.ts,c.ts) AS ts FROM trending_snapshot_queue q
        LEFT JOIN engine_block_times e ON e.number=q.created_block LEFT JOIN chain_blocks c ON c.number=q.created_block
        WHERE coalesce(e.ts,c.ts)<$1::timestamptz+interval '1 hour'`,[seal.end_ts]);
      await tx.sql.query('CREATE UNIQUE INDEX ON raw_seal_rankings(created_block)');
      return (await tx.sql.query<{n:string}>('SELECT count(*) AS n FROM raw_seal_rankings')).rows[0]!.n;
    });
    if(!Number(queued))return;
    await sealTx(db,async tx=>{
      // Read the live view once for the needed span, including both partial window minutes.
      // Keep source order for the final float8 SUM: summing rounded minute totals changes volume text.
      await tx.sql.query(`CREATE TEMP TABLE raw_seal_ranking_rows ON COMMIT PRESERVE ROWS AS
        SELECT s.coin,s.ts,s.block,s.usd,row_number() OVER() AS ordinal FROM raw_history_live_swaps s
        WHERE s.ts>(SELECT min(ts) FROM raw_seal_rankings)-interval '1 hour'
          AND s.ts<=(SELECT max(ts) FROM raw_seal_rankings)+interval '1 second' AND s.usd>0`);
      await tx.sql.query('CREATE INDEX ON raw_seal_ranking_rows(coin,ts)');
      await tx.sql.query('CREATE INDEX ON raw_seal_ranking_rows(ts)');
      await tx.sql.query(`CREATE TEMP TABLE raw_seal_ranking_minutes ON COMMIT PRESERVE ROWS AS
        SELECT coin,date_trunc('minute',ts) AS minute,min(ts) AS started,sum(usd) AS volume,count(*) AS n,
          min(block) AS low_block,max(block) AS high_block FROM raw_seal_ranking_rows GROUP BY coin,date_trunc('minute',ts)`);
      await tx.sql.query('CREATE INDEX ON raw_seal_ranking_minutes(minute)');
      await tx.sql.query('ANALYZE raw_seal_ranking_rows');
      await tx.sql.query('ANALYZE raw_seal_ranking_minutes');
    });
    while(true) {
      const count=await sealTx(db,async tx=>{
        await tx.sql.query(`CREATE TEMP TABLE raw_seal_ranking_batch ON COMMIT DROP AS
          SELECT * FROM raw_seal_rankings ORDER BY created_block LIMIT 32`);
        const n=Number((await tx.sql.query<{n:string}>('SELECT count(*) AS n FROM raw_seal_ranking_batch')).rows[0]!.n);
        if(!n)return 0;
        await tx.sql.query(`INSERT INTO trending_snapshots(created_block,data)
          SELECT q.created_block,coalesce(jsonb_agg(x.data ORDER BY x.volume DESC,x.coin) FILTER(WHERE x.coin IS NOT NULL),'[]')
          FROM raw_seal_ranking_batch q LEFT JOIN LATERAL(
            WITH pieces AS MATERIALIZED (
              SELECT m.coin,m.started,m.volume,m.n FROM raw_seal_ranking_minutes m
              WHERE m.minute>q.ts-interval '1 hour' AND m.minute<=q.ts+interval '1 second'-interval '1 minute' AND m.high_block<=q.created_block
              UNION ALL
              SELECT s.coin,min(s.ts),sum(s.usd),count(*) FROM raw_seal_ranking_minutes m
              CROSS JOIN LATERAL(SELECT s.coin,s.ts,s.usd FROM raw_seal_ranking_rows s
                WHERE s.coin=m.coin AND s.ts>=m.minute AND s.ts<m.minute+interval '1 minute'
                  AND s.ts>q.ts-interval '1 hour' AND s.ts<=q.ts+interval '1 second' AND s.block<=q.created_block OFFSET 0)s
              WHERE m.minute>=date_trunc('minute',q.ts-interval '1 hour') AND m.minute<=q.ts+interval '1 second'
                AND m.low_block<=q.created_block AND (m.minute<=q.ts-interval '1 hour'
                  OR m.minute+interval '1 minute'>q.ts+interval '1 second' OR m.high_block>q.created_block)
              GROUP BY s.coin
            ), volumes AS MATERIALIZED (
              SELECT p.coin,min(p.started) AS started,sum(p.volume) AS volume,
                least(0.5,sum(p.n)*8.881784197001252e-16)::double precision AS error
              FROM pieces p JOIN tokens t ON t.address=p.coin JOIN engine_block_times e ON e.number=t.first_block
              WHERE t.name IS NOT NULL AND t.symbol IS NOT NULL GROUP BY p.coin
            ), bounds AS MATERIALIZED (
              SELECT *,volume/(1+error) AS lower,volume/(1-error) AS upper FROM volumes
            ), cutoff AS (
              SELECT min(lower) AS volume FROM (SELECT lower FROM bounds ORDER BY lower DESC LIMIT 50)b
            ), exact AS MATERIALIZED (
              -- Positive volumes have a bounded relative summation error. Include every possible
              -- top-50 contender (including ties), then preserve source float sums and ordering.
              SELECT v.coin,v.started,(SELECT sum(s.usd ORDER BY s.ordinal) FROM raw_seal_ranking_rows s
                WHERE s.coin=v.coin AND s.ts>q.ts-interval '1 hour' AND s.ts<=q.ts+interval '1 second' AND s.block<=q.created_block) AS volume
              FROM bounds v WHERE v.upper>=(SELECT volume FROM cutoff)
            )
            SELECT v.coin,v.volume,jsonb_build_object('coin','0x'||encode(v.coin,'hex'),'name',t.name,'symbol',t.symbol,
              'created',to_char(e.ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'started',to_char(v.started AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'volume',v.volume::text) AS data
            FROM exact v JOIN tokens t ON t.address=v.coin JOIN engine_block_times e ON e.number=t.first_block
            ORDER BY v.volume DESC,v.coin LIMIT 50
          )x ON true GROUP BY q.created_block ON CONFLICT DO NOTHING`);
        await tx.sql.query('DELETE FROM trending_snapshot_queue WHERE created_block IN(SELECT created_block FROM raw_seal_ranking_batch)');
        await tx.sql.query('DELETE FROM raw_seal_rankings WHERE created_block IN(SELECT created_block FROM raw_seal_ranking_batch)');
        return n;
      });
      if(!count)break;
    }
  } catch(error) { failed=true; throw error; } finally {
    try {
      await retentionPhase('trending_snapshot_cleanup', () => sealTx(db,tx=>tx.sql.query(
        'DROP TABLE IF EXISTS pg_temp.raw_seal_rankings,pg_temp.raw_seal_ranking_rows,pg_temp.raw_seal_ranking_minutes')));
    } catch(error) { if(!failed)throw error; }
  }
}
async function sealGradePrices(db: ChainDb, seal: RawSeal, now: Date) {
  await db.sql.query(`INSERT INTO retention_grade_prices(coin,since,horizon_sec,graded_at,level,p0,p1,hi)
    SELECT t.coin,c.since,h.sec,g.ts,g.level,
      (SELECT s.usd/s.amount_coin::double precision FROM raw_history_live_swaps s WHERE s.coin=t.coin AND s.ts<=g.ts AND s.ts>g.ts-interval '1 hour' AND s.usd>0 AND s.amount_coin>0 ORDER BY s.ts DESC LIMIT 1),
      (SELECT s.usd/s.amount_coin::double precision FROM raw_history_live_swaps s WHERE s.coin=t.coin AND s.ts<=g.ts+h.sec*interval '1 second' AND s.usd>0 AND s.amount_coin>0 ORDER BY s.ts DESC LIMIT 1),
      (SELECT max(s.usd/s.amount_coin::double precision) FROM raw_history_live_swaps s WHERE s.coin=t.coin AND s.ts>g.ts AND s.ts<=g.ts+h.sec*interval '1 second' AND s.usd>0 AND s.amount_coin>0)
    FROM raw_seal_coins t CROSS JOIN unnest($1::timestamptz[])c(since) CROSS JOIN (VALUES(3600),(86400))h(sec)
    CROSS JOIN LATERAL(SELECT v.id,b.ts,v.data->>'level' AS level FROM (
      SELECT v.valid_from_block FROM verdicts v WHERE v.coin=t.coin AND v.valid_from_block>=(SELECT number FROM engine_block_times WHERE ts>=c.since ORDER BY ts,number LIMIT 1)
      AND v.data->>'level' IN('clear','monitor','danger') AND EXISTS(SELECT 1 FROM engine_block_times b WHERE b.number=v.valid_from_block AND b.ts>=c.since) ORDER BY valid_from_block LIMIT 1
    )f JOIN verdicts v ON v.coin=t.coin AND v.valid_from_block=f.valid_from_block JOIN engine_block_times b ON b.number=v.valid_from_block LEFT JOIN receipt_publications p ON p.id=v.id
    WHERE v.data->>'level' IN('clear','monitor','danger') ORDER BY p.publication_sequence ASC NULLS FIRST,v.id LIMIT 1)g
    WHERE g.ts<$3 AND g.ts<$2::timestamptz+interval '1 hour' ON CONFLICT(coin,since,horizon_sec) DO UPDATE SET
      p0=coalesce(retention_grade_prices.p0,excluded.p0),p1=coalesce(excluded.p1,retention_grade_prices.p1),hi=greatest(retention_grade_prices.hi,excluded.hi)`,[GRADE_CUTS,seal.end_ts,now]);
}
