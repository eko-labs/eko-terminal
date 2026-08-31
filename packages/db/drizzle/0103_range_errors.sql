ALTER TABLE ingest_ranges ADD COLUMN last_error text;
ALTER TABLE ingest_ranges ADD COLUMN error_repeats integer NOT NULL DEFAULT 0 CHECK(error_repeats >= 0);
