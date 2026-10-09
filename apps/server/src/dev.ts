import { withRpcOrigin } from '@eko/chain';
import { EngineWorker } from '@eko/engines';
import { BlockDecoder, createClients, HeadFollower } from '@eko/indexer';
import { createMeteredClients, loadRegistry } from '@eko/chain';
import type { Ctx } from './app.js';
/** Local only: all three roles share the API's one PGlite handle and RPC spend meter. */
export async function startDev(ctx:Ctx) {
  if(ctx.cfg.NODE_ENV==='production' || ctx.cfg.DATABASE_URL)throw new Error('APP_ROLE=dev is for local PGlite only');
  if(!ctx.cfg.RPC_HTTP_URL || !ctx.cfg.RPC_WS_URL)throw new Error('APP_ROLE=dev requires RPC_HTTP_URL and RPC_WS_URL');
  const db=ctx.dbh.chain,meter=ctx.chains.meter,registry=loadRegistry();
  const clients=createClients(ctx.cfg,registry,meter);
  const rpc=createMeteredClients(ctx.cfg,{meter});
  const follower=new HeadFollower(clients,db,new BlockDecoder(clients,registry),{reorgDepth:256});
  const worker=new EngineWorker(db,{bus:db.bus,readBlock:async block=>{const header=await rpc.header(BigInt(block));return {timestamp:header.timestamp,hash:header.hash};},
    client:{getCode:input=>withRpcOrigin('server.dev.L14.c1',()=>rpc.archive.getCode(input)),readContract:async input=>{const value=await withRpcOrigin('server.dev.L14.c2',()=>rpc.archive.readContract(input));if(typeof value!=='bigint')throw new Error('Unexpected Pons read result');return value;}}});
  const jobs=[follower.run(),worker.run()];
  // Attach failures immediately; callers retain the rejection and stop both writers.
  const done=Promise.all(jobs).catch(error=>{follower.stop();worker.stop();throw error;});
  return {done,async close(){follower.stop();worker.stop();await done;}};
}
