import { binary, hex } from '@eko/db';
import type { RpcUsageDb } from './usage.js';
import type { RpcRequest } from './routes.js';
/** Only deployed, non-delegated runtime code is immutable. Empty accounts are never cached. */
export class RpcCodeCache {
  private ready?: Promise<unknown>;
  private pending = new Map<string, Promise<unknown>>();
  constructor(private db: RpcUsageDb) {}
  async read(request: RpcRequest, fetch: () => Promise<unknown>, waitForRecovery = true): Promise<unknown> {
    const [address, selector] = request.params ?? [];
    // Pending/latest reads lack a canonical indexed boundary. State overrides bypass this path entirely.
    let selected=selector;
    if(selected && typeof selected==='object' && 'blockHash' in selected && typeof selected.blockHash==='string') {
      const row=(await this.db.sql.query<{number:string}>('SELECT number FROM chain_blocks WHERE hash=$1',[binary(selected.blockHash)])).rows[0];
      if(!row)return fetch();selected=`0x${BigInt(row.number).toString(16)}`;
    }
    if (request.method !== 'eth_getCode' || typeof address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(address)
      || typeof selected !== 'string' || !/^0x[0-9a-f]+$/i.test(selected)) return fetch();
    const block = BigInt(selected).toString(), key = `${address.toLowerCase()}:${block}:${waitForRecovery}`;
    const found = this.pending.get(key); if (found) return found;
    const work = this.load(address, block, fetch); this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }
  private async load(address: string, block: string, fetch: () => Promise<unknown>) {
    await (this.ready ??= this.db.sql.query(`CREATE TABLE IF NOT EXISTS rpc_code_cache (
      address bytea PRIMARY KEY, code bytea NOT NULL, observed_block bigint NOT NULL, block_hash bytea NOT NULL)`));
    const params = [binary(address), block];
    const pin = (await this.db.sql.query<{ hash: Uint8Array }>('SELECT hash FROM chain_blocks WHERE number=$1', [block])).rows[0];
    if (!pin) return fetch();
    const cached = (await this.db.sql.query<{ code: Uint8Array }>(`SELECT c.code FROM rpc_code_cache c
      JOIN chain_blocks b ON b.number=c.observed_block AND b.hash=c.block_hash
      WHERE c.address=$1 AND c.observed_block<=$2 AND NOT EXISTS (
        SELECT 1 FROM delegations_7702 d WHERE d.authority=c.address AND d.block>=c.observed_block AND d.block<=$2)`, params)).rows[0];
    if (cached) return hex(cached.code);
    const value = await fetch();
    if (typeof value === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(value) && !value.toLowerCase().startsWith('0xef0100')) {
      await this.db.sql.query(`INSERT INTO rpc_code_cache(address,code,observed_block,block_hash)
        SELECT $1,$3,$2,$4 WHERE EXISTS(SELECT 1 FROM chain_blocks WHERE number=$2 AND hash=$4)
        ON CONFLICT(address) DO UPDATE SET code=excluded.code,observed_block=excluded.observed_block,block_hash=excluded.block_hash`,
      [...params, binary(value), pin.hash]);
    }
    return value;
  }
}
