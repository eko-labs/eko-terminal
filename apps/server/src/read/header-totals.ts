/** Card-only coins stay visible while their read projection is pending. Known activity keeps its seven-day cutoff.
 * Separate branches read card JSON only for missing projections, not for every refreshed coin.
 */
const cardOnly=`FROM coin_card_latest c LEFT JOIN read_coins r ON r.coin=c.coin WHERE r.coin IS NULL`;
const guardLive=(cutoff:string)=>`SELECT coin FROM read_coins WHERE activity>${cutoff}
 UNION ALL SELECT c.coin ${cardOnly}`;
export const GUARD_LIVE_COINS_SQL=`${guardLive('$1')} ORDER BY coin`;
export const HEADER_COUNTS_SQL=`WITH graded AS (
 SELECT r.tier,c.coin IS NULL AS bare FROM read_coins r LEFT JOIN coin_card_latest c ON c.coin=r.coin WHERE r.activity>$1
 UNION ALL
 SELECT CASE c.data->'verdict'->>'level' WHEN 'clear' THEN 0 WHEN 'monitor' THEN 1 WHEN 'danger' THEN 3 ELSE 2 END AS tier,
 false AS bare ${cardOnly}
)
SELECT count(*) AS coins,
 count(*) FILTER(WHERE tier=0 AND NOT bare) AS lower,
 count(*) FILTER(WHERE tier=1 AND NOT bare) AS elevated,
 count(*) FILTER(WHERE tier=3 AND NOT bare) AS high,
 count(*) FILTER(WHERE tier=2 AND NOT bare) AS incomplete,
 count(*) FILTER(WHERE bare) AS no_verdict FROM graded`;

/** Keep the created_at and pre-0191 sec index ranges separate, and bound both ends. */
const runs=(from:string,to:string)=>`SELECT coin,block FROM engine_runs WHERE created_at>=to_timestamp(${from}) AND created_at<to_timestamp(${to})
 UNION ALL SELECT coin,block FROM engine_runs WHERE created_at IS NULL AND sec>=${from} AND sec<${to}`;
export const HEADER_TODAY_SQL=`SELECT count(DISTINCT e.coin) AS n FROM (${runs('$1','$2')}) e
 JOIN read_coins r ON r.coin=e.coin WHERE r.activity>$3`;
export const GUARD_HEADER_TODAY_SQL=`SELECT count(DISTINCT e.coin) AS n FROM (${runs('$1','$2')}) e
 JOIN (${guardLive('$3')}) r ON r.coin=e.coin`;

/** Exactly 24 result rows. 0216 counts attempts rather than distinct coins and cannot supply these series.
 * The rank timer maintains volume only. Index-bounded engine runs are the header's historical source.
 */
export const HEADER_HOURS_SQL=`SELECT h.h,s.n,d.n AS danger FROM generate_series(0,23) h(h)
 CROSS JOIN LATERAL (SELECT count(DISTINCT e.coin) AS n FROM (${runs('$1+h.h*3600','$1+(h.h+1)*3600')}) e
  JOIN read_coins r ON r.coin=e.coin WHERE r.activity>$2) s
 CROSS JOIN LATERAL (SELECT count(DISTINCT e.coin) AS n FROM (${runs('$1+h.h*3600','$1+(h.h+1)*3600')}) e
  WHERE EXISTS(SELECT 1 FROM verdicts v WHERE v.coin=e.coin AND v.valid_from_block=e.block AND v.data->>'level'='danger')) d
 ORDER BY h.h`;
