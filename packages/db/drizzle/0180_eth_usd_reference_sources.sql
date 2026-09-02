-- Selected archive/log pricing identities, removed with their source blocks on rollback.
CREATE TABLE eth_usd_reference_sources (
  block bigint PRIMARY KEY,
  pool_id bytea NOT NULL CHECK (octet_length(pool_id) = 20),
  venue text NOT NULL CHECK (venue = 'uniswap_v3'),
  fee integer NOT NULL CHECK (fee IN (100, 500, 3000, 10000))
);
