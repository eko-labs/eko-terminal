import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { graduationBps } from './graduation.js';
import type { CoinState, Tracker } from './tracker.js';

/**
 * Keeps the graduation columns through a restart. The tracker holds coins in memory only and a restart replays the
 * last few minutes of chain, while Montra's graduates are hours old. So the coins that matter to the columns (graduated,
 * or at least SAVE_FROM_BPS of the way to the line, which covers the ones still climbing) are written to a file on the
 * volume every minute and at shutdown, and handed back to the tracker at start (Tracker.restore). It is small: Montra
 * has graduated about 130 coins in all.
 */
export const SAVE_FROM_BPS = 1000;
const VERSION = 1;

const replacer = (_: string, v: unknown) => typeof v === 'bigint' ? { $n: v.toString() } : v;
const reviver = (_: string, v: unknown) => v && typeof v === 'object' && '$n' in v && Object.keys(v).length === 1 ? BigInt((v as { $n: string }).$n) : v;

export function encodeCoins(coins: CoinState[], savedAt: number) { return JSON.stringify({ version: VERSION, savedAt, coins }, replacer); }
export function decodeCoins(text: string): CoinState[] {
  const parsed = JSON.parse(text, reviver) as { version?: number; coins?: CoinState[] };
  return parsed.version === VERSION && Array.isArray(parsed.coins) ? parsed.coins : [];
}

export class ColumnSnapshot {
  private writing = false;
  constructor(private readonly path: string, private readonly tracker: Tracker, private readonly openMcapHype = () => tracker.openMcapHype) {}

  /** The coins worth keeping: graduated, or far enough along to reach the columns. */
  coins(): CoinState[] {
    return [...this.tracker.coins.values()].filter(c => c.graduated || (graduationBps(c, this.openMcapHype()) ?? 0) >= SAVE_FROM_BPS);
  }

  /** The saved coins, or none when there is no file or it cannot be read. */
  load(): CoinState[] {
    try { return decodeCoins(readFileSync(this.path, 'utf8')); } catch { return []; }
  }

  /** Write in the background (one write at a time; a new file replaces the old only once complete). */
  async save(nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
    if (this.writing) return 0;
    this.writing = true;
    try {
      const coins = this.coins();
      mkdirSync(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, encodeCoins(coins, nowSec)); await rename(`${this.path}.tmp`, this.path);
      return coins.length;
    } finally { this.writing = false; }
  }

  /** At shutdown: write now, before the process exits. */
  saveSync(nowSec = Math.floor(Date.now() / 1000)): number {
    const coins = this.coins();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, encodeCoins(coins, nowSec)); renameSync(`${this.path}.tmp`, this.path);
    return coins.length;
  }
}
