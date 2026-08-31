CREATE TABLE engine_pons_static (coin bytea PRIMARY KEY, first_read_block bigint NOT NULL, first_read_hash bytea, data jsonb NOT NULL);
