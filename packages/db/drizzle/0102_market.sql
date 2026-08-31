ALTER TABLE tokens ADD COLUMN total_supply numeric(78,0);
ALTER TABLE tokens ADD COLUMN supply_block bigint;
ALTER TABLE tokens ADD COLUMN graduated_pool bytea;
ALTER TABLE tokens ADD COLUMN graduated_block bigint;
ALTER TABLE pools ADD COLUMN creation_verified boolean NOT NULL DEFAULT false;
CREATE TABLE balances (
  token bytea NOT NULL, holder bytea NOT NULL, amount numeric(78,0) NOT NULL, last_block bigint NOT NULL,
  PRIMARY KEY(token,holder)
);
CREATE INDEX token_transfers_from ON token_transfers(token,from_address,block);
CREATE INDEX token_transfers_to ON token_transfers(token,to_address,block);
CREATE TABLE bars_1m (
  coin bytea NOT NULL, minute timestamptz NOT NULL,
  open double precision NOT NULL, high double precision NOT NULL, low double precision NOT NULL, close double precision NOT NULL,
  volume_usd double precision NOT NULL, trades integer NOT NULL, first_block bigint NOT NULL, last_block bigint NOT NULL,
  PRIMARY KEY(coin,minute)
) PARTITION BY RANGE(minute);
CREATE INDEX swaps_coin_ts ON swaps(coin,ts);
CREATE INDEX swaps_block_ts ON swaps(block,ts);
