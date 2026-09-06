import { binary } from './types.js';
import type { ChainDb } from './client.js';
/** Null means coverage is unproved, never zero. The maintained row must not have advanced past the requested block. */
export async function maintainedBalance(db: ChainDb, token: string, holder: string, block: bigint): Promise<bigint | null> {
  const row = (await db.sql.query<{amount:string}>(`SELECT b.amount FROM balances b
    JOIN token_balance_origins o ON o.token=b.token JOIN chain_blocks c ON c.number=o.block AND c.hash=o.block_hash
    WHERE b.token=$1 AND b.holder=$2 AND b.last_block<=$3 AND b.amount>=0 AND o.block<=$3
      AND EXISTS(SELECT 1 FROM ingest_cursors WHERE stream='head_logs' AND block>=$3)`,
    [binary(token),binary(holder),block.toString()])).rows[0];
  return row ? BigInt(row.amount) : null;
}
