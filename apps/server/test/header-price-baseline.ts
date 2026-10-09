/** Production query shapes before 0221, retained only for equivalence and offline timing. */
export const OLD_LIQUIDITY_PRICE_SQL=`WITH keys AS (
  SELECT k->>'coin' AS coin,k->>'pool' AS pool,decode(substring(k->>'coin' FROM 3),'hex') AS coin_key,
    decode(substring(k->>'pool' FROM 3),'hex') AS pool_key FROM jsonb_array_elements($1::jsonb) k
)
SELECT k.coin,k.pool,to_jsonb(s) AS trade FROM keys k LEFT JOIN LATERAL (
  SELECT '0x'||encode(r.pool_id,'hex') AS pool_id,r.amount_coin::text,r.amount_quote::text,r.usd,
    r.block::text AS block,r.log_index,'0x'||encode(r.tx_hash,'hex') AS tx_hash
  FROM (SELECT s.pool_id,s.amount_coin,s.amount_quote,s.usd,s.block,s.log_index,s.tx_hash FROM swaps s
    WHERE s.coin=k.coin_key AND s.usd>0 AND s.amount_coin>0 AND s.amount_quote>0
    ORDER BY s.block DESC,s.log_index DESC,s.tx_hash DESC OFFSET 0) r
  WHERE k.pool_key IS NULL OR r.pool_id=k.pool_key LIMIT 1
) s ON true`;


export const OLD_HEADER_COUNTS_SQL=`WITH cut AS (SELECT least((SELECT min(number) FROM engine_block_times WHERE ts>$1),(SELECT min(number) FROM chain_blocks WHERE ts>$1)) AS block), live AS (
 SELECT t.address AS coin FROM tokens t LEFT JOIN read_coins r ON r.coin=t.address CROSS JOIN cut
 WHERE CASE WHEN r.activity IS NOT NULL THEN r.activity>$1
 ELSE EXISTS(SELECT 1 FROM swaps s WHERE s.coin=t.address AND s.ts>$1) OR t.first_block>=cut.block END
), graded AS (
 SELECT CASE WHEN c.coin IS NULL THEN NULL WHEN rc.tier IS NOT NULL THEN (ARRAY['clear','monitor','pending','danger'])[rc.tier+1]
 ELSE c.data->'verdict'->>'level' END AS level,c.coin IS NULL AS bare
 FROM live r LEFT JOIN coin_card_latest c ON c.coin=r.coin LEFT JOIN read_coins rc ON rc.coin=r.coin)
SELECT count(*) AS coins,count(*) FILTER(WHERE level='clear') AS lower,count(*) FILTER(WHERE level='monitor') AS elevated,
 count(*) FILTER(WHERE level='danger') AS high,count(*) FILTER(WHERE level='pending') AS incomplete,count(*) FILTER(WHERE bare) AS no_verdict FROM graded`;
