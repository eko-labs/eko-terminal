CREATE TABLE engine_card_failures (
  coin bytea PRIMARY KEY,
  attempts bigint NOT NULL DEFAULT 0,
  last_block bigint NOT NULL,
  reason text NOT NULL
);

-- Enrichment may change attribution at an already-evaluated head. Retain both card revisions.
ALTER TABLE coin_cards DROP CONSTRAINT coin_cards_coin_valid_from_block_rules_version_key;
ALTER TABLE coin_cards ADD UNIQUE(coin,valid_from_block,rules_version,hash);
