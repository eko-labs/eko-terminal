import { binary, hex, type ChainDb } from '@eko/db';
import { readPonsProfile, isRpcPaidDeferred, rpcStopReason, isTransientRpcUnavailable, type PonsProfileClient } from '@eko/chain';
import { keccak256, toFunctionSelector } from 'viem';
import type { Address } from '@eko/shared';
import type { ClockCache } from './activity.js';
import type { LoadedSources } from './sources.js';
type Profile = NonNullable<LoadedSources['profile']>;
const readers = new WeakMap<ChainDb, PonsProfiles>();
/** Function selectors whose presence in a token's dispatch table gives its owner a power over holders. */
const POWERS: Record<'mint' | 'blacklist' | 'pause' | 'upgrade' | 'owner', string[]> = {
  mint: ['mint(address,uint256)', 'mint(uint256)', 'mintTo(address,uint256)'],
  blacklist: ['blacklist(address)', 'addToBlacklist(address)', 'setBlacklist(address,bool)', 'blacklistAddress(address,bool)', 'isBlacklisted(address)', 'addBot(address)', 'setBots(address[],bool)'],
  pause: ['pause()', 'unpause()', 'setTradingEnabled(bool)', 'enableTrading()'],
  upgrade: ['upgradeTo(address)', 'upgradeToAndCall(address,bytes)'],
  owner: ['owner()', 'transferOwnership(address)', 'renounceOwnership()'],
};
const POWER_SELECTORS = Object.fromEntries(Object.entries(POWERS).map(([power, sigs]) => [power, sigs.map(sig => toFunctionSelector(sig).slice(2))])) as Record<keyof typeof POWERS, string[]>;
/**
 * Owner powers in a token's bytecode: a Solidity dispatch table pushes each 4-byte selector (PUSH4, 0x63), so a power is
 * present when one of its selectors is. Every Pons token checked on 2026-10-12 is the same 3,248-byte template with none
 * (transfer, approve, burn and views only). A heuristic over the dispatch table, not a source review.
 */
export function ownerPowers(code: string) {
  const hex = code.toLowerCase();
  const has = (power: keyof typeof POWERS) => POWER_SELECTORS[power].some(sel => hex.includes(`63${sel}`));
  return { mint: has('mint'), blacklist: has('blacklist'), pause: has('pause'), upgrade: has('upgrade'), owner: has('owner'), codeBytes: Math.max(0, (hex.length - 2) / 2) };
}
export function ponsProfiles(db: ChainDb) {
  let found = readers.get(db); if (!found) { found = new PonsProfiles(db); readers.set(db, found); } return found;
}
/** Unreviewed getters are observations at one exact canonical checkpoint, never fixed template facts.
 * TODO(spec): Getter invalidation needs complete setter/upgrade events and a verified anti-snipe time schedule.
 * Cross-block reuse requires the separate reviewed effective profile path. Legacy static rows are ignored.
 */
class PonsProfiles {
  private queues = new Map<Address, Promise<unknown>>();
  private attempts = new Map<string, Promise<Profile | undefined>>();
  constructor(private db: ChainDb) {}
  read(coin: Address, curve: Address, block: number, hash: Uint8Array | null, client?: PonsProfileClient, _clock?: ClockCache) {
    if (!hash) return Promise.resolve(undefined);
    if (!client || client.outageNonBlocking) return this.load(coin, curve, block, hash, client);
    const key = `${coin}:${curve}:${block}:${hex(hash)}`;
    const found = this.attempts.get(key); if (found) return found;
    const next = (this.queues.get(coin) ?? Promise.resolve()).then(() => this.load(coin, curve, block, hash, client));
    this.queues.set(coin, next.catch(() => {})); this.attempts.set(key, next);
    next.then(result => { if (!result && !client) this.attempts.delete(key); }, () => { this.attempts.delete(key); });
    // Bound memory; durable successful checkpoint reads are available on restart.
    if (this.attempts.size > 2048) this.attempts.delete(this.attempts.keys().next().value!);
    return next;
  }
  private async load(coin: Address, curve: Address, block: number, hash: Uint8Array, client?: PonsProfileClient): Promise<Profile | undefined> {
    const row = (await this.db.sql.query<{ block_hash: Uint8Array | null; profile: Profile | null }>(
      'SELECT block_hash,profile FROM engine_reads WHERE coin=$1 AND block=$2', [binary(coin), block])).rows[0];
    if (row?.block_hash && hex(row.block_hash) === hex(hash) && row.profile?.observationVersion === 'pons-getters-2' && row.profile.curve === curve)
      return row.profile;
    if (!client) return undefined;
    let profile: Profile | undefined;
    try {
      const read = await readPonsProfile(client, coin, curve, BigInt(block));
      profile = { creatorTaxPct: read.creatorTaxPct, feePct: read.feePct, antiSnipeActive: read.antiSnipeActive,
        codehash: keccak256(read.code), curve, observationVersion: 'pons-getters-2', powers: ownerPowers(read.code) };
    } catch (error) {
      // A spent daily paid budget leaves this checkpoint's getters unknown and unstored: the card says not fully checked
      // and a later checkpoint reads them again. Throwing stopped the scanner, and each restart's cold refresh spent
      // the budget-less hours re-failing (2026-10-10 on the new host: 599 restarts overnight).
      if(isRpcPaidDeferred(error))throw error;
      const stop = rpcStopReason(error);
      if (stop === 'rpc_budget_exhausted') return undefined;
      if (stop || isTransientRpcUnavailable(error)) throw error; /* Missing reads remain unknown at this checkpoint, never a permanent failure or zero. */
    }
    await this.db.sql.query('INSERT INTO engine_reads VALUES($1,$2,$3,$4) ON CONFLICT(coin,block) DO UPDATE SET block_hash=excluded.block_hash,profile=excluded.profile',
      [binary(coin), block, hash, profile ? JSON.stringify(profile) : null]);
    return profile;
  }
}
