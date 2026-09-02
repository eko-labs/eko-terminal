-- Logs carry no parent hash. While the live indexer catches up, a stored block deeper than INDEX_REORG_DEPTH below the
-- chain head whose parent block had no indexed log may keep no parent link (NULL) instead of one header read per such
-- block. No reader depends on parent_hash: reorg checks compare stored block hashes, and every link inside the reorg
-- window is still fetched and checked. Existing rows keep their values.
ALTER TABLE chain_blocks ALTER COLUMN parent_hash DROP NOT NULL
