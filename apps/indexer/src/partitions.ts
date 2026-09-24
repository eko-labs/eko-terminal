import { PartitionLockTimeoutError, type ChainDb } from '@eko/db';
import { log, type Logger } from './types.js';

/** Separate short transactions; never overlap a previous provisioning pass. Drain before closing the DB. */
export function startPartitionMaintenance(db:ChainDb,logger:Logger=log,intervalMs=600_000) {
  let pending:Promise<void>|undefined;
  const tick=()=>{
    if(pending)return;
    pending=db.ensurePartitions(new Date()).catch(error=>{
      if(!(error instanceof PartitionLockTimeoutError))logger('partition_maintenance_failed',{code:(error as {code?:string}).code ?? 'maintenance_failed'});
    }).finally(()=>{pending=undefined;});
  };
  const timer=setInterval(tick,intervalMs);
  tick();
  return async()=>{clearInterval(timer);await pending;};
}
