import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { GuardCursor } from '@eko/shared';
import { createMeteredClients } from '../rpc/clients.js';
import { RpcGuardError, rpcConfig, type RpcEnv } from '../rpc/metered.js';
import { SerializedMeteredForkLease } from './anvil.js';
import { MeteredForkGateway, listenForkGateway } from './fork-gateway.js';
import type { AnvilRpc } from './types.js';
import { CHAIN_ID } from '@eko/shared';

export function localForkRpc(raw:string):AnvilRpc {
  let url:URL;
  try {url=new URL(raw);}catch{throw new Error('Fork RPC requires a loopback URL');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Fork RPC requires a loopback URL');
  let id=0;
  return {request:async({method,params})=>{
    try {
      const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(60_000)});
      if(!response.ok)throw new Error();
      const body=await response.json() as {result?:unknown;error?:unknown};
      if(body.error) {
        const encoded=JSON.stringify(body.error);
        for(const code of ['rpc_session_budget_reached','rpc_budget_exhausted','shutdown_requested'] as const)if(encoded.includes(code))throw new RpcGuardError(code);
        throw new Error();
      }
      return body.result;
    } catch(error) {if(error instanceof RpcGuardError)throw error;throw new Error('Local fork execution unavailable');}
  }};
}
export function gatewayReset(rpc:AnvilRpc,gateway:MeteredForkGateway,url:string) {
  // Validate the only URL ever passed to Anvil. The paid endpoint stays inside RpcMeter.
  localForkRpc(url);
  return async(cursor:GuardCursor)=>{
    await gateway.setPin(cursor);
    await rpc.request({method:'anvil_reset',params:[{forking:{jsonRpcUrl:url,blockNumber:Number(cursor.blockNumber)}}]});
  };
}
/** CLI-owned process. No direct fork URL on spawn, no keys, no Anvil logs containing RPC response bodies. */
export async function startForkRuntime(env:RpcEnv,cursor:GuardCursor,options:{cacheDir:string;cacheBytes?:number;gatewayPort?:number;anvilPort?:number}) {
  if(!env.RPC_HTTP_URL || !env.RPC_SESSION_BUDGET || !Number.isFinite(rpcConfig(env).sessionBudget))throw new Error('Paid RPC and a finite RPC_SESSION_BUDGET are required');
  const clients=createMeteredClients(env,{standalone:true,onSessionBudget:()=>{}});
  const gateway=new MeteredForkGateway({request:r=>clients.forkArchive.request(r as never)},clients.meter,options.cacheDir,options.cacheBytes);
  let listener:Awaited<ReturnType<typeof listenForkGateway>>|undefined;
  let child:ReturnType<typeof spawn>|undefined;
  let exit:Promise<void>|undefined,closed=false;
  const close=async()=>{
    if(closed)return;closed=true;
    if(child && exit) {
      child.kill('SIGTERM');const timer=setTimeout(()=>child?.kill('SIGKILL'),3000);timer.unref();
      try {await exit;}finally{clearTimeout(timer);}
    }
    try {await listener?.close();}finally{await clients.meter.close();}
  };
  try {
    await gateway.setPin(cursor);listener=await listenForkGateway(gateway,options.gatewayPort);
    const port=options.anvilPort??8545;
    if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid Anvil port');
    child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id',String(CHAIN_ID),'--silent'],{stdio:'ignore'});
    let ended=false;
    exit=new Promise(resolve=>{child!.once('exit',()=>{ended=true;resolve();});child!.once('error',()=>{ended=true;resolve();});});
    const rpc=localForkRpc(`http://127.0.0.1:${port}`);
    let ready=false;
    for(let n=0;n<100&&!ended;n++) {
      // Do not attach to a pre-existing process if this spawn could not bind its port.
      await delay(100);if(ended)break;
      try {await rpc.request({method:'eth_chainId',params:[]});ready=true;break;}catch { /* bounded startup wait */ }
    }
    if(!ready||ended)throw new Error('Owned Anvil failed to start');
    const reset=gatewayReset(rpc,gateway,listener.url),lease=new SerializedMeteredForkLease(rpc,reset);
    const ledger=async()=>({...gateway.snapshot(),meter:await clients.meter.usage()});
    return {gateway,rpc,lease,reset,ledger,close};
  } catch {await close();throw new Error('Metered fork runtime unavailable');}
}
