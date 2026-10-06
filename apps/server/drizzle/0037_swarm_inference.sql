ALTER TABLE inference_runs ADD COLUMN purpose text;
--> statement-breakpoint
ALTER TABLE inference_runs ADD COLUMN coin text;
--> statement-breakpoint
ALTER TABLE inference_runs ADD COLUMN persona_set_version text;
--> statement-breakpoint
ALTER TABLE inference_runs ADD COLUMN reservation_id text;
--> statement-breakpoint
CREATE INDEX inference_runs_swarm ON inference_runs(purpose,coin,started_at);
--> statement-breakpoint
CREATE INDEX inference_runs_reservation ON inference_runs(reservation_id);
--> statement-breakpoint
CREATE FUNCTION swarm_inference_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.purpose='swarm' THEN RAISE EXCEPTION 'Swarm inference runs are append-only'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER swarm_inference_immutable BEFORE UPDATE OR DELETE ON inference_runs FOR EACH ROW EXECUTE FUNCTION swarm_inference_append_only();
