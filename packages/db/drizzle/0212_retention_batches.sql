-- 2026-10-17: production builds this on 272k publications if the earlier probe index is absent.
-- The engines ledger is transactional. Prebuild CONCURRENTLY before deploy to avoid a long writer lock.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='3s';
CREATE INDEX IF NOT EXISTS receipt_publications_live_coin_sequence ON receipt_publications ((data->>'coin'),publication_sequence DESC) WHERE producer='engines' AND kind='verdict' AND chain_id=4663 AND data IS NOT NULL;
