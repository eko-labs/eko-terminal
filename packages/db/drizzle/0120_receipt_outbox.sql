-- Producer-owned immutable publications are the durable handoff to receipts.
CREATE TABLE receipt_publications (
 id text PRIMARY KEY, publication_sequence bigserial NOT NULL, producer text NOT NULL, kind text NOT NULL CHECK(kind IN ('verdict','forecast')),
 chain_id bigint NOT NULL, revision_id text NOT NULL, payload_hash text NOT NULL,
 canonical_payload text NOT NULL, data jsonb NOT NULL, recorded_at timestamptz NOT NULL,
 UNIQUE(producer,revision_id));
CREATE INDEX receipt_publications_recovery ON receipt_publications(recorded_at,id);
CREATE TABLE receipt_items (
 id text PRIMARY KEY, producer text NOT NULL, kind text NOT NULL CHECK(kind IN ('verdict','forecast')),
 chain_id bigint NOT NULL, revision_id text NOT NULL, payload_hash text NOT NULL, leaf text NOT NULL,
 canonical_payload text NOT NULL, data jsonb NOT NULL, recorded_at timestamptz NOT NULL,
 UNIQUE(producer,revision_id));
CREATE INDEX receipt_items_pending ON receipt_items(chain_id,recorded_at,id);
-- Internal immutable preparation identity, never an invented registry batch ID.
-- Packet 080 owns submission/retry and authenticated registry anchor facts.
CREATE TABLE receipt_batches (
 id text PRIMARY KEY, chain_id bigint NOT NULL, root text NOT NULL, leaf_count integer NOT NULL CHECK(leaf_count>0),
 through timestamptz NOT NULL, recorded_at timestamptz NOT NULL);
CREATE TABLE receipt_batch_items (
 batch_id text NOT NULL REFERENCES receipt_batches(id), receipt_id text NOT NULL REFERENCES receipt_items(id),
 item_index integer NOT NULL CHECK(item_index>=0), proof jsonb NOT NULL,
 PRIMARY KEY(batch_id,receipt_id), UNIQUE(batch_id,item_index));
CREATE TRIGGER receipt_publications_immutable BEFORE UPDATE OR DELETE ON receipt_publications FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER receipt_items_immutable BEFORE UPDATE OR DELETE ON receipt_items FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER receipt_batches_immutable BEFORE UPDATE OR DELETE ON receipt_batches FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER receipt_batch_items_immutable BEFORE UPDATE OR DELETE ON receipt_batch_items FOR EACH ROW EXECUTE FUNCTION guard_append_only();
-- Same-block corrections have their own immutable identity.
ALTER TABLE verdicts DROP CONSTRAINT verdicts_coin_valid_from_block_rules_version_key;
CREATE TRIGGER verdicts_immutable BEFORE UPDATE OR DELETE ON verdicts FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER verdict_events_immutable BEFORE UPDATE OR DELETE ON verdict_events FOR EACH ROW EXECUTE FUNCTION guard_append_only();
