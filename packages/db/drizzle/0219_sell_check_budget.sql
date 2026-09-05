-- Scheduling survives restarts, transient provider failures and run-history pruning.
ALTER TABLE sell_check_latest ADD COLUMN buy_failures integer NOT NULL DEFAULT 0 CHECK(buy_failures>=0);
ALTER TABLE sell_check_latest ADD COLUMN route_state jsonb;
ALTER TABLE sell_check_latest ADD COLUMN price double precision;
ALTER TABLE sell_check_latest ADD COLUMN peak_crash boolean NOT NULL DEFAULT false;
ALTER TABLE sell_check_runs ADD COLUMN schedule_class text CHECK(schedule_class IN ('first_live','crash','first_unlisted','routine'));
-- Preserve existing failed-buy streaks. Unavailable attempts do not reset a measured failure.
UPDATE sell_check_latest l SET buy_failures=greatest(1,(SELECT count(*) FROM sell_check_runs r
 WHERE r.coin=l.coin AND r.status='buy_failed' AND r.id>coalesce((SELECT max(p.id) FROM sell_check_runs p
 WHERE p.coin=l.coin AND p.status NOT IN ('buy_failed','unavailable')),0))) WHERE l.status='buy_failed';
