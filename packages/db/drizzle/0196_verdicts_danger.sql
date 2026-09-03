-- The Radar header's "Danger by hour" joins verdicts to the cards written in the last day. With no index on the level
-- the planner read every verdict (719 MB on 2026-10-13: 2.0 s on a copy, 3.4 to 7.5 s on a request that found the
-- header totals expired). This index holds only Danger verdicts (776 kB) and answers the same statement in 190 ms
CREATE INDEX IF NOT EXISTS verdicts_danger ON verdicts(coin, valid_from_block) WHERE (data->>'level')='danger'
