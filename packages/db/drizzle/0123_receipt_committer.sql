-- Packet-scoped migration name avoids collisions with concurrent packets.
CREATE TABLE receipt_worker_lease (
 chain_id bigint PRIMARY KEY, owner text NOT NULL, lease_until timestamptz NOT NULL,
 heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO receipt_worker_lease(chain_id,owner,lease_until) VALUES(4663,'',clock_timestamp());
CREATE TABLE receipt_commit_attempts (
 tx_hash text PRIMARY KEY, batch_id text NOT NULL REFERENCES receipt_batches(id),
 registry text NOT NULL, committer text NOT NULL, nonce bigint NOT NULL,
 raw_transaction text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX receipt_attempt_batch ON receipt_commit_attempts(batch_id,recorded_at);
CREATE TABLE receipt_commit_failures (
 tx_hash text PRIMARY KEY REFERENCES receipt_commit_attempts(tx_hash),
 block_number bigint NOT NULL, block_hash text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE receipt_commit_anchors (
 id text PRIMARY KEY, batch_id text NOT NULL REFERENCES receipt_batches(id),
 tx_hash text NOT NULL REFERENCES receipt_commit_attempts(tx_hash), data jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE receipt_commit_anchor_events (
 anchor_id text NOT NULL REFERENCES receipt_commit_anchors(id), kind text NOT NULL CHECK(kind IN ('orphaned','finalized')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(anchor_id,kind));
CREATE VIEW receipt_commit_health AS SELECT chain_id,heartbeat_at,
 EXTRACT(EPOCH FROM clock_timestamp()-heartbeat_at) AS heartbeat_age_s,
 clock_timestamp()-heartbeat_at >= interval '10 minutes' AS heartbeat_missing FROM receipt_worker_lease;
CREATE TRIGGER receipt_attempts_immutable BEFORE UPDATE OR DELETE ON receipt_commit_attempts FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER receipt_failures_immutable BEFORE UPDATE OR DELETE ON receipt_commit_failures FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER receipt_anchors_immutable BEFORE UPDATE OR DELETE ON receipt_commit_anchors FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER receipt_anchor_events_immutable BEFORE UPDATE OR DELETE ON receipt_commit_anchor_events FOR EACH ROW EXECUTE FUNCTION guard_append_only();
