CREATE INDEX swaps_priced_ts_block_coin ON swaps(ts,block,coin) INCLUDE(usd) WHERE usd>0;
CREATE INDEX deployer_stats_deployer_block_coin ON deployer_stats(deployer,valid_from_block,coin);
CREATE INDEX outcomes_rugged_coin_block ON outcomes(coin,valid_from_block) WHERE outcome='rugged';
CREATE INDEX engine_runs_version_block_coin ON engine_runs(rules_version,block,coin);
CREATE INDEX deployer_stats_version_block_coin ON deployer_stats(rules_version,valid_from_block,coin);
