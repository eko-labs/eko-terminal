import { statfsSync } from 'node:fs';

/**
 * The last line against free accounts filling the volume: per-account caps bound one account, but anyone can make many
 * accounts. When the volume holding EKO's database runs low on free space, writes of user content (new accounts, agents,
 * keys, journal rows, approvals, orders) are refused with 507 until space returns. EKO's own chain memory keeps writing.
 * main.ts installs the guard for the volume (STORE_MIN_FREE_MB, default 512); tests install their own.
 */
export class StorageFull extends Error {
  readonly statusCode = 507;
  readonly status = 507;
  readonly code = 'storage_full';
  constructor() { super('EKO is low on storage space, so new accounts, agents and orders are paused. Try again later.'); }
}

let ok: () => boolean = () => true;
export function setStorageGuard(check: () => boolean) { ok = check; }
/** Whether user-content writes are allowed now (for /health and monitoring). */
export function storageOk(): boolean { return ok(); }
/** Throws StorageFull when user-content writes are paused. */
export function assertStorage() { if (!ok()) throw new StorageFull(); }

/** A check that the filesystem holding `dir` has at least `minFreeMb` free, read at most every `cacheMs`. */
export function freeSpaceCheck(dir: string, minFreeMb: number, statfs: (path: string) => { bavail: number | bigint; bsize: number | bigint } = statfsSync, cacheMs = 30_000, now = () => Date.now()) {
  let at = -Infinity, last = true;
  return () => {
    if (now() - at < cacheMs) return last;
    at = now();
    try { const s = statfs(dir); last = Number(s.bavail) * Number(s.bsize) >= minFreeMb * 1024 * 1024; } catch { last = true; }
    return last;
  };
}
