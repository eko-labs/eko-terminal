ALTER TABLE swaps ADD COLUMN pricing_pending boolean NOT NULL DEFAULT false;
UPDATE swaps SET pricing_pending=true WHERE price_quote IS NULL;
CREATE INDEX swaps_pending_pricing_coin ON swaps(coin,block) WHERE pricing_pending;
CREATE INDEX swaps_pending_pricing_quote ON swaps(quote_asset,block) WHERE pricing_pending;
