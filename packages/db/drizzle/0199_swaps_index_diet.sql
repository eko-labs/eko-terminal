-- No current query constrains quote_asset together with pricing_pending.
-- enrich.ts matches coin OR quote_asset and several independent pending reasons, so it cannot use this partial index.
-- Reference pricing reads use pool_id and block, or coin and block, with no pricing_pending predicate.
-- Keep both partial coin indexes, whose distinct predicates serve sender settlement and pending-price probes.
DROP INDEX IF EXISTS swaps_pending_pricing_quote;
