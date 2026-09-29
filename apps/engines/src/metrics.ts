import { performance } from 'node:perf_hooks';
import type { PonsProfileClient } from '@eko/chain';
import type { BlockReader } from './activity.js';
export class ReplayMetrics {
  private start=performance.now();private rpcStart=0;private activeRpc=0;
  sourceMs=0;writeMs=0;rpcMs=0;rpcCalls:Record<string,number>={};
  async rpc<T>(method:string,read:()=>Promise<T>):Promise<T> {
    this.rpcCalls[method]=(this.rpcCalls[method] ?? 0)+1;if(this.activeRpc++===0)this.rpcStart=performance.now();
    try{return await read();}finally{if(--this.activeRpc===0)this.rpcMs+=performance.now()-this.rpcStart;}
  }
  profile(client:PonsProfileClient):PonsProfileClient {return {
    readContract:input=>this.rpc(input.functionName,()=>client.readContract(input)),
    getCode:input=>this.rpc('eth_getCode',()=>client.getCode(input)),
    ...(client.readGetters ? {readGetters: (input: Parameters<NonNullable<PonsProfileClient['readGetters']>>[0])=>this.rpc('pons_getters_batch',()=>client.readGetters!(input))} : {}),
  };}
  headers(read:BlockReader):BlockReader {
    const result:BlockReader=block=>this.rpc('eth_getBlockByNumber',()=>read(block));
    if(read.readMany)result.readMany=blocks=>{this.rpcCalls.eth_getBlockByNumber=(this.rpcCalls.eth_getBlockByNumber ?? 0)+blocks.length;return this.rpc('headerBatches',()=>read.readMany!(blocks));};return result;
  }
  snapshot(evaluations:number) {const elapsedMs=performance.now()-this.start;return {rssMb:process.memoryUsage().rss/1024/1024,evaluationsPerSec:elapsedMs>0?evaluations*1000/elapsedMs:0,elapsedSec:elapsedMs/1000,
    timeShare:{sourceLoading:this.sourceMs/elapsedMs,writeTransaction:this.writeMs/elapsedMs,rpc:this.rpcMs/elapsedMs},rpcCalls:{...this.rpcCalls}};}
}
