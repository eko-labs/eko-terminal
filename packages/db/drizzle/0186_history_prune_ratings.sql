-- The pruned coin's verdict level and Danger playbook ids at prune time (packages/db/src/retention.ts). A coin pruned
-- while rated Danger stays Danger if it trades again: the engines can no longer re-run the checks behind that rating.
ALTER TABLE history_prunes ADD COLUMN verdict_level text;
ALTER TABLE history_prunes ADD COLUMN danger_playbooks jsonb NOT NULL DEFAULT '[]'::jsonb
