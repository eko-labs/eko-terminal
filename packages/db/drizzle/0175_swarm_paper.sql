-- Mutable projections are rebuilt from immutable events. No terminal accounts or orders are used.
CREATE TABLE swarm_paper_positions (
 id text PRIMARY KEY, forecast_id text NOT NULL REFERENCES forecasts(id), sample_index integer NOT NULL,
 coin text NOT NULL, due_ms bigint NOT NULL, data jsonb NOT NULL, UNIQUE(forecast_id,sample_index));
CREATE TABLE swarm_paper_events (
 position_id text NOT NULL REFERENCES swarm_paper_positions(id), tick_id text NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(position_id,tick_id));
CREATE TABLE swarm_paper_grades (
 position_id text PRIMARY KEY REFERENCES swarm_paper_positions(id), data jsonb NOT NULL);
CREATE TABLE swarm_calibration_inputs (
 forecast_id text PRIMARY KEY REFERENCES forecasts(id), data jsonb NOT NULL);
CREATE TABLE swarm_calibration_outcomes (
 forecast_id text NOT NULL REFERENCES forecasts(id), anchor_hash text NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(forecast_id,anchor_hash));
CREATE TABLE swarm_calibration_baselines (
 forecast_id text PRIMARY KEY REFERENCES forecasts(id), data jsonb NOT NULL);
CREATE TABLE swarm_calibration_reports (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE swarm_paper_ticks (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE swarm_momentum_models (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE swarm_paper_checkpoint (id text PRIMARY KEY, through_ms bigint NOT NULL, tick_id text NOT NULL);
CREATE TRIGGER swarm_paper_events_immutable BEFORE UPDATE OR DELETE ON swarm_paper_events FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER swarm_paper_grades_immutable BEFORE UPDATE OR DELETE ON swarm_paper_grades FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER swarm_calibration_inputs_immutable BEFORE UPDATE OR DELETE ON swarm_calibration_inputs FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER swarm_calibration_outcomes_immutable BEFORE UPDATE OR DELETE ON swarm_calibration_outcomes FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER swarm_calibration_baselines_immutable BEFORE UPDATE OR DELETE ON swarm_calibration_baselines FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER swarm_calibration_reports_immutable BEFORE UPDATE OR DELETE ON swarm_calibration_reports FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER swarm_paper_ticks_immutable BEFORE UPDATE OR DELETE ON swarm_paper_ticks FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TRIGGER swarm_momentum_models_immutable BEFORE UPDATE OR DELETE ON swarm_momentum_models FOR EACH ROW EXECUTE FUNCTION guard_append_only();
CREATE TABLE swarm_calibration_cohorts (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TRIGGER swarm_calibration_cohorts_immutable BEFORE UPDATE OR DELETE ON swarm_calibration_cohorts FOR EACH ROW EXECUTE FUNCTION guard_append_only();
