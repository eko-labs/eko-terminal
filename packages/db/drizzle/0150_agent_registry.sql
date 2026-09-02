CREATE TABLE agent_registry_events (
  block bigint NOT NULL, block_hash bytea NOT NULL, tx_hash bytea NOT NULL, log_index integer NOT NULL,
  agent_id numeric(78,0) NOT NULL, kind text NOT NULL CHECK(kind IN ('mint','transfer','wallet_change')),
  owner bytea, evidence jsonb NOT NULL, PRIMARY KEY(tx_hash,log_index)
);
CREATE INDEX agent_registry_events_agent_block ON agent_registry_events(agent_id,block);
CREATE TABLE agent_registry (
  agent_id numeric(78,0) NOT NULL, owner bytea NOT NULL, wallet bytea NOT NULL, token_uri text,
  registered_block bigint NOT NULL, wallet_block bigint NOT NULL, block bigint NOT NULL,
  block_hash bytea NOT NULL, evidence jsonb NOT NULL,
  PRIMARY KEY(agent_id,wallet_block), CHECK(block=wallet_block), CHECK(registered_block<=wallet_block)
);
CREATE INDEX agent_registry_wallet_block ON agent_registry(wallet,wallet_block);
CREATE TABLE agent_registry_checkpoints(from_block bigint NOT NULL, block bigint NOT NULL, block_hash bytea NOT NULL, PRIMARY KEY(from_block,block), CHECK(from_block<=block));
