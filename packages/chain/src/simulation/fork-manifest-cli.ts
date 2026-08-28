import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getAddress, type Address } from 'viem';
import { openDb } from '@eko/db';
import { createMeteredClients } from '../rpc/clients.js';
import { rpcConfig, rpcStopReason, type RpcEnv } from '../rpc/metered.js';
import { loadRegistry } from '../registry.js';
import { buildForkManifest, ManifestReviewSchema } from './fork-manifest.js';

export function parseManifestArgs(args:string[]) {
  const values=[...args],pin=values.shift();let block:bigint|{headMinus:bigint};
  const decimal=(s:string|undefined)=>{if(!s||!/^\d+$/.test(s))throw new Error('Decimal integer required');return BigInt(s);};
  if(pin==='head-minus')block={headMinus:decimal(values.shift())};else block=decimal(pin);
  let coins:Address[]|undefined,count:number|undefined,reviewPath:string|undefined,output:string|undefined;
  while(values.length) {
    const flag=values.shift(),value=values.shift();if(!value)throw new Error('Missing argument');
    if(flag==='--coins'&&!coins)coins=value.split(',').map(a=>getAddress(a));
    else if(flag==='--from-db'&&count===undefined){count=Number(decimal(value));if(!Number.isSafeInteger(count)||count<1)throw new Error('Invalid count');}
    else if(flag==='--review'&&!reviewPath)reviewPath=value;
    else if(flag==='--output'&&!output)output=value;
    else throw new Error('Unknown or duplicate argument');
  }
  if(!output||!!coins===!!count)throw new Error('Usage: fork:manifest BLOCK | head-minus N --coins ADDRESS,... | --from-db N [--review review.json] --output manifest.json');
  return {block,coins,count,reviewPath,output};
}
export function requireManifestBudget(env:RpcEnv) {
  if(!env.RPC_HTTP_URL||!env.RPC_SESSION_BUDGET||!Number.isFinite(rpcConfig(env).sessionBudget))throw new Error('Paid RPC and finite RPC_SESSION_BUDGET required');
}
export async function runForkManifest(args:string[],env=process.env) {
  const options=parseManifestArgs(args);requireManifestBudget(env);
  if(options.count&&!env.DATABASE_URL)throw new Error('from-db requires DATABASE_URL');
  const registry=loadRegistry();
  const review=options.reviewPath?ManifestReviewSchema.parse(JSON.parse(await readFile(options.reviewPath,'utf8'))):undefined;
  const clients=createMeteredClients(env,{standalone:true,onSessionBudget:()=>{}});
  let db:Awaited<ReturnType<typeof openDb>>|undefined,reported=false;
  const stop=()=>clients.meter.stop('shutdown_requested');
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    if(options.count)db=await openDb({databaseUrl:env.DATABASE_URL});
    const built=await buildForkManifest({request:r=>clients.forkArchive.request(r as never)},registry,{block:options.block,coins:options.coins,
      fromDb:db?{db:db.sql,count:options.count!}:undefined,review});
    const usage=await clients.meter.usage();
    await writeFile(options.output,JSON.stringify({...built.manifest,manifestBuild:{schemaVersion:'pons-fork-manifest-1',
      statuses:built.statuses,evidence:built.evidence,requests:built.requests,upstreamRequestUnits:usage.sessionUnits,usage}},(_,v)=>typeof v==='bigint'?v.toString():v,2),{mode:0o600});
    for(const s of built.statuses)console.log(JSON.stringify({coin:s.coin,status:s.status,reason:s.reason,inSnipeWindow:s.inSnipeWindow}));
    reported=true;
    console.log(JSON.stringify({event:'fork_manifest_complete',requests:built.requests,upstreamRequestUnits:usage.sessionUnits,supported:built.manifest.coins.length}));
    return built;
  } finally {
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    if(!reported)try {const usage=await clients.meter.usage();console.log(JSON.stringify({event:'fork_manifest_stopped',upstreamRequestUnits:usage.sessionUnits}));}catch {console.error('Manifest usage unavailable');}
    try {await db?.close();}finally {await clients.meter.close();}
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  runForkManifest(process.argv.slice(2)).catch(error=>{console.error(rpcStopReason(error)??'Fork manifest unavailable');process.exitCode=1;});
}
