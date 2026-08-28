import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { GuardCursorSchema, type GuardCursor } from '@eko/shared';
import { AnvilReferenceConfirmation } from './anvil.js';
import { startForkRuntime } from './fork-runtime.js';
import { PonsReferenceSimulation, type PonsCurveRoute, type PonsForkMatch, type PonsResult } from './pons.js';
import { V3ReferenceSimulation, referenceDigest } from './reference.js';
import type { AnvilRpc, ForkMatch, MeteredForkLease, ReferenceResult } from './types.js';
import type { ReferenceRoute } from './v3.js';
import { rpcStopReason } from '../rpc/metered.js';
import type { createMeteredClients } from '../rpc/clients.js';

export interface ForkCheckManifest {
  cursor:GuardCursor;
  ethUsd:{numerator:string;denominator:string;blockHash:string;evidenceIds:string[]};
  coins:({kind:'pons';route:PonsCurveRoute;matches?:PonsForkMatch[];delaySec:number;held?:{sizeUsd:100|1000;account:`0x${string}`;accountClass:'eoa'|'contract';quantity:string}[]}|
    {kind:'v3';route:ReferenceRoute;matches?:ForkMatch[];expected:ForkMatch[]})[];
}
/** Task 068 contract trace runs locally; only native funding and the never-deployed probe code are overridden. */
export async function runV3Fork(lease:MeteredForkLease,input:Parameters<V3ReferenceSimulation['run']>[0]) {
  return lease.withExclusive(async(rpc,reset)=>{
    await reset(input.cursor);
    const archive:AnvilRpc={request:async({method,params})=>{
      if(method==='debug_traceCall') {
        const options=params[2] as {stateOverrides:Record<string,{code:string;balance:string}>;tracer:string;tracerConfig:unknown};
        for(const [address,state] of Object.entries(options.stateOverrides)) {
          await rpc.request({method:'anvil_setCode',params:[address,state.code]});
          await rpc.request({method:'anvil_setBalance',params:[address,state.balance]});
        }
        return rpc.request({method,params:[params[0],'latest',{tracer:options.tracer,tracerConfig:options.tracerConfig}]});
      }
      return rpc.request({method,params});
    }};
    const nested:MeteredForkLease={withExclusive:work=>work(rpc,reset)};
    const simulation=new V3ReferenceSimulation({archive:archive as unknown as ReturnType<typeof createMeteredClients>['archive']},new AnvilReferenceConfirmation(nested));
    return simulation.run(input);
  });
}
export function acquiredMatches(result:PonsResult|ReferenceResult,expected:ForkMatch[]=[]): (PonsForkMatch|ForkMatch)[] {
  const caseId=`${result.coin}:${result.cursor.blockHash}:${result.routeId}`;
  if(result.methodVersion==='pons-reference-1') {
    if(result.origin!=='measured')return [];
    return result.observations.flatMap(o=>{
    if(o.mode!=='round_trip'||!o.localPrediction||!o.validSellState||o.entryNetworkWei===null||o.exitNetworkWei===null)return [];
    const model=o.localPrediction;
    const base={venue:'pons_curve' as const,sizeUsd:result.sizeUsd,accountClass:o.accountClass,caseId:`${caseId}:${o.accountClass}:${o.delaySec}`,
      expectedSpent:model.spent,actualSpent:o.spent,expectedReturned:model.returned,actualReturned:o.returned,
      expectedBlocked:BigInt(model.returned)*20n<BigInt(o.quotedSell),actualBlocked:!o.sellOk||BigInt(o.returned)*20n<BigInt(o.quotedSell),
      origin:'measured' as const,sourceRevision:(result.routeSnapshot as PonsCurveRoute).verification.sourceRevision,modelVersion:'pons-output-floor-1' as const,
      evidenceIds:[result.traceDigest],delaySec:o.delaySec,
      expectedAllInEntry:(BigInt(model.spent)+BigInt(o.entryNetworkWei)).toString(),actualAllInEntry:(BigInt(o.spent)+BigInt(o.entryNetworkWei)).toString(),
      expectedNetExit:(BigInt(model.returned)-BigInt(o.exitNetworkWei)).toString(),actualNetExit:o.netExitWei!};
    return [{...base,id:referenceDigest({base,account:o.account})}];
    });
  }
  const observations=[...(result.probe?[{accountClass:'contract' as const,value:result.probe}]:[]),...result.deep.map(value=>({accountClass:'eoa' as const,value}))];
  return observations.flatMap(({accountClass,value})=>{
    // Expected v3 values must come from a separately acquired source, never copied from this run.
    const e=expected.find(e=>e.sizeUsd===result.sizeUsd&&e.accountClass===accountClass&&e.venue==='uniswap_v3'&&e.caseId===`${caseId}:${accountClass}`);if(!e||!value.buyOk)return [];
    const base={...e,caseId:`${caseId}:${accountClass}`,actualSpent:value.spent,actualReturned:value.returned,
      actualBlocked:!value.sellOk||BigInt(value.quotedSell)>0n&&BigInt(value.returned)*20n<BigInt(value.quotedSell)};
    return [{...base,id:referenceDigest(base)}];
  });
}
export async function runForkChecks(manifestPath:string,outputPath:string,limit?:number) {
  return runForkCheckManifest(JSON.parse(await readFile(manifestPath,'utf8')) as ForkCheckManifest,outputPath,limit);
}
export async function runForkCheckManifest(manifest:ForkCheckManifest,outputPath:string,limit?:number) {
  const cursor=GuardCursorSchema.parse(manifest.cursor),price=manifest.ethUsd;
  const numerator=BigInt(price.numerator),denominator=BigInt(price.denominator);
  if(numerator<=0n||denominator<=0n||price.blockHash!==cursor.blockHash||!price.evidenceIds.length||!manifest.coins.length)throw new Error('Pinned manifest and ETH USD provenance required');
  const count=limit??manifest.coins.length;
  if(!Number.isSafeInteger(count)||count<1||count>manifest.coins.length)throw new Error('Invalid coin count');
  const runtime=await startForkRuntime(process.env,cursor,{cacheDir:process.env.EKO_FORK_CACHE_DIR??'.data/fork-cache',cacheBytes:Number(process.env.EKO_FORK_CACHE_BYTES??64*1024*1024),
    gatewayPort:Number(process.env.EKO_FORK_GATEWAY_PORT??9545),anvilPort:Number(process.env.EKO_FORK_ANVIL_PORT??8545)});
  const results:(PonsResult|ReferenceResult)[]=[],matches:(PonsForkMatch|ForkMatch)[]=[];
  let failure:string|null=null;
  const stop=()=>{failure='shutdown_requested';};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    for(const coin of manifest.coins.slice(0,count)) {
      if(failure)break;
      if(coin.kind==='pons') {
        if(coin.route.origin!=='measured'||!coin.route.verification.reviewed)throw new Error('Reviewed measured Pons route required');
        for(const term of [...coin.route.buyTerms,...coin.route.sellTerms]) {term.bps=BigInt(term.bps);term.fixedWei=BigInt(term.fixedWei);}
      } else coin.route.deadline=BigInt(coin.route.deadline);
      for(const sizeUsd of [100,1000] as const) {
        if(failure)break;
        const sizeWei=BigInt(sizeUsd)*denominator*10n**18n/numerator;
        const result=coin.kind==='pons'?await new PonsReferenceSimulation(runtime.lease).run({cursor,route:coin.route,matches:coin.matches??[],sizeUsd,sizeWei,delaySec:coin.delaySec}):
          await runV3Fork(runtime.lease,{cursor,route:coin.route,matches:coin.matches??[],sizeUsd,sizeWei});
        results.push(result);matches.push(...acquiredMatches(result,coin.kind==='v3'?coin.expected:[]));
      }
      if(coin.kind==='pons'&&!failure)for(const held of coin.held??[])results.push(await new PonsReferenceSimulation(runtime.lease).run({cursor,route:coin.route,matches:coin.matches??[],sizeUsd:held.sizeUsd,
        sizeWei:BigInt(held.sizeUsd)*denominator*10n**18n/numerator,delaySec:0,sellOnly:{...held,quantity:BigInt(held.quantity)}}));
    }
  } catch(error) {failure=rpcStopReason(error)??'fork_check_unavailable';}
  finally {
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    try {
      const ledger=await runtime.ledger();
      await writeFile(outputPath,JSON.stringify({schemaVersion:'metered-fork-check-1',cursor,failure,upstreamRequestUnits:ledger.upstreamRequestUnits,cacheHits:ledger.cacheHits,
        ledger,chargedCostUsd:null,pricing:null,results,matches,
        nextAction:'Review matches and independently reproduce restrictions; observations do not establish route acceptance.'},null,2));
    } finally {await runtime.close();}
  }
  return {failed:!!failure||results.some(r=>['provider_failure','unsupported','fidelity_mismatch'].includes(r.status)),results:results.length,matches:matches.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [manifest,output,count]=process.argv.slice(2);
  if(!manifest||!output)throw new Error('Usage: fork-check-cli.ts manifest.json output.json [coin-count]');
  runForkChecks(manifest,output,count===undefined?undefined:Number(count)).then(result=>{console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;})
    .catch(()=>{console.error('Metered fork check unavailable');process.exitCode=1;});
}
