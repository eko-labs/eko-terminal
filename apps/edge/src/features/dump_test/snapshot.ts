import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DumpReply } from './index.js';

/**
 * Keeps the dump test's figures through a restart, beside the coin snapshot (snapshot.ts) and the checks
 * (probe-snapshot.ts), on the same cadence: every minute and at shutdown. Without it a deploy left the lists without a
 * Dump figure until each coin had been worked out again, behind the hour of history the tracker replays first.
 *
 * Format (one JSON file, DUMP_SNAPSHOT_VERSION):
 *   { "version": 1, "savedAt": <unix s>, "entries": [{ "token": "0x…", "at": <unix s>, "reply": <DumpReply> }, …] }
 * Replies hold no bigints (token amounts are decimal strings), so the file is plain JSON.
 *
 * Bounded: at most MAX_ENTRIES entries, MAX_ENTRY_BYTES each and MAX_FILE_BYTES in all, in the order given (the radar
 * list's coins first). On load, entries older than `maxAgeSec`, dated ahead of now, malformed, or of another version
 * are dropped; a file that cannot be used is ignored with a log line, and the figures are worked out again as before.
 * Bump DUMP_SNAPSHOT_VERSION whenever DumpReply changes in a way an older one cannot be read as.
 */
export const DUMP_SNAPSHOT_VERSION = 1;
export const MAX_ENTRIES = 3000, MAX_ENTRY_BYTES = 16 * 1024, MAX_FILE_BYTES = 16 * 1024 * 1024;

export interface SavedDump { token: string; at: number; reply: DumpReply }

/**
 * Where the file lives, read from the edge's environment as main.ts reads the other snapshots: DUMP_SNAPSHOT names it or
 * turns it off ("off"); by default dump.json beside the coin snapshot (COLUMNS_SNAPSHOT, or columns.json beside
 * HISTORY_DB when the history store is on), and none when there is no coin snapshot.
 */
export function dumpSnapshotPath(env: Record<string, string | undefined>, hasStore: boolean): string | null {
  if (env.DUMP_SNAPSHOT === 'off') return null;
  if (env.DUMP_SNAPSHOT) return env.DUMP_SNAPSHOT;
  const columns = env.COLUMNS_SNAPSHOT === 'off' ? null : env.COLUMNS_SNAPSHOT ?? (hasStore ? join(dirname(env.HISTORY_DB ?? '.data/history.db'), 'columns.json') : null);
  return columns ? join(dirname(columns), 'dump.json') : null;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const valid = (e: unknown): e is SavedDump => {
  const s = e as Partial<SavedDump> | null, r = s?.reply as Partial<DumpReply> | undefined;
  return !!s && typeof s.token === 'string' && ADDRESS.test(s.token) && typeof s.at === 'number' && Number.isFinite(s.at)
    && !!r && typeof r === 'object' && r.version === 1 && typeof r.coin === 'string' && r.coin.toLowerCase() === s.token && typeof r.measured === 'boolean'
    && (r.measured ? !!(r as { all?: unknown }).all && Array.isArray((r as { groups?: unknown }).groups) : typeof (r as { reason?: unknown }).reason === 'string');
};

/** The file's text: entries in the order given, each past MAX_ENTRY_BYTES skipped, and none once MAX_FILE_BYTES is reached. */
export function encodeDumps(entries: readonly SavedDump[], savedAt: number): { text: string; kept: number } {
  const head = `{"version":${DUMP_SNAPSHOT_VERSION},"savedAt":${Math.floor(savedAt)},"entries":[`, tail = ']}';
  const parts: string[] = [];
  let bytes = head.length + tail.length;
  for (const e of entries) {
    if (parts.length >= MAX_ENTRIES) break;
    const json = JSON.stringify({ token: e.token.toLowerCase(), at: e.at, reply: e.reply }), size = Buffer.byteLength(json) + 1;
    if (size > MAX_ENTRY_BYTES) continue;
    if (bytes + size > MAX_FILE_BYTES) break;
    parts.push(json); bytes += size;
  }
  return { text: head + parts.join(',') + tail, kept: parts.length };
}

/** The saved figures, or an error naming why the file cannot be used. Malformed entries are dropped one by one. */
export function decodeDumps(text: string): { savedAt: number; entries: SavedDump[] } | { error: string } {
  let parsed: { version?: unknown; savedAt?: unknown; entries?: unknown };
  try { parsed = JSON.parse(text) as typeof parsed; } catch { return { error: 'unparseable' }; }
  if (!parsed || typeof parsed !== 'object') return { error: 'unparseable' };
  if (parsed.version !== DUMP_SNAPSHOT_VERSION) return { error: `version ${String(parsed.version)} (expected ${DUMP_SNAPSHOT_VERSION})` };
  if (!Array.isArray(parsed.entries)) return { error: 'no entries list' };
  return { savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0, entries: parsed.entries.filter(valid).slice(0, MAX_ENTRIES) };
}

export class DumpSnapshot {
  private writing = false;
  constructor(private readonly path: string, private readonly source: () => SavedDump[],
    private readonly log?: (event: string, fields: Record<string, unknown>) => void) {}

  /** The saved figures no older than `maxAgeSec`, or none when there is no file or it cannot be used (logged, never thrown). */
  load(nowSec: number, maxAgeSec: number): SavedDump[] {
    let text: string;
    try {
      const size = statSync(this.path).size;
      if (size > MAX_FILE_BYTES) { this.log?.('dump_snapshot_ignored', { reason: 'too large', bytes: size }); return []; }
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.('dump_snapshot_ignored', { reason: 'unreadable', error: String((error as Error).message).slice(0, 160) });
      return [];
    }
    const decoded = decodeDumps(text);
    if ('error' in decoded) { this.log?.('dump_snapshot_ignored', { reason: decoded.error }); return []; }
    return decoded.entries.filter(e => e.at >= nowSec - maxAgeSec && e.at <= nowSec + 60);
  }

  /** Write in the background (one write at a time; a new file replaces the old only once complete). Returns how many. */
  async save(nowSec: number): Promise<number> {
    if (this.writing) return 0;
    this.writing = true;
    try {
      const { text, kept } = encodeDumps(this.source(), nowSec);
      mkdirSync(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, text); await rename(`${this.path}.tmp`, this.path);
      return kept;
    } finally { this.writing = false; }
  }

  /** At shutdown: write now, through its own temporary file (a background save still writing cannot interleave). */
  saveSync(nowSec: number): number {
    const { text, kept } = encodeDumps(this.source(), nowSec);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.exit.tmp`, text); renameSync(`${this.path}.exit.tmp`, this.path);
    return kept;
  }
}
