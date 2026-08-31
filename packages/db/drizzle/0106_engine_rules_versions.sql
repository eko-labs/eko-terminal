ALTER TABLE engine_runs ADD COLUMN rules_version text NOT NULL DEFAULT '1.0.0';
ALTER TABLE engine_runs DROP CONSTRAINT engine_runs_pkey;
ALTER TABLE engine_runs ADD PRIMARY KEY(coin,block,rules_version);
ALTER TABLE coin_cards ADD COLUMN rules_version text NOT NULL DEFAULT '1.0.0';
ALTER TABLE coin_cards DROP CONSTRAINT coin_cards_coin_valid_from_block_key;
ALTER TABLE coin_cards ADD UNIQUE(coin,valid_from_block,rules_version);
ALTER TABLE deployer_stats ADD COLUMN rules_version text NOT NULL DEFAULT '1.0.0';
ALTER TABLE deployer_stats DROP CONSTRAINT deployer_stats_pkey;
ALTER TABLE deployer_stats ADD PRIMARY KEY(deployer,coin,valid_from_block,rules_version);
