CREATE TABLE ghost_report_drafts (
 id text PRIMARY KEY CHECK(id ~ '^0x[0-9a-f]{64}$'),
 revision_id text NOT NULL REFERENCES guard_verdict_revisions(id),
 supersedes text REFERENCES ghost_report_drafts(id),
 data jsonb NOT NULL, prepared_at timestamptz NOT NULL
);
CREATE INDEX ghost_report_drafts_revision ON ghost_report_drafts(revision_id);
CREATE INDEX ghost_report_drafts_corrections ON ghost_report_drafts(supersedes);
CREATE TABLE ghost_report_reviews (
 report_id text PRIMARY KEY REFERENCES ghost_report_drafts(id),
 data jsonb NOT NULL, reviewed_at timestamptz NOT NULL
);
CREATE TRIGGER ghost_report_drafts_immutable BEFORE UPDATE OR DELETE ON ghost_report_drafts FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER ghost_report_reviews_immutable BEFORE UPDATE OR DELETE ON ghost_report_reviews FOR EACH ROW EXECUTE FUNCTION guard_append_only();
