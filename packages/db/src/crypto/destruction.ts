import { closeSync, constants, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';

/** Authoritative, monotonic state OUTSIDE database backups. Every unwrap must
 * consult it. Restore must mount the CURRENT ledger before serving any traffic. */
export interface JournalDestructionLedger {
  destroyedAt(accountId: string): string | null;
  destroy(accountId: string, deletedAt: string): string;
}
/** A provisioned file on a durable shared volume. Never auto-create an empty
 * replacement: missing, malformed, or truncated state disables all access.
 * All processes use O_APPEND and fsync before acknowledging destruction. */
export class FileJournalDestructionLedger implements JournalDestructionLedger {
  /**
   * Retain path to an already provisioned durable shared ledger. Host-only construction; it does not
   * create, read or authenticate the file until operations run. Missing file later refuses access.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  constructor(private path: string) {}
  /**
   * Read and validate the entire provisioned append-only ledger and return the earliest recorded
   * deletion timestamp for this account, or null. Host storage caller only;
   * missing/malformed/truncated/invalid records throw and disable application access.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  destroyedAt(accountId: string) {
    const text = readFileSync(this.path, 'utf8');
    if (!text.startsWith('eko-journal-destruction-v1\n') || !text.endsWith('\n')) throw new Error('Journal destruction ledger unavailable');
    let found: string | null = null;
    for (const line of text.split('\n').slice(1, -1)) {
      const row = JSON.parse(line) as { accountId: string; deletedAt: string };
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.accountId) || !Number.isFinite(Date.parse(row.deletedAt))) throw new Error('Journal destruction ledger unavailable');
      if (row.accountId === accountId && (!found || row.deletedAt < found)) found = row.deletedAt;
    }
    return found;
  }
  /**
   * Validate identity/time, return a prior deletion unchanged or append and fsync before
   * acknowledgement, then re-read authoritative state. Host deletion flow must authenticate owner;
   * invalid input, missing ledger, partial write or I/O failure throws. Durable volume/current
   * ledger retention is an operational requirement.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
   */
  destroy(accountId: string, deletedAt: string) {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(accountId) || !Number.isFinite(Date.parse(deletedAt))) throw new Error('Invalid destruction record');
    const previous = this.destroyedAt(accountId);
    if (previous) return previous;
    const record = Buffer.from(JSON.stringify({ accountId, deletedAt }) + '\n');
    const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND);
    try {
      if (writeSync(fd, record) !== record.length) throw new Error('Journal destruction ledger unavailable');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    return this.destroyedAt(accountId)!;
  }
}
