-- For a little over an hour on 2026-10-13 the head named the wallet behind swaps of WETH and USDG as the coin (the
-- reference pair's own swaps). Those assets are never listed, and with traders on them every wallet profile read
-- WETH's whole history. The head no longer names them, and the rows it wrote that way go back to how they were stored
-- before (no trader, senders pending). Rows whose sender came from receipts (tx_from set) are left alone.
UPDATE swaps SET trader=NULL,senders_pending=true
WHERE coin IN (decode('0bd7d308f8e1639fab988df18a8011f41eacad73','hex'),decode('5fc5360d0400a0fd4f2af552add042d716f1d168','hex'))
  AND tx_from IS NULL AND trader IS NOT NULL AND venue<>'pons_curve' AND ts>='2026-10-13T05:50:00Z'
