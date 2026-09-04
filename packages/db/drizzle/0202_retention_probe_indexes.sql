-- The engines runner wraps migrations in a transaction, so concurrent builds are not supported.
-- Production builds these CONCURRENTLY by hand before deploy, so IF NOT EXISTS keeps this a no-op there.
-- Dependency retention uses its existing (run_id,block) primary key and needs no new large-table index.
CREATE INDEX IF NOT EXISTS receipt_publications_live_coin_sequence ON receipt_publications ((data->>'coin'),publication_sequence DESC) WHERE producer='engines' AND kind='verdict' AND chain_id=4663 AND data IS NOT NULL;
CREATE INDEX IF NOT EXISTS guard_shadow_runs_retention_successor ON guard_shadow_runs(coin,block,recorded_at,id);
CREATE INDEX IF NOT EXISTS coin_cards_retention_successor ON coin_cards(coin,rules_version,valid_from_block,id);
CREATE INDEX IF NOT EXISTS verdicts_retention_successor ON verdicts(coin,rules_version,valid_from_block,id);
