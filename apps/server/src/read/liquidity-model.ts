import { binary, hex, type ChainDb } from '@eko/db';
import { CoinCardSchema, type Address } from '@eko/shared';
import { limitRefresh } from './refresh-limits.js';
import { curveState, poolValueUsd, positionQuote } from './pool-liquidity.js';

const LiquidityCardSchema=CoinCardSchema.pick({liquidity:true,meta:true}).partial();
interface Trade {pool_id:string;amount_coin:string;amount_quote:string;usd:number;block:number|string;log_index:number;tx_hash:string}
interface PoolInput {id:string;coinFirst:boolean;full:number|null;seen:boolean;positions:{lower:number;upper:number;liquidity:number}[]}
interface InputRow {
  address:Uint8Array;graduated_block:string|null;graduated_pool:Uint8Array|null;launchpad:string|null;curve:Uint8Array|null;
  total_supply:string|null;data:unknown;revision:string;signature:string;saved_revision:string|null;saved_signature:string|null;
  inputs:PoolInput[]|null;threshold:string|null;retained:Trade|null;retained_prices:Record<string,Trade>|null;
}
export const LIQUIDITY_PROBE_KEYS=100;
/** Pool prices are primary-key reads. Empty pool_id is the maintained coin-wide curve price.
 * A missing key examines at most the newest 200 positive trades, including the pool filter before LIMIT 1.
 */
export const LIQUIDITY_PRICE_SQL=`WITH keys AS (
  SELECT k->>'coin' AS coin,k->>'pool' AS pool,decode(substring(k->>'coin' FROM 3),'hex') AS coin_key,
    decode(substring(k->>'pool' FROM 3),'hex') AS pool_key FROM jsonb_array_elements($1::jsonb) k
)
SELECT k.coin,k.pool,to_jsonb(s) AS trade FROM keys k
LEFT JOIN coin_pool_prices p ON p.coin=k.coin_key AND p.pool_id=coalesce(k.pool_key,''::bytea) AND p.valid
LEFT JOIN LATERAL (
  SELECT r.* FROM (
    SELECT s.pool_id,s.amount_coin,s.amount_quote,s.usd,s.block,s.log_index,s.tx_hash FROM swaps s
    WHERE p.coin IS NULL AND s.coin=k.coin_key AND s.usd>0 AND s.amount_coin>0 AND s.amount_quote>0
    ORDER BY s.block DESC,s.log_index DESC,s.tx_hash DESC LIMIT 200
  ) r WHERE k.pool_key IS NULL OR r.pool_id=k.pool_key
  ORDER BY r.block DESC,r.log_index DESC,r.tx_hash DESC LIMIT 1
) f ON true
LEFT JOIN LATERAL (
  SELECT '0x'||encode(coalesce(p.trade_pool_id,f.pool_id),'hex') AS pool_id,
    coalesce(p.amount_coin,f.amount_coin)::text AS amount_coin,coalesce(p.amount_quote,f.amount_quote)::text AS amount_quote,
    coalesce(p.usd,f.usd) AS usd,coalesce(p.block,f.block)::text AS block,coalesce(p.log_index,f.log_index) AS log_index,
    '0x'||encode(coalesce(p.tx_hash,f.tx_hash),'hex') AS tx_hash
  WHERE p.coin IS NOT NULL OR f.block IS NOT NULL
) s ON true`;

/** Read and value every source before acquiring any projection mutex. */
export async function prepareLiquidityModels(db:ChainDb,coins:Address[],_now:number,probeKeys=LIQUIDITY_PROBE_KEYS) {
  if(!Number.isInteger(probeKeys) || probeKeys<1 || probeKeys>1000)throw new Error('Liquidity probe key limit must be between 1 and 1000');
  const keys=coins.map(binary);
  const revisions=(await db.sql.query<{coin:Uint8Array;revision:string|null}>(`SELECT k.coin,d.revision::text AS revision
    FROM unnest($1::bytea[]) k(coin) LEFT JOIN read_dirty d ON d.coin=k.coin`,[keys])).rows
    .map(r=>({coin:'\\x'+hex(r.coin).slice(2),revision:r.revision}));
  const rows=(await db.sql.query<InputRow>(`
    SELECT t.address,t.graduated_block,t.graduated_pool,t.launchpad,t.curve,t.total_supply,
      c.data AS data,
      coalesce(v.revision,0)::text AS revision,coalesce(encode(t.graduated_pool,'hex'),'') AS signature,
      i.revision::text AS saved_revision,i.signature AS saved_signature,i.data AS inputs,
      coalesce(e.data->>'graduationThreshold',life.data->'curve'->>'launchThreshold') AS threshold,
      life.data->'lastPositivePriced' AS retained,rp.prices AS retained_prices
    FROM tokens t LEFT JOIN read_liquidity_versions v ON v.coin=t.address
    LEFT JOIN read_liquidity_inputs i ON i.coin=t.address LEFT JOIN coin_card_latest c ON c.coin=t.address
    LEFT JOIN coin_lifetime life ON life.coin=t.address LEFT JOIN read_liquidity_retained rp ON rp.coin=t.address
    LEFT JOIN LATERAL (SELECT data FROM pons_events WHERE token=t.address AND kind='launch' ORDER BY block,log_index LIMIT 1) e ON true
    WHERE t.address=ANY($1::bytea[])`,[keys])).rows;
  const due=rows.filter(t=>t.saved_revision!==t.revision || t.saved_signature!==t.signature);
  if(due.length) {
    // Only liquidity/pool revisions (and a changed graduation reference) enter this query. Never run it for a trade.
    const inputs=(await db.sql.query<{coin:Uint8Array;inputs:PoolInput[]}>(`
      SELECT t.address AS coin,coalesce(jsonb_agg(jsonb_build_object('id','0x'||encode(p.id,'hex'),'coinFirst',p.currency0=t.address,
        'full',CASE WHEN f.liquidity IS NOT NULL OR kept.full IS NOT NULL THEN coalesce(f.liquidity,0)+coalesce(kept.full,0) END,'seen',coalesce(m.seen,false) OR kept.positions IS NOT NULL,'positions',coalesce(m.positions,'[]')||coalesce(kept.positions,'[]'))) FILTER(WHERE p.id IS NOT NULL),'[]') AS inputs
      FROM tokens t LEFT JOIN LATERAL (SELECT id,currency0,currency1 FROM pools WHERE currency0=t.address UNION SELECT id,currency0,currency1 FROM pools WHERE currency1=t.address
        UNION SELECT id,currency0,currency1 FROM pools WHERE id=t.graduated_pool
        UNION SELECT t.graduated_pool,t.address,NULL::bytea WHERE t.graduated_pool IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pools WHERE id=t.graduated_pool)) p ON true
      LEFT JOIN LATERAL (SELECT sum(liquidity) FILTER(WHERE kind='ModifyLiquidity' AND n_amount>0 AND nullif(lower_tick,'')::int<=-887000 AND nullif(upper_tick,'')::int>=887000)::float8 AS liquidity
        FROM read_pool_positions WHERE pool_id=p.id AND n>0) f ON true
      LEFT JOIN LATERAL (SELECT bool_or(n>0) AS seen,jsonb_agg(jsonb_build_object('lower',nullif(lower_tick,'')::int,'upper',nullif(upper_tick,'')::int,'liquidity',liquidity::float8)) FILTER(WHERE n>0) AS positions
        FROM read_pool_positions WHERE pool_id=p.id) m ON true
      LEFT JOIN LATERAL (SELECT
        (SELECT jsonb_agg(jsonb_build_object('lower',(v->>'lower')::int,'upper',(v->>'upper')::int,'liquidity',(v->>'liquidity')::float8)) FROM jsonb_each(l.data->'liquidity'->('0x'||encode(p.id,'hex'))->'moneyPositions') x(k,v)) AS positions,
        (l.data->'liquidity'->('0x'||encode(p.id,'hex'))->>'fullRangeDelta')::float8 AS full
        FROM coin_lifetime l WHERE l.coin IN(p.currency0,p.currency1,t.address) AND l.data->'liquidity' ? ('0x'||encode(p.id,'hex')) ORDER BY (l.coin=t.address) DESC LIMIT 1) kept ON true
      WHERE t.address=ANY($1::bytea[]) GROUP BY t.address`,[due.map(t=>t.address)])).rows;
    // Combine live and retained deltas by range before valuation. Burns may cancel a retained position.
    const byCoin=new Map(inputs.map(r=>[hex(r.coin),r.inputs]));
    for(const row of due) {
      row.inputs=byCoin.get(hex(row.address)) ?? [];
      for(const p of row.inputs) {
        const ranges=new Map<string,{lower:number;upper:number;liquidity:number}>();
        for(const r of p.positions) {const k=`${r.lower}:${r.upper}`,prior=ranges.get(k);ranges.set(k,{...r,liquidity:r.liquidity+(prior?.liquidity ?? 0)});}
        p.positions=[...ranges.values()].filter(r=>r.liquidity>0);
      }
    }
  }
  // One indexed latest priced probe per known pool, or per curve. No 50/60-row merge or lifetime tail expansion.
  const probes=rows.flatMap<{coin:Address;pool:string|null}>(t=>t.graduated_block==null && t.launchpad==='pons' ? [{coin:hex(t.address),pool:null}] :
    (t.inputs ?? []).filter(p=>t.graduated_block==null || p.id===(t.graduated_pool ? hex(t.graduated_pool) : '')).map(p=>({coin:hex(t.address),pool:p.id})));
  const prices:{coin:string;pool:string|null;trade:Trade|null}[]=[];
  const unique=[...new Map(probes.map(p=>[`${p.coin}:${p.pool ?? ''}`,p])).values()];
  for(let offset=0;offset<unique.length;offset+=probeKeys) {
    prices.push(...(await db.sql.query<{coin:string;pool:string|null;trade:Trade|null}>(LIQUIDITY_PRICE_SQL,[JSON.stringify(unique.slice(offset,offset+probeKeys))])).rows);
  }
  const latest=new Map(prices.map(p=>[`${p.coin}:${p.pool ?? ''}`,p.trade]));
  const newer=(a:Trade|null|undefined,b:Trade|null|undefined)=>!a ? b : !b ? a :
    Number(a.block)!==Number(b.block) ? Number(a.block)>Number(b.block)?a:b : a.log_index!==b.log_index ? a.log_index>b.log_index?a:b : a.tx_hash>=b.tx_hash?a:b;
  const values=rows.map(t=>{
    const coin=hex(t.address),card=t.data ? LiquidityCardSchema.parse(t.data) : null;
    let usd:number|undefined,curvePct:number|null=null;
    if(t.graduated_block==null && t.launchpad==='pons') {
      const s=newer(latest.get(`${coin}:`),t.retained);
      const state=s ? curveState(Number(t.threshold),Number(t.total_supply),Number(s.amount_coin),Number(s.amount_quote),Number(s.usd)) : null;
      if(state) {usd=state.usd;curvePct=Math.round(state.curvePct*100)/100;}
    } else if(t.graduated_block!=null || t.curve==null)for(const p of t.inputs ?? []) {
      if(t.graduated_block!=null && p.id!==(t.graduated_pool ? hex(t.graduated_pool) : ''))continue;
      const s=newer(latest.get(`${coin}:${p.id}`),t.retained_prices?.[p.id]);
      if(!s || !(s.usd>0) || !(Number(s.amount_coin)>0) || !(Number(s.amount_quote)>0))continue;
      if(t.graduated_block!=null) {
        if(Number(s.block)<Number(t.graduated_block) || p.full==null)continue;
        usd=poolValueUsd(p.full,Number(s.amount_coin),Number(s.amount_quote),s.usd) ?? undefined;
      } else if(p.seen) {
        const sqrt=Math.sqrt(p.coinFirst ? Number(s.amount_quote)/Number(s.amount_coin) : Number(s.amount_coin)/Number(s.amount_quote));
        const quote=p.positions.reduce((sum,r)=>sum+positionQuote(r.liquidity,r.lower,r.upper,sqrt,p.coinFirst),0);
        const value=quote*s.usd/Number(s.amount_quote);
        if(Number.isFinite(value))usd=(usd ?? 0)+value;
      }
    }
    const unavailable=usd==null && (!card?.liquidity || !!card?.meta?.liquidity?.unavailable || !!card?.meta?.liquidity?.missing?.includes('depthUsd'));
    return {coin,usd:usd ?? (unavailable?0:card!.liquidity!.depthUsd.pct2),unavailable,curve_pct:curvePct};
  });
  const present=new Set(rows.map(t=>hex(t.address)));
  return {keys,values,revisions,inputs:due.map(t=>({coin:hex(t.address).slice(2),revision:t.revision,signature:t.signature,inputs:t.inputs})),
    missing:keys.filter(c=>!present.has(hex(c)))};
}
export type PreparedLiquidity=Awaited<ReturnType<typeof prepareLiquidityModels>>;

/** Only projection DML and payload decoding run under the mutex. No source-table lookups or triggers are used. */
export async function writeLiquidityModels(db:ChainDb,prepared:PreparedLiquidity,active:readonly Uint8Array[]=prepared.keys) {
  const allowed=new Set(active.map(hex));
  const values=prepared.values.filter(v=>allowed.has(v.coin));
  const inputs=prepared.inputs.filter(v=>allowed.has(`0x${v.coin}`));
  const missing=prepared.missing.filter(c=>allowed.has(hex(c)));
  await db.sql.query(`WITH eligible AS MATERIALIZED (
    SELECT r.coin FROM jsonb_to_recordset($4::jsonb) r(coin bytea,revision bigint) LEFT JOIN read_dirty d ON d.coin=r.coin
    WHERE r.revision IS NOT DISTINCT FROM d.revision
  ), saved AS (
    INSERT INTO read_liquidity_inputs(coin,revision,signature,data)
    SELECT decode(v->>'coin','hex'),(v->>'revision')::bigint,v->>'signature',v->'inputs' FROM jsonb_array_elements($2::jsonb) v
    WHERE decode(v->>'coin','hex') IN(SELECT coin FROM eligible) ORDER BY v->>'coin'
    ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,signature=excluded.signature,data=excluded.data
  ), gone_inputs AS (
    DELETE FROM read_liquidity_inputs r WHERE r.coin=ANY($3::bytea[]) AND r.coin IN(SELECT coin FROM eligible)
  ), gone AS (
    DELETE FROM read_coin_liquidity r WHERE r.coin=ANY($3::bytea[]) AND r.coin IN(SELECT coin FROM eligible)
  ) INSERT INTO read_coin_liquidity(coin,usd,unavailable,curve_pct)
    SELECT decode(substring(v->>'coin' FROM 3),'hex'),(v->>'usd')::float8,(v->>'unavailable')::boolean,(v->>'curve_pct')::float8
    FROM jsonb_array_elements($1::jsonb) v
    WHERE decode(substring(v->>'coin' FROM 3),'hex') IN(SELECT coin FROM eligible) ORDER BY v->>'coin'
    ON CONFLICT(coin) DO UPDATE SET usd=excluded.usd,unavailable=excluded.unavailable,curve_pct=excluded.curve_pct
    WHERE (read_coin_liquidity.usd,read_coin_liquidity.unavailable,read_coin_liquidity.curve_pct)
      IS DISTINCT FROM (excluded.usd,excluded.unavailable,excluded.curve_pct)`,[JSON.stringify(values),JSON.stringify(inputs),missing,JSON.stringify(prepared.revisions.filter(r=>allowed.has(`0x${r.coin.slice(2)}`)))]);
}

/** Standalone maintenance entry point. Preparation precedes the mutex, with deadlines on the entire transaction. */
export async function refreshLiquidityModels(db:ChainDb,coins:Address[],now:number,probeKeys=LIQUIDITY_PROBE_KEYS) {
  if(!coins.length)return;
  await db.tx(async tx=>{
    await limitRefresh(tx);
    const prepared=await prepareLiquidityModels(tx,coins,now,probeKeys);
    await tx.sql.query('SELECT read_lock_coins($1::bytea[])',[prepared.keys]);
    await writeLiquidityModels(tx,prepared);
  });
}
