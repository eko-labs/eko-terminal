import { toHex } from 'viem';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GuardCursorSchema, type GuardCursor } from '@eko/shared';
import type { RpcMeter } from '../rpc/metered.js';
import { rpcStopReason } from '../rpc/metered.js';
import type { AnvilRpc } from './types.js';
import { referenceDigest } from './reference.js';
import { CHAIN_ID } from '@eko/shared';

/** Anvil fork bootstrap, account/storage loads, proof and historical block/transaction lookup only. */
export const forkMethods = [
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getStorageAt', 'eth_getCode',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_getProof', 'eth_getBlockByNumber',
  'eth_getBlockByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockReceipts',
] as const;
const allowed = new Set<string>(forkMethods);
const stateBlock: Record<string, number> = {eth_getStorageAt:2,eth_getCode:1,eth_getBalance:1,eth_getTransactionCount:1,eth_getProof:2};
class GatewayError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
const reject = (message = 'fork_unpinned_read'): never => { throw new GatewayError(-32602,message); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const quantity = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : reject();
export interface GatewayStats {
  requests: number; forwarded: number; cacheHits: number; rejected: number; upstreamRequestUnits: number;
  methods: Record<string, {requests:number;forwarded:number;cacheHits:number;units:number}>;
}
/** One owner/process per cache directory and Anvil lease. HTTP dispatch and pin changes share one queue. */
export class MeteredForkGateway {
  private pin?: GuardCursor;
  private queue = Promise.resolve();
  private cache = new Map<string,string>();
  private cacheBytes = 0;
  private initialized = false;
  private stats: GatewayStats = {requests:0,forwarded:0,cacheHits:0,rejected:0,upstreamRequestUnits:0,methods:{}};
  constructor(private readonly archive: AnvilRpc, private readonly meter: RpcMeter,
    private readonly directory: string, private readonly maxBytes = 64*1024*1024,
    private readonly log: (event:string, fields:Record<string,unknown>)=>void = (event,fields)=>console.log(JSON.stringify({event,...fields}))) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error('Invalid fork cache cap');
  }
  private serial<T>(work:()=>Promise<T>):Promise<T> {
    const next=this.queue.then(work);this.queue=next.then(()=>{},()=>{});return next;
  }
  setPin(raw: GuardCursor) { return this.serial(async()=>{
    const cursor=GuardCursorSchema.parse(raw);
    if(cursor.chainId!==CHAIN_ID || cursor.boundary!=='block_end' || !Number.isSafeInteger(Number(cursor.blockNumber)))reject('fork_invalid_pin');
    this.pin=cursor;
  }); }
  snapshot():GatewayStats { return structuredClone(this.stats); }
  async idle() { await this.queue; }
  private async load() {
    if(this.initialized)return;
    await mkdir(this.directory,{recursive:true,mode:0o700});
    try {
      const raw=await readFile(join(this.directory,'cache.json'),'utf8');
      if(Buffer.byteLength(raw)>this.maxBytes)throw new Error('oversize');
      const data:unknown=JSON.parse(raw);
      if(!Array.isArray(data))throw new Error('invalid');
      for(const entry of data) {
        if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||!/^0x[0-9a-f]{64}$/.test(entry[0])||typeof entry[1]!=='string')throw new Error('invalid');
        JSON.parse(entry[1]);this.cache.set(entry[0],entry[1]);
      }
      this.cacheBytes=Buffer.byteLength(JSON.stringify([...this.cache]));
    } catch(error) {
      this.cache.clear();this.cacheBytes=0;
      if((error as {code?:string}).code!=='ENOENT')throw new GatewayError(-32000,'fork_cache_unavailable');
    }
    this.initialized=true;
  }
  private validate(method:string, params:readonly unknown[], pin:GuardCursor) {
    const fixed=toHex(BigInt(pin.blockNumber)), i=stateBlock[method];
    if(i!==undefined) {
      if(params.length!==i+1)reject();
      const selector=params[i];
      if(object(selector)) { if(selector.blockHash!==pin.blockHash || selector.requireCanonical!==true || Object.keys(selector).length!==2)reject(); }
      else if(quantity(selector)!==BigInt(fixed))reject();
    } else if(['eth_chainId','net_version','eth_blockNumber'].includes(method)) {
      if(params.length!==0)reject();
    } else if(method==='eth_getBlockByNumber' || method==='eth_getBlockReceipts') {
      if(params.length!==(method==='eth_getBlockByNumber'?2:1) || quantity(params[0])>BigInt(fixed) || method==='eth_getBlockByNumber' && typeof params[1]!=='boolean')reject();
    } else if(method==='eth_getBlockByHash') {
      if(params.length!==2 || params[0]!==pin.blockHash || typeof params[1]!=='boolean')reject();
    } else if(params.length!==1 || typeof params[0]!=='string' || !/^0x[0-9a-f]{64}$/i.test(params[0]))reject();
  }
  async dispatch(input:unknown):Promise<unknown> {
    if(Array.isArray(input)) {
      if(!input.length || input.length>100)return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'fork_invalid_request'}};
      return Promise.all(input.map(r=>this.dispatch(r)));
    }
    return this.serial(async()=>{
      const id=object(input) && (typeof input.id==='string'||typeof input.id==='number') ? input.id : null;
      try {
        this.stats.requests++;
        // JSON-RPC 2.0 allows an omitted params member; Anvil sends eth_blockNumber that way.
        if(!object(input)||input.jsonrpc!=='2.0'||typeof input.method!=='string'||input.params!==undefined&&!Array.isArray(input.params)||id===null)throw new GatewayError(-32600,'fork_invalid_request');
        const method=input.method,params=(input.params??[]) as unknown[];
        if(!allowed.has(method))throw new GatewayError(-32601,'fork_method_rejected');
        const pin=this.pin;if(!pin)throw new GatewayError(-32602,'fork_unpinned_read');this.validate(method,params,pin);
        const row=this.stats.methods[method]??={requests:0,forwarded:0,cacheHits:0,units:0};row.requests++;
        // Anvil must see the pinned head, rather than the provider's moving head.
        if(method==='eth_blockNumber')return {jsonrpc:'2.0',id,result:toHex(BigInt(pin.blockNumber))};
        await this.load();
        const key=referenceDigest({version:1,pin,method,params}), hit=this.cache.get(key);
        if(hit!==undefined) {row.cacheHits++;this.stats.cacheHits++;return {jsonrpc:'2.0',id,result:JSON.parse(hit)};}
        const before=(await this.meter.usage()).sessionUnits;
        let result:unknown;
        try {result=await this.archive.request({method,params});}
        finally {const units=(await this.meter.usage()).sessionUnits-before;row.units+=units;this.stats.upstreamRequestUnits+=units;if(units>0){row.forwarded++;this.stats.forwarded++;}}
        if(method==='eth_chainId' && quantity(result)!==BigInt(pin.chainId) || method==='net_version' && result!==String(pin.chainId))reject('fork_chain_mismatch');
        if(object(result) && ['eth_getBlockByNumber','eth_getBlockByHash'].includes(method)) {
          const n=quantity(result.number);if(n>BigInt(pin.blockNumber))reject();
          if(n===BigInt(pin.blockNumber) && (result.hash!==pin.blockHash || quantity(result.timestamp)!==BigInt(pin.timestampSec)))reject('fork_pin_mismatch');
        }
        if(['eth_getTransactionByHash','eth_getTransactionReceipt'].includes(method) && result!==null && (!object(result)||quantity(result.blockNumber)>BigInt(pin.blockNumber)))reject();
        if(result!==null && result!==undefined) {
          const encoded=JSON.stringify(result);this.cache.set(key,encoded);
          let data=JSON.stringify([...this.cache]);
          while(Buffer.byteLength(data)>this.maxBytes && this.cache.size) {this.cache.delete(this.cache.keys().next().value!);data=JSON.stringify([...this.cache]);}
          this.cacheBytes=Buffer.byteLength(data);
          await writeFile(join(this.directory,'cache.tmp'),data,{mode:0o600});await rename(join(this.directory,'cache.tmp'),join(this.directory,'cache.json'));
        }
        return {jsonrpc:'2.0',id,result};
      } catch(error) {
        this.stats.rejected++;
        const reason=rpcStopReason(error);
        return {jsonrpc:'2.0',id,error:{code:error instanceof GatewayError?error.code:-32000,message:reason??(error instanceof GatewayError?error.message:'fork_upstream_unavailable')}};
      } finally { this.log('fork_gateway_usage',{...this.snapshot(),cacheBytes:this.cacheBytes}); }
    });
  }
  /** Same handler is exercised without sockets in the offline suite. No administrative HTTP routes. */
  async handle(req:IncomingMessage,res:ServerResponse) {
    res.setHeader('content-type','application/json');
    if(req.method!=='POST'||req.url!=='/'||req.headers.origin) {res.writeHead(403);res.end('{"error":"fork_http_rejected"}');return;}
    try {
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req) {size+=Buffer.byteLength(chunk);if(size>1024*1024)throw new Error();chunks.push(Buffer.from(chunk));}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.end(JSON.stringify(await this.dispatch(body)));
    } catch {res.writeHead(400);res.end('{"error":"fork_invalid_request"}');}
  }
}
export async function listenForkGateway(gateway:MeteredForkGateway,port=9545) {
  const server=createServer((req,res)=>{void gateway.handle(req,res);});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Fork gateway unavailable');
  return {url:`http://127.0.0.1:${address.port}`,close:async()=>{await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();});await gateway.idle();}};
}
