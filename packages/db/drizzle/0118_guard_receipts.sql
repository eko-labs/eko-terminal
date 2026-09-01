-- Guard 2.0 §7.3. Payloads and registry facts remain append-only.
CREATE TABLE guard_receipt_payloads(id text PRIMARY KEY, revision_id text NOT NULL UNIQUE REFERENCES guard_verdict_revisions(id),
 chain_id bigint NOT NULL, payload_hash text NOT NULL, canonical_payload text NOT NULL, data jsonb NOT NULL, recorded_at timestamptz NOT NULL);
CREATE INDEX guard_receipt_payloads_pending ON guard_receipt_payloads(recorded_at,id);
CREATE TABLE guard_receipt_anchors(id text PRIMARY KEY, receipt_id text NOT NULL REFERENCES guard_receipt_payloads(id),
 chain_id bigint NOT NULL, registry_address text NOT NULL, batch_id numeric(20,0) NOT NULL CHECK(batch_id>0),
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL, UNIQUE(receipt_id,id));
CREATE INDEX guard_receipt_anchors_item ON guard_receipt_anchors(receipt_id);
CREATE TABLE guard_receipt_anchor_events(id text PRIMARY KEY, anchor_id text NOT NULL REFERENCES guard_receipt_anchors(id),
 kind text NOT NULL CHECK(kind='orphaned'), data jsonb NOT NULL, recorded_at timestamptz NOT NULL);
CREATE TRIGGER guard_receipt_payloads_immutable BEFORE UPDATE OR DELETE ON guard_receipt_payloads FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER guard_receipt_anchors_immutable BEFORE UPDATE OR DELETE ON guard_receipt_anchors FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER guard_receipt_anchor_events_immutable BEFORE UPDATE OR DELETE ON guard_receipt_anchor_events FOR EACH ROW EXECUTE FUNCTION guard_append_only();
