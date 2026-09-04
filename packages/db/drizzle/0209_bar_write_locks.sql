-- A mutex row also serializes the first write of a previously absent bar.
CREATE TABLE bar_write_locks(coin bytea PRIMARY KEY);
