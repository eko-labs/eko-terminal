-- Evals-owned independent reviews. No active verdict or outcome writes.
CREATE TABLE review_cases (id text PRIMARY KEY, coin text NOT NULL, rule_author_id text NOT NULL);
CREATE TABLE review_case_revisions (
 id text PRIMARY KEY, case_id text NOT NULL REFERENCES review_cases(id),
 revision integer NOT NULL CHECK(revision>0), supersedes text UNIQUE REFERENCES review_case_revisions(id),
 data jsonb NOT NULL, UNIQUE(case_id,revision)
);
CREATE TABLE review_assignments (
 case_id text NOT NULL REFERENCES review_cases(id), account_hash text NOT NULL,
 pseudonym text NOT NULL, role text NOT NULL CHECK(role IN ('reviewer_1','reviewer_2','adjudicator','evaluator')),
 PRIMARY KEY(case_id,account_hash), UNIQUE(case_id,pseudonym), UNIQUE(case_id,role)
);
CREATE TABLE review_labels (
 id text PRIMARY KEY, case_revision_id text NOT NULL REFERENCES review_case_revisions(id),
 slot text NOT NULL CHECK(slot IN ('reviewer_1','reviewer_2')), revision integer NOT NULL CHECK(revision>0),
 supersedes text UNIQUE REFERENCES review_labels(id), data jsonb NOT NULL,
 UNIQUE(case_revision_id,slot,revision)
);
CREATE TABLE review_adjudications (
 id text PRIMARY KEY, case_revision_id text NOT NULL REFERENCES review_case_revisions(id),
 revision integer NOT NULL CHECK(revision>0), supersedes text UNIQUE REFERENCES review_adjudications(id),
 data jsonb NOT NULL, UNIQUE(case_revision_id,revision)
);
CREATE TRIGGER review_cases_immutable BEFORE UPDATE OR DELETE ON review_cases FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER review_case_revisions_immutable BEFORE UPDATE OR DELETE ON review_case_revisions FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER review_assignments_immutable BEFORE UPDATE OR DELETE ON review_assignments FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER review_labels_immutable BEFORE UPDATE OR DELETE ON review_labels FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER review_adjudications_immutable BEFORE UPDATE OR DELETE ON review_adjudications FOR EACH ROW EXECUTE FUNCTION guard_append_only();
