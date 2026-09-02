CREATE TABLE wallet_fingerprint_runs (
  id text PRIMARY KEY, address bytea NOT NULL, block bigint NOT NULL, block_hash bytea NOT NULL,
  model_version text NOT NULL, input_hash text NOT NULL, features jsonb NOT NULL, score double precision NOT NULL,
  UNIQUE(address,block,block_hash,model_version,input_hash)
);
CREATE INDEX wallet_fingerprint_runs_wallet_block ON wallet_fingerprint_runs(address,block DESC);
CREATE TABLE wallet_fingerprint_dependencies (
  run_id text NOT NULL REFERENCES wallet_fingerprint_runs(id), block bigint NOT NULL, block_hash bytea NOT NULL,
  PRIMARY KEY(run_id,block)
);
CREATE TABLE wallet_label_fingerprint_dependencies (
  label_id text PRIMARY KEY REFERENCES wallet_labels(id), run_id text NOT NULL REFERENCES wallet_fingerprint_runs(id)
);
CREATE TABLE wallet_fingerprint_state (
  address bytea NOT NULL, model_version text NOT NULL, revision text NOT NULL, through_block bigint NOT NULL,
  PRIMARY KEY(address,model_version)
);
CREATE TRIGGER wallet_fingerprint_runs_immutable BEFORE UPDATE OR DELETE ON wallet_fingerprint_runs FOR EACH ROW EXECUTE FUNCTION eko_wallet_label_immutable();
CREATE TRIGGER wallet_fingerprint_dependencies_immutable BEFORE UPDATE OR DELETE ON wallet_fingerprint_dependencies FOR EACH ROW EXECUTE FUNCTION eko_wallet_label_immutable();
CREATE TRIGGER wallet_label_fingerprint_dependencies_immutable BEFORE UPDATE OR DELETE ON wallet_label_fingerprint_dependencies FOR EACH ROW EXECUTE FUNCTION eko_wallet_label_immutable();
