import { withRpcOrigin } from '@eko/chain';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, TransactionReceiptNotFoundError } from 'viem';
import type { Hex } from 'viem';
import { robinhood } from 'viem/chains';
import { prepareTransactionRequest } from 'viem/actions';
import { createMeteredClients, loadRegistry } from '@eko/chain';
import { migrate, migrateEngines, openDb, ReceiptCommitJournal, launchEmitter } from '@eko/db';
import { commitData, ReceiptWorker, receiptsAbi } from './worker.js';
import type { ReceiptChain } from './worker.js';

const config=z.object({APP_ROLE:z.literal('receipts'),DATABASE_URL:z.string().optional(),PGLITE_DIR:z.string().default('.data/indexer'),
  RPC_HTTP_URL:z.url(),RECEIPTS_COMMITTER_KEY:z.string().optional(),RECEIPTS_COMMITTER_KEY_FILE:z.string().optional()});
async function main() {
  const parsed=config.safeParse(process.env);
  if (!parsed.success) throw new Error('Invalid receipts environment');
  const env=parsed.data;
  if (Boolean(env.RECEIPTS_COMMITTER_KEY) === Boolean(env.RECEIPTS_COMMITTER_KEY_FILE)) throw new Error('One committer secret source required');
  const readAccount=async () => {
    const key=env.RECEIPTS_COMMITTER_KEY_FILE ? (await readFile(env.RECEIPTS_COMMITTER_KEY_FILE,'utf8')).trim() : env.RECEIPTS_COMMITTER_KEY!;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Invalid committer secret');
    return privateKeyToAccount(key as Hex);
  };
  await readAccount();
  const registry=loadRegistry().requireAddress('ours.receiptsRegistry');
  const db=await openDb({databaseUrl:env.DATABASE_URL,pgliteDir:env.PGLITE_DIR});
  const telemetry=launchEmitter(db.sql,()=>console.log(JSON.stringify({event:'launch_metrics_unavailable'})));
  let worker: ReceiptWorker | undefined;
  let stopped=false;
  const stop=() => {stopped=true;worker?.stop();};
  const rpc=createMeteredClients(process.env,{db,onSessionBudget:stop});
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try {
    await migrate(db);await migrateEngines(db);
    const chain: ReceiptChain = {
      getChainId:() => rpc.paid.getChainId(),
      receipt:async hash => {try {return await rpc.paid.getTransactionReceipt({hash});} catch(error) {if (error instanceof TransactionReceiptNotFoundError) return null;throw error;}},
      block:async blockNumber => (await rpc.paid.getBlock({blockNumber})).hash,
      finalized:async () => {const block=await rpc.paid.getBlock({blockTag:'finalized'});if (block.number===null || !block.hash) throw new Error('Finalized receipt block unavailable');return block.number;},
      sign:async batch => {
        // A mounted SOPS/host-secret file is re-read only when a fresh attempt is
        // needed. Pending transactions always retain the old committer and hash.
        const account=await readAccount();
        const committer=await withRpcOrigin('engines.receipts_cli.L45',()=>rpc.paid.readContract({address:registry,abi:receiptsAbi,functionName:'committer'})) as string;
        if (committer.toLowerCase() !== account.address.toLowerCase()) throw new Error('Committer rotation requires secret reload');
        const code=await withRpcOrigin('engines.receipts_cli.L47',()=>rpc.paid.getCode({address:registry}));
        if (!code || code==='0x') throw new Error('Receipt registry code unavailable');
        const request=await prepareTransactionRequest(rpc.paid,{account,chain:robinhood,to:registry,data:commitData(batch),value:0n,type:'eip1559'});
        const raw=await account.signTransaction({chainId:4663,type:'eip1559',nonce:request.nonce,gas:request.gas!,
          maxFeePerGas:request.maxFeePerGas!,maxPriorityFeePerGas:request.maxPriorityFeePerGas!,to:registry,data:commitData(batch),value:0n});
        return {tx_hash:keccak256(raw),batch_id:batch.id,registry,committer:account.address,nonce:String(request.nonce),raw_transaction:raw};
      },
      broadcast:raw => rpc.paid.sendRawTransaction({serializedTransaction:raw}),
    };
    worker=new ReceiptWorker(new ReceiptCommitJournal(db),chain,registry,(event,fields) => { console.log(JSON.stringify({event,...fields}));if(event==='receipt_committed')telemetry.emit('receipt_commit_lag_s',Number(fields?.['receipts.commit_lag_s'])); });
    if (stopped) worker.stop();
    console.log(JSON.stringify({event:'receipts_started'}));
    await worker.run();
    console.log(JSON.stringify({event:'receipts_stopped'}));
  } finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await telemetry.drain();await rpc.meter.close();await db.close();}
}
main().catch(() => {console.error('Receipts halted: check role, committer secret, registry, metered RPC and database.');process.exit(1);});
