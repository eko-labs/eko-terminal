CREATE TABLE userops (
  chain_id integer NOT NULL, block bigint NOT NULL, block_hash bytea NOT NULL,
  tx_hash bytea NOT NULL, transaction_index integer, log_index integer NOT NULL,
  timestamp_sec bigint NOT NULL, entry_point bytea NOT NULL, version text NOT NULL,
  user_op_hash bytea NOT NULL, sender bytea NOT NULL, paymaster bytea NOT NULL,
  nonce numeric(78,0) NOT NULL, success boolean NOT NULL,
  actual_gas_cost numeric(78,0) NOT NULL, actual_gas_used numeric(78,0) NOT NULL,
  data jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,tx_hash,log_index)
);
CREATE INDEX userops_sender_block ON userops(chain_id,sender,block);
CREATE TABLE delegations_7702 (
  chain_id integer NOT NULL, block bigint NOT NULL, block_hash bytea NOT NULL,
  tx_hash bytea NOT NULL, transaction_index integer, evidence_index integer NOT NULL,
  timestamp_sec bigint NOT NULL, kind text NOT NULL CHECK(kind IN ('authorization','code')),
  authority bytea, implementation bytea, signature_valid boolean,
  data jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,tx_hash,kind,evidence_index)
);
CREATE INDEX delegations_7702_authority_block ON delegations_7702(chain_id,authority,block);
CREATE TABLE wallet_protocol_coverage (
  chain_id integer NOT NULL, block bigint NOT NULL, block_hash bytea NOT NULL,
  tx_hash bytea NOT NULL, transaction_index integer, timestamp_sec bigint NOT NULL,
  scope text NOT NULL, input_hash bytea NOT NULL, data jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,tx_hash,scope,input_hash)
);
