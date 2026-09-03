-- The scoreboard reads publications above the sequence it has consumed (apps/server read/scoreboard.ts). Without an
-- index on the sequence each pass scanned the table's heap
CREATE INDEX IF NOT EXISTS receipt_publications_sequence ON receipt_publications(publication_sequence)
