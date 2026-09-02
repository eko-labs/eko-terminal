-- token_transfers is read by token and block range (engines, holder views, retention). Balances are maintained
-- incrementally from inserted rows, so the per-holder indexes only served the touched-balance recompute, which now
-- runs after reorgs alone. Measured in production on 2026-10-08: the two indexes held 4.3 GB of the October partition
-- with 664 scans in total, while every inserted transfer paid two random index writes for them.
DROP INDEX IF EXISTS token_transfers_from;
DROP INDEX IF EXISTS token_transfers_to;
