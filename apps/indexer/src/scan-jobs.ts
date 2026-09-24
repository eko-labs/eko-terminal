import { binary, hex, ScanJobs, scanTarget, type ChainDb } from '@eko/db';
import type { ChainClient } from './types.js';

/** Uses the indexer's existing metered metadata acquisition; the API never writes chain truth.
 * @remarks
 * Claim one acquisition job, use pinned metered code/metadata reads and write token facts only
 * while the lease and indexed head remain current. Indexer role only; no job returns false.
 * Acquisition errors mark the job failed; claim/failure-record SQL errors may reject. Missing
 * identity stays pending and no launch/deployer truth is fabricated.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
 */
export async function acquireScanJob(db:ChainDb,client:ChainClient,jobs=new ScanJobs(db)) {
  const job=await jobs.claim('acquisition');
  if(!job)return false;
  try {
    const coin=scanTarget(job)!;
    const token=(await db.sql.query<{name:string|null;symbol:string|null}>('SELECT name,symbol FROM tokens WHERE address=$1',[binary(coin)])).rows[0];
    if(token?.name!=null && token.symbol!=null){await jobs.finish(job,'evaluating','pending');return true;}
    const head=(await db.sql.query<{number:string;hash:Uint8Array}>('SELECT number,hash FROM chain_blocks ORDER BY number DESC LIMIT 1')).rows[0];
    if(!head)throw new Error('Indexed head unavailable');
    const block=BigInt(head.number);
    if(!token && await client.code(coin,block)==='0x'){await jobs.finish(job,'done','not_found');return true;}
    const metadata=await client.tokenMetadata(coin,block);
    // Missing identity is unavailable evidence, not proof that no token exists.
    if(metadata.name==null || metadata.symbol==null){await jobs.finish(job,'waiting','pending','identity_unavailable');return true;}
    await db.tx(async tx=>{
      const owner=(await tx.sql.query<{lease_id:string}>('SELECT lease_id FROM scan_jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
      if(owner?.lease_id!==job.lease_id)return;
      await tx.sql.query('LOCK TABLE chain_blocks IN SHARE MODE');
      const hash=await tx.blockHash(block);
      if(hash==null || hash!==hex(head.hash))throw new Error('Scan acquisition block changed');
      await tx.insert('tokens',{address:binary(coin),name:metadata.name,symbol:metadata.symbol,decimals:metadata.decimals,total_supply:metadata.totalSupply?.toString()??null,
        supply_block:metadata.totalSupply==null ? null : head.number,first_block:head.number,block:head.number});
      await tx.sql.query('UPDATE tokens SET name=coalesce(name,$2),symbol=coalesce(symbol,$3),decimals=coalesce(decimals,$4),total_supply=coalesce(total_supply,$5::numeric),supply_block=coalesce(supply_block,$6::bigint) WHERE address=$1',
        [binary(coin),metadata.name,metadata.symbol,metadata.decimals,metadata.totalSupply?.toString()??null,metadata.totalSupply==null ? null : head.number]);
      // No fabricated deployer, venue, creation or simulation evidence for arbitrary contracts.
      await new ScanJobs(tx,jobs.now).finish(job,'evaluating','pending');
    });
  } catch {await jobs.fail(job,'acquisition');}
  return true;
}
