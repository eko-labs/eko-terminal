import { expect, it } from 'vitest';
import { encodeAbiParameters, getAddress, keccak256, toFunctionSelector, type Hex } from 'viem';
import { binary, openDb, type SqlClient } from '@eko/db';
import { loadRegistry } from '../src/registry.js';
import { buildForkManifest, dispatcherSelectors, exactEthUsd, recentPonsCoins, type ManifestReview } from '../src/simulation/fork-manifest.js';
import { parseManifestArgs, requireManifestBudget } from '../src/simulation/fork-manifest-cli.js';
import { referenceDigest } from '../src/simulation/reference.js';
import { RpcGuardError } from '../src/rpc/metered.js';
import type { AnvilRpc } from '../src/simulation/types.js';
import { address, cursor, hash } from './reference-fixtures.js';
const registry=loadRegistry();
const coin=getAddress(address(10)),curve=getAddress(address(11)),factory=registry.requireAddress('pons.factory'),pool=getAddress(address(15));
const tokenSigs=['curve()','launchFactory()','balanceOf(address)','approve(address,uint256)','allowance(address,address)'];
const curveSigs=['buy(uint256,uint256,address)','sell(uint256,uint256,address)','getReserves()','sellableTokens()','graduationThreshold()',
 'graduated()','readyToGraduate()','token()','factory()','pairToken()','currentSnipeTaxBps(address)','feeBps()','creatorTaxBps()',
 'trackedTokens()','realQuoteReserve()','phantomQuote()','reservedTokens()','quoteFeeBalance()','creatorTaxBalance()',
 'deployer()','protocolFeeRecipient()','feeEscrow()'];
// Synthetic dispatcher, not deployed code or a deployable contract.
const code=(sigs:string[]):Hex=>`0x${sigs.map(s=>`63${toFunctionSelector(s).slice(2)}1461000057`).join('')}00`;
const factorySigs=['getLaunchedToken(address)','launchTimestamp(address)','launchSnipeWindow(address)','launchBlock(address)'];
const encode=(ns:bigint[])=>encodeAbiParameters(ns.map(()=>({type:'uint256'})),ns);
function fixture(options:{missing?:string;snipe?:bigint;unknown?:boolean;missingTiming?:boolean;unknownRecord?:boolean;incomplete?:boolean;noCooldown?:boolean;ready?:boolean;reorg?:boolean;budget?:boolean;receipt?:boolean}={}) {
 const tokenCode=code(tokenSigs),curveCode=code(curveSigs.filter(s=>s!==options.missing)),factoryCode=code(factorySigs.filter(s=>!options.missingTiming||s!=='launchSnipeWindow(address)'));
 const review:ManifestReview={schemaVersion:'pons-manifest-review-1',deployments:[{coinCodeHash:keccak256(tokenCode),curveCodeHash:keccak256(curveCode),factoryCodeHash:keccak256(factoryCode),sourceRevision:hash('synthetic-source'),evidenceIds:[hash('synthetic-code-review')],
 timing:{launchTimestamp:'launchTimestamp(address)',snipeWindow:'launchSnipeWindow(address)',launchBlock:'launchBlock(address)'},exemptionEventsExhaustive:!options.incomplete,noCooldown:options.noCooldown??true,noEntryLimits:true}]};
 if(options.unknown)review.deployments=[];
 const calls:Parameters<AnvilRpc['request']>[0][]=[];let headers=0;
 const rpc:AnvilRpc={request:async r=>{
   calls.push(r);if(options.budget&&calls.length>5)throw new RpcGuardError('rpc_session_budget_reached');
   if(r.method==='eth_chainId')return '0x1237';if(r.method==='eth_blockNumber')return '0x69';
   if(r.method==='eth_getBlockByNumber'){headers++;return {number:'0x64',hash:options.reorg&&headers===2?hash('reorg'):cursor.blockHash,timestamp:'0x3e8'};}
   if(r.method==='eth_getCode')return r.params[0]===coin?tokenCode:r.params[0]===curve?curveCode:factoryCode;
   if(r.method==='eth_getLogs')return [{address:curve,blockNumber:'0x63',topics:[keccak256(new TextEncoder().encode('SnipeTaxExempted(address)')),`0x${BigInt(address(22)).toString(16).padStart(64,'0')}`],data:'0x'}];
   if(r.method==='eth_getBlockReceipts')return options.receipt===false?[]:[{blockHash:cursor.blockHash,blockNumber:'0x64',gasUsed:'0x100',gasUsedForL1:'0x10',effectiveGasPrice:'0x1',transactionHash:hash('receipt')}];
   if(r.method==='eth_call') {
     const tx=r.params[0] as {to:Hex;data:Hex};const sig=tx.data.slice(0,10);
     const is=(s:string)=>sig===toFunctionSelector(s);
     if(is('getPool(address,address,uint24)'))return encode([BigInt(pool)]);
     if(tx.to===pool) {
       if(is('slot0()'))return encode([2n**95n,0n,0n,0n,0n,0n,1n]);
       if(is('liquidity()'))return encode([1000n]);
       if(is('token0()'))return encode([BigInt(registry.requireAddress('tokens.WETH'))]);
     }
     const vals:Record<string,bigint[]>={
       'curve()':[BigInt(curve)],'launchFactory()':[BigInt(factory)],'token()':[BigInt(coin)],'factory()':[BigInt(factory)],'pairToken()':[0n],
       'getLaunchedToken(address)':[BigInt(coin),BigInt(curve),BigInt(address(20)),BigInt(address(21)),0n,4200n,3000n,60n,200n,1n,0n,0n,0n,0n,1n],
       'launchTimestamp(address)':[options.snipe?995n:900n],'launchSnipeWindow(address)':[15n],'launchBlock(address)':[90n],
       'currentSnipeTaxBps(address)':[options.snipe??0n],'feeBps()':[100n],'creatorTaxBps()':[200n],
       'graduated()':[0n],'readyToGraduate()':[options.ready?1n:0n],
       'trackedTokens()':[100000n],'realQuoteReserve()':[100n],'phantomQuote()':[100n],'reservedTokens()':[5000n],
       'quoteFeeBalance()':[1n],'creatorTaxBalance()':[2n],'deployer()':[BigInt(address(21))],'protocolFeeRecipient()':[BigInt(address(23))],'feeEscrow()':[BigInt(address(24))],
     };
     const value=Object.entries(vals).find(([s])=>is(s))?.[1];if(value)return encode(options.unknownRecord&&is('getLaunchedToken(address)')?value.slice(0,14):value);
   }
   throw new Error('Unexpected fake archive request');
 }};
 return {rpc,review,calls};
}
it('builds a complete unreviewed measured coin with exact pins, execution, accruals and read digests',async()=>{
 const f=fixture(),r=await buildForkManifest(f.rpc,registry,{block:100n,coins:[coin],review:f.review});
 expect(r.statuses[0].status).toBe('supported');expect(r.manifest.cursor).toEqual(cursor);expect(r.manifest.coins).toHaveLength(1);
 const route=r.statuses[0].route!;expect(route.verification.reviewed).toBe(false);expect(route.origin).toBe('measured');
 expect(route.verification.pins).toHaveLength(3);expect(route.spender).toBe(curve);
 expect(route.execution.buy).toEqual({target:curve,selector:'0x59a87bc1',words:['amount',`0x${'0'.repeat(64)}`,'recipient']});
 expect(route.execution.sell.selector).toBe('0xd04c6983');expect(route.decayEndSec).toBe('915');
 expect(route.accruals?.map(c=>c.selector)).toEqual(['quoteFeeBalance()','creatorTaxBalance()'].map(toFunctionSelector));
 expect(route.exemptions.accounts).toEqual([address(20),address(21),address(22)]);expect(route.exemptions.complete).toBe(true);
 expect(route.cooldown?.seconds).toBe(0);expect(route.feeAccounting.gasIncludesL1).toBe(true);
 for(const e of r.evidence)expect(e.id).toBe(referenceDigest({method:e.method,params:e.params,result:e.result}));
 for(const c of f.calls.filter(c=>['eth_call','eth_getCode'].includes(c.method)))expect(c.params[1]).toEqual({blockHash:cursor.blockHash,requireCanonical:true});
 expect(r.requests).toBe(f.calls.length);expect(r.requests).toBe(38);
});
it('refuses missing deployed selectors and unknown factory layouts',async()=>{
 for(const [options,reason] of [[{missing:'buy(uint256,uint256,address)'},'missing_selector:buy(uint256,uint256,address)'],[{unknown:true},'unknown_factory_layout'],[{unknownRecord:true},'unknown_return_layout'],[{missingTiming:true},'missing_selector:launchSnipeWindow(address)']] as const) {
   const f=fixture(options),r=await buildForkManifest(f.rpc,registry,{block:100n,coins:[coin],review:f.review});
   expect(r.statuses[0].reason).toBe(reason);expect(r.manifest.coins).toEqual([]);
 }
});
it('reads snapshotted timing and records a buy-only gross snipe term at head-minus pin',async()=>{
 const f=fixture({snipe:9000n}),r=await buildForkManifest(f.rpc,registry,{block:{headMinus:5n},coins:[coin],review:f.review});
 expect(r.statuses[0].inSnipeWindow).toBe(true);const route=r.statuses[0].route!;
 expect(route.decayEndSec).toBe('1010');expect(route.buyTerms.at(-1)).toEqual({kind:'temporary',base:'gross',bps:9000n,fixedWei:0n});
 expect(route.sellTerms.map(t=>t.bps)).toEqual([100n,200n]);
});
it('retains incomplete exemption/cooldown/L1 evidence without admitting a route',async()=>{
 for(const [opts,reason] of [[{incomplete:true},'exemptions_incomplete'],[{noCooldown:false},'cooldown_unknown'],[{receipt:false},'l1_receipt_unverified']] as const){
   const f=fixture(opts),r=await buildForkManifest(f.rpc,registry,{block:100n,coins:[coin],review:f.review});
   expect(r.statuses[0].reason).toBe(reason);expect(r.statuses[0].route?.verification.reviewed).toBe(false);expect(r.manifest.coins).toEqual([]);
 }
});
it('computes reduced ETH/USD rationals in both token orders without floating point',async()=>{
 const f=fixture(),r=await buildForkManifest(f.rpc,registry,{block:100n,coins:[coin],review:f.review});
 expect(r.manifest.ethUsd.numerator).toBe('250000000000');expect(r.manifest.ethUsd.denominator).toBe('1');
 expect(exactEthUsd(3n*2n**94n,true,18,6)).toEqual({numerator:'562500000000',denominator:'1'});
 expect(exactEthUsd(3n*2n**94n,false,18,6)).toEqual({numerator:'16000000000000',denominator:'9'});
 expect(()=>exactEthUsd(0n,true,18,6)).toThrow();
});
it('rejects reorgs, propagates budget closure, excludes ready curves and requires finite admission',async()=>{
 const reorg=fixture({reorg:true});await expect(buildForkManifest(reorg.rpc,registry,{block:100n,coins:[coin],review:reorg.review})).rejects.toThrow('pin changed');
 const budget=fixture({budget:true});await expect(buildForkManifest(budget.rpc,registry,{block:100n,coins:[coin],review:budget.review})).rejects.toThrow('rpc_session_budget_reached');
 const ready=fixture({ready:true});expect((await buildForkManifest(ready.rpc,registry,{block:100n,coins:[coin],review:ready.review})).statuses[0].reason).toBe('graduated_or_ready');
 for(const env of [{},{RPC_HTTP_URL:'https://rpc.invalid'},{RPC_HTTP_URL:'https://rpc.invalid',RPC_SESSION_BUDGET:'Infinity'}])expect(()=>requireManifestBudget(env)).toThrow();
 expect(()=>requireManifestBudget({RPC_HTTP_URL:'https://rpc.invalid',RPC_SESSION_BUDGET:'20'})).not.toThrow();
 expect(parseManifestArgs(['head-minus','5','--coins',coin,'--output','manifest.json']).block).toEqual({headMinus:5n});
 expect(()=>parseManifestArgs(['100','--coins',coin,'--from-db','1','--output','manifest.json'])).toThrow();
});
it('uses pinned recent-trade database discovery with deterministic ordering and no writes',async()=>{
 const queries:{sql:string;params?:unknown[]}[]=[];
 const db={query:async(sql:string,params?:unknown[])=>{queries.push({sql,params});return {rows:[{coin:binary(coin)}]};}} as SqlClient;
 expect(await recentPonsCoins(db,100n)).toEqual([coin]);expect(queries[0].params).toEqual(['100']);
 expect(queries[0].sql).toContain("s.venue='pons_curve'");expect(queries[0].sql).toContain('ORDER BY latest.block DESC');
 const f=fixture();const r=await buildForkManifest(f.rpc,registry,{block:100n,fromDb:{db,count:1},review:f.review});expect(r.manifest.coins).toHaveLength(1);
});
it('disassembles dispatcher PUSH4 operands rather than matching selectors inside arbitrary data',()=>{
 const sig=toFunctionSelector('buy(uint256,uint256,address)');
 expect(dispatcherSelectors(code(['buy(uint256,uint256,address)'])).has(sig)).toBe(true);
 expect(dispatcherSelectors(`0x7f${`63${sig.slice(2)}1461000057`.padEnd(64,'0')}`).has(sig)).toBe(false);
 expect(dispatcherSelectors(`0x63${sig.slice(2)}00`).has(sig)).toBe(false);
});

it('orders actual database candidates by latest pinned trade and excludes graduated, future and untraded coins',async()=>{
 const db=await openDb({pgliteDir:':memory:'});
 try {
   await db.sql.query('CREATE TABLE tokens(address bytea,launchpad text,curve bytea,first_block bigint,graduated_block bigint)');
   await db.sql.query('CREATE TABLE swaps(coin bytea,block bigint,log_index integer,tx_hash bytea,venue text)');
   for(let n=1;n<=5;n++)await db.sql.query('INSERT INTO tokens VALUES($1,$2,$3,$4,$5)',[binary(address(n)),'pons',binary(address(100+n)),n===4?'101':'1',n===3?'99':null]);
   for(const [n,b,l] of [[1,90,10],[1,101,20],[2,90,11],[3,99,1],[4,99,2]])await db.sql.query('INSERT INTO swaps VALUES($1,$2,$3,$4,$5)',[binary(address(n)),String(b),l,binary(hash(`trade-${n}-${b}`)),'pons_curve']);
   expect(await recentPonsCoins(db.sql,100n)).toEqual([getAddress(address(2)),getAddress(address(1))]);
 } finally {await db.close();}
});
