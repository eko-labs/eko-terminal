import type { ChainDb } from '../../src/client.js';
import type { RetentionOptions, RetentionResult } from '../../src/retention.js';
import type { RetentionRuleRunner } from '../../src/retention-control.js';
import { retentionHorizon, compactTransfers } from '../../src/retention.js';
import { compactLifetimeSwaps, preserveGraduation, retentionBatch, reportRows, addReport } from '../../src/determination-retention.js';
import { emptyLifetime, readLifetime, saveLifetime } from '../../src/lifetime.js';
import { preserveGradePrices } from '../../src/rating-retention.js';
import { snapshotTrending } from '../../src/trending.js';
import { preserveOutcomeSwaps, preserveOutcomeHoldings, outcomeBlocks, type OutcomeCuts } from '../../src/raw-history-checkpoints.js';
import { refreshBars } from '../../src/market.js';

export interface RawHistoryBatch { rule: 'raw_swaps'|'raw_transfers'; rows: number; throughBlock: string; snapshots: number }
export interface RawHistoryControl { pauseEveryBatch?:boolean; onBatch?: (batch: RawHistoryBatch) => Promise<void> }
/** All identities, including quotes, pending and unrated coins. The oldest block is drained before advancing. */
export async function rawHistoryPass(db: ChainDb, options: RetentionOptions, result: RetentionResult, now: number, run: RetentionRuleRunner, control: RawHistoryControl = {}) {
  const swapDays=options.swapDays ?? 1,transferDays=options.transferDays ?? 1;
  if(!Number.isInteger(swapDays) || swapDays<1 || !Number.isInteger(transferDays) || transferDays<1)throw new Error('Raw history requires at least one swap day and one transfer day');
  for(const swaps of [true,false]) await run(swaps ? 'raw_swaps' : 'raw_transfers',async(timeLeft,limit)=>{
    const table=swaps ? 'swaps' : 'token_transfers',key=swaps ? 'coin' : 'token';
    if(options.dryRun) {addReport(result,await reportRows(db,table,'',[]));return;}
    // Keep the cutoff outside its boundary minute; selection then needs only the block-leading index.
    const through=await retentionHorizon(db,swaps ? swapDays : transferDays,Math.floor(now/60000)*60000);
    if(through==null)return;
    // Commit the insert fence BEFORE reading source rows. Concurrent inserts finish first or observe the fence.
    // Do not hold a watermark row lock while building summaries or deleting raw history.
    const acquire = async (tx:ChainDb) => {
      const locked=(await tx.sql.query<{acquired:boolean}>('SELECT pg_try_advisory_xact_lock(4663,208) AS acquired')).rows[0]?.acquired;
      if(!locked)throw Object.assign(new Error('Raw history mutex is busy'),{code:'55P03'});
    };
    await db.tx(async tx=>{
      await acquire(tx);
      await tx.sql.query(`UPDATE raw_history_watermarks SET through_block=greatest(through_block,$2) WHERE name=$1 AND through_block<$2`,[table,through.toString()]);
    });
    let sincePause=0,rankingsComplete=false;
    // Only committed preparation is cached. Eviction bounds memory during a multi-day manual drain.
    const prepared=new Map<string,{cuts:OutcomeCuts;grades:boolean}>();
    while(timeLeft()) {
      // Rankings are immutable full-hour aggregates: commit them independently of the delete batch.
      if(swaps && !rankingsComplete) {
        const saved=await retentionBatch(db,async tx=>{await acquire(tx);return snapshotTrending(tx,through,1);},0);
        result.trendingSnapshots+=saved.saved;
        if(saved.saved) {
          if(control.onBatch)await control.onBatch({rule:'raw_swaps',rows:0,throughBlock:through.toString(),snapshots:saved.saved});
          if(options.pauseMs)await new Promise(resolve=>setTimeout(resolve,options.pauseMs));
        }
        rankingsComplete=saved.complete;
        if(!saved.complete)continue;
      }
      let preparation: {key:string;value:{cuts:OutcomeCuts;grades:boolean}}|undefined;
      const moved=await retentionBatch(db,async tx=>{
        // Reorgs and compactors share this mutex; ordinary indexer inserts never acquire it.
        await acquire(tx);
        const oldest=(await tx.sql.query<{coin:Uint8Array;block:string}>(`SELECT ${key} AS coin,block FROM ${table}
          WHERE block<=$1
          ORDER BY block LIMIT 1 FOR UPDATE`,[through.toString()])).rows[0];
        if(!oldest)return {rows:0,pending:false};
        const coin=oldest.coin,target=BigInt(oldest.block);
        await tx.sql.query('SELECT read_lock_coins($1::bytea[])',[[coin]]);
        if(!await readLifetime(tx,coin)) {
          const data=emptyLifetime();
          if((await tx.sql.query('SELECT 1 FROM history_prunes WHERE coin=$1 AND transfers+swaps+liquidity+pons>0',[coin])).rows.length) {
            data.legacyIncomplete=true;data.earlyComplete=false;data.usdComplete=false;
          }
          await saveLifetime(tx,coin,data);
        }
        const cacheKey=Buffer.from(coin).toString('hex');
        const previous=prepared.get(cacheKey);
        const info={cuts:previous?.cuts ?? await outcomeBlocks(tx,coin),grades:previous?.grades ?? false};
        preparation={key:cacheKey,value:info};
        await preserveGraduation(tx,coin,target);
        let n:number;
        if(swaps) {
          await preserveOutcomeSwaps(tx,coin,(await readLifetime(tx,coin))!,through,info.cuts);
          // Capture every completed grade while all of its raw samples still exist.
          if(!info.grades) {
            await preserveGradePrices(tx,coin,new Date(now),new Date(now-swapDays*86400000+3600000));
            info.grades=true;
          }
          const minutes=(await tx.sql.query<{minute:Date}>(`SELECT DISTINCT date_trunc('minute',ts) AS minute FROM (
            SELECT ts FROM swaps WHERE coin=$1 AND block=$2 ORDER BY block,log_index,tx_hash LIMIT $3) s`,[coin,target.toString(),limit])).rows;
          // Freeze the complete bar before the first partial-minute batch. Later rebuilds keep this summary.
          for(const {minute} of minutes) {
            const frozen=(await tx.sql.query('SELECT 1 FROM raw_history_bar_keys WHERE coin=$1 AND minute=$2',[coin,minute])).rows.length;
            if(!frozen) {
              await refreshBars(tx,[{coin,minute}]);
              await tx.sql.query('INSERT INTO raw_history_bar_keys VALUES($1,$2) ON CONFLICT DO NOTHING',[coin,minute]);
            }
          }
          n=await compactLifetimeSwaps(tx,coin,target,limit,options.firstBlocks,options.cohortSec,options.poolManager,false,true,info.cuts);
          await preserveOutcomeSwaps(tx,coin,(await readLifetime(tx,coin))!,through,info.cuts);
        } else {
          // Only the checkpoint threatened by this block needs building. Earlier raw prefixes
          // have become holder baselines, so this scan shrinks with compaction instead of rescanning days.
          await preserveOutcomeHoldings(tx,coin,target,info.cuts);
          n=await compactTransfers(tx,[coin],target,limit,target);
          if(n)await tx.sql.query('UPDATE coin_lifetime SET revision=revision+1 WHERE coin=$1',[coin]);
        }
        return {rows:n,pending:false,throughBlock:target.toString()};
      },0);
      if(preparation) {
        prepared.delete(preparation.key);prepared.set(preparation.key,preparation.value);
        if(prepared.size>4096)prepared.delete(prepared.keys().next().value!);
      }
      // Sparse blocks often contain only one row. A pause per block capped throughput at ten rows/second.
      // Amortize the same I/O pause over a row budget, while retaining short transactions and global block order.
      sincePause+=moved.rows;
      if(control.pauseEveryBatch || sincePause>=limit) {
        sincePause=0;
        const pause=options.pauseMs ?? 100;
        if(pause)await new Promise(resolve=>setTimeout(resolve,pause));
      }
      result[swaps ? 'historySwaps' : 'historyTransfers']+=moved.rows;
      if(!moved.rows && !moved.pending)return;
      if(control.onBatch)await control.onBatch({rule:swaps ? 'raw_swaps' : 'raw_transfers',rows:moved.rows,
        throughBlock:moved.throughBlock!,snapshots:0});
    }
    result.finished=false;
  });
}
