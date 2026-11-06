-- Task 087: read-only staging cohort export after pinning the deployed candidate.
-- Parameters: $1 candidate SHA, $2 inclusive discovery time, $3 exclusive discovery time.
-- Export every eligible row, retaining NULL completion fields and recording the collection window externally.
WITH cohort AS (
  SELECT '0x'||encode(s.coin,'hex') AS coin,
    CASE WHEN t.launchpad='pons' THEN 'pons' ELSE coalesce((SELECT venue FROM pools
      WHERE currency0=s.coin OR currency1=s.coin ORDER BY created_block,id LIMIT 1),'other') END AS venue,
    floor(extract(epoch FROM s.discovered_at)*1000)::bigint AS "discoveredAt",
    floor(extract(epoch FROM s.engine_started_at)*1000)::bigint AS "engineStartedAt",
    floor(extract(epoch FROM s.first_verdict_at)*1000)::bigint AS "firstVerdictAt",
    floor(extract(epoch FROM s.critical_complete_at)*1000)::bigint AS "criticalCompleteAt",
    s.verdict_id AS "verdictId"
  FROM scan_timings s LEFT JOIN tokens t ON t.address=s.coin
  WHERE s.discovered_at >= $2::timestamptz AND s.discovered_at < $3::timestamptz
)
SELECT jsonb_build_object('candidate',$1::text,'source','staging','eligibleCount',count(*),
  'samples',coalesce(jsonb_agg(to_jsonb(cohort) ORDER BY "discoveredAt",coin),'[]'::jsonb)) FROM cohort;
