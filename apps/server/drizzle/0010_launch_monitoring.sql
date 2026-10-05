CREATE TABLE launch_measurements (
 metric text PRIMARY KEY,
 samples jsonb NOT NULL,
 updated_at bigint NOT NULL
);
