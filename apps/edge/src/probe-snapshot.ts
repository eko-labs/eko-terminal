import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Probed } from './assess.js';

/**
 * Keeps each coin's cached check (Edge.probes: the paid part of a check, with the early buys' priority fees it has read)
 * through a restart, next to the coin snapshot (snapshot.ts) and on the same cadence: every minute and at shutdown.
 * Without it every deploy left the list on "Still checking" with no EKO score until each of the ~1,500 followed coins
 * had been checked again, a few minutes at the paid RPC's rate.
 *
 * Format (one JSON file, PROBES_VERSION):
 *   { "version": 1, "savedAt": <unix s>, "probes": [{ "token": "0x…", "trades": <n>, "probe": <Probed> }, …] }
 * A bigint is written as { "$n": "<decimal>" } and a Date as { "$d": "<ISO time>" }. `trades` is the coin's trade count
 * when the check was taken (Edge.due: a coin that has not traded since needs no scheduled re-check).
 *
 * Bounded: at most MAX_PROBES entries, MAX_TIPS fees per entry, MAX_ENTRY_BYTES per entry and MAX_FILE_BYTES in all,
 * the radar list's first coins kept first (Edge.savedProbes). A file over MAX_FILE_BYTES, of another version, or that
 * does not parse is ignored with a log line: the coins are then checked again as before. Bump PROBES_VERSION whenever
 * Probed changes in a way an older check cannot be read as.
 */
export const PROBES_VERSION = 1;
export const MAX_PROBES = 5000, MAX_TIPS = 256, MAX_ENTRY_BYTES = 64 * 1024, MAX_FILE_BYTES = 32 * 1024 * 1024;

/** One coin's cached check as the snapshot keeps it. */
export interface SavedProbe { token: string; trades: number; probe: Probed }

function replacer(this: Record<string, unknown>, key: string, v: unknown) {
  // JSON.stringify has already turned a Date into a string (toJSON) by the time `v` arrives: read the holder's value.
  const raw = this[key];
  if (raw instanceof Date) return { $d: Number.isNaN(raw.getTime()) ? null : raw.toISOString() };
  return typeof v === 'bigint' ? { $n: v.toString() } : v;
}
function reviver(_: string, v: unknown) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const keys = Object.keys(v);
  if (keys.length !== 1) return v;
  const o = v as { $n?: unknown; $d?: unknown };
  if (typeof o.$n === 'string' && /^-?\d+$/.test(o.$n)) return BigInt(o.$n);
  if ('$d' in o) return typeof o.$d === 'string' ? new Date(o.$d) : new Date(NaN);
  return v;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const valid = (e: unknown): e is SavedProbe => {
  const s = e as Partial<SavedProbe> | null;
  const p = s?.probe as Partial<Probed> | undefined;
  return !!s && typeof s.token === 'string' && ADDRESS.test(s.token) && typeof s.trades === 'number' && Number.isInteger(s.trades) && s.trades >= 0
    && !!p && typeof p === 'object' && typeof p.at === 'string' && !Number.isNaN(Date.parse(p.at)) && typeof p.block === 'number'
    && !!p.tips && typeof p.tips === 'object';
};

/** Cap a check's priority fees (a fee left out is read again by the next check, so it only costs RPC). */
const bounded = (s: SavedProbe): SavedProbe => {
  const tips = Object.entries(s.probe.tips);
  return tips.length <= MAX_TIPS ? s : { ...s, probe: { ...s.probe, tips: Object.fromEntries(tips.slice(0, MAX_TIPS)) } };
};

/** The file's text: entries in the order given, each past MAX_ENTRY_BYTES skipped, and none once MAX_FILE_BYTES is reached. */
export function encodeProbes(entries: readonly SavedProbe[], savedAt: number): { text: string; kept: number } {
  const head = `{"version":${PROBES_VERSION},"savedAt":${Math.floor(savedAt)},"probes":[`, tail = ']}';
  const parts: string[] = [];
  let bytes = head.length + tail.length;
  for (const e of entries) {
    if (parts.length >= MAX_PROBES) break;
    const s = bounded({ token: e.token.toLowerCase(), trades: e.trades, probe: e.probe });
    const json = JSON.stringify(s, replacer), size = Buffer.byteLength(json) + 1;
    if (size > MAX_ENTRY_BYTES) continue;
    if (bytes + size > MAX_FILE_BYTES) break;
    parts.push(json); bytes += size;
  }
  return { text: head + parts.join(',') + tail, kept: parts.length };
}

/** The saved checks, or an error naming why the file cannot be used. Malformed entries are dropped one by one. */
export function decodeProbes(text: string): { savedAt: number; probes: SavedProbe[] } | { error: string } {
  let parsed: { version?: unknown; savedAt?: unknown; probes?: unknown };
  try { parsed = JSON.parse(text, reviver) as typeof parsed; } catch { return { error: 'unparseable' }; }
  if (!parsed || typeof parsed !== 'object') return { error: 'unparseable' };
  if (parsed.version !== PROBES_VERSION) return { error: `version ${String(parsed.version)} (expected ${PROBES_VERSION})` };
  if (!Array.isArray(parsed.probes)) return { error: 'no probes list' };
  return { savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0, probes: parsed.probes.filter(valid).slice(0, MAX_PROBES) };
}

export class ProbeSnapshot {
  private writing = false;
  constructor(private readonly path: string, private readonly source: { savedProbes(): SavedProbe[] },
    private readonly log?: (event: string, fields: Record<string, unknown>) => void) {}

  /**
   * The saved checks, or none when there is no file or it cannot be used (logged, never thrown). With `tracked`, only
   * checks for those coins (the coin snapshot's); checks dated more than a minute ahead of `nowMs` are dropped.
   */
  load(tracked?: ReadonlySet<string>, nowMs = Date.now()): SavedProbe[] {
    let text: string;
    try {
      const size = statSync(this.path).size;
      if (size > MAX_FILE_BYTES) { this.log?.('probes_ignored', { reason: 'too large', bytes: size }); return []; }
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.('probes_ignored', { reason: 'unreadable', error: String((error as Error).message).slice(0, 160) });
      return [];
    }
    const decoded = decodeProbes(text);
    if ('error' in decoded) { this.log?.('probes_ignored', { reason: decoded.error }); return []; }
    return decoded.probes.filter(s => (!tracked || tracked.has(s.token)) && Date.parse(s.probe.at) <= nowMs + 60_000);
  }

  /** Write in the background (one write at a time; a new file replaces the old only once complete). Returns how many. */
  async save(nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
    if (this.writing) return 0;
    this.writing = true;
    try {
      const { text, kept } = encodeProbes(this.source.savedProbes(), nowSec);
      mkdirSync(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, text); await rename(`${this.path}.tmp`, this.path);
      return kept;
    } finally { this.writing = false; }
  }

  /** At shutdown: write now, before the process exits (through its own temporary file, so a background save still
   *  writing cannot interleave with it). */
  saveSync(nowSec = Math.floor(Date.now() / 1000)): number {
    const { text, kept } = encodeProbes(this.source.savedProbes(), nowSec);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.exit.tmp`, text); renameSync(`${this.path}.exit.tmp`, this.path);
    return kept;
  }
}
