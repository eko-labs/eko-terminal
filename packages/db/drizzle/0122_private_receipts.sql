-- Producer-owned commitment handoff: no owner, agent, salt, or private payload.
CREATE TABLE receipt_private_publications (
 id text PRIMARY KEY, commitment text NOT NULL CHECK(commitment ~ '^0x[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL);
CREATE TRIGGER receipt_private_publications_immutable BEFORE UPDATE OR DELETE ON receipt_private_publications FOR EACH ROW EXECUTE FUNCTION guard_append_only();
ALTER TABLE receipt_items DROP CONSTRAINT receipt_items_kind_check;
ALTER TABLE receipt_items ADD CONSTRAINT receipt_items_kind_check CHECK(kind IN ('verdict','forecast','harness_private'));
