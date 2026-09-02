CREATE TABLE wallet_labels (
  id text PRIMARY KEY, address bytea NOT NULL, label text NOT NULL CHECK(label IN ('declared_agent','likely_agent','crew','human')),
  confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1), tier text CHECK(tier IN ('high','medium','low')),
  source text NOT NULL, crew_id text, features jsonb NOT NULL, model_version text NOT NULL, valid_from_block bigint NOT NULL,
  UNIQUE(address,valid_from_block,model_version)
);
CREATE INDEX wallet_labels_address_block ON wallet_labels(address,valid_from_block DESC,id DESC);
CREATE TABLE wallet_label_registry_dependencies (
  label_id text NOT NULL REFERENCES wallet_labels(id), agent_id numeric(78,0) NOT NULL,
  wallet_block bigint NOT NULL, block_hash bytea NOT NULL, PRIMARY KEY(label_id,agent_id)
);
CREATE TABLE wallet_label_supersessions (
  prior_id text NOT NULL REFERENCES wallet_labels(id), replacement_id text NOT NULL REFERENCES wallet_labels(id),
  PRIMARY KEY(prior_id,replacement_id)
);
-- statement-breakpoint
CREATE FUNCTION eko_wallet_label_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet labels are append-only';
END
$$;
-- statement-breakpoint
CREATE TRIGGER wallet_labels_immutable BEFORE UPDATE OR DELETE ON wallet_labels FOR EACH ROW EXECUTE FUNCTION eko_wallet_label_immutable();
