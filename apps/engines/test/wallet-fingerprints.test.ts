import { readFile } from 'node:fs/promises';
import { recordBuyerStatistics } from '../../../packages/db/src/lifetime.js';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, migrateEngines, binary, runRetention, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { walletFeatures, sizeBucket, entropy, type FeatureInput, type FingerprintSwap, type WalletFeatures } from '../src/watcher/features.js';
import { FP_MODEL, likelyAgentScore, resolveFingerprintLabel } from '../src/watcher/score.js';
import { calldataShape } from '../src/watcher/calldata.js';
import { fingerprintWindows, loadFingerprintInput, updateFingerprintWallet, replayFingerprints, refreshFingerprints, FINGERPRINT_REFRESH_ROW_BOUND, FINGERPRINT_CUTS_PER_REFRESH } from '../src/watcher/store.js';
import { walletLabelsAt, writeRegistryLabels } from '../src/registry-labels.js';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const wallet=address(1),router=address(2),coin=address(3);
const sec=1790985600;
const swap=(n:number,changes:Partial<FingerprintSwap>={}):FingerprintSwap=>({block:n,sec:sec+n,txHash:hash(n),logIndex:1,coin:address(n),buy:true,router,aa4337:false,shape:'shape',selector:'0x12345678',ethNotional:'1000000000000000000',gasLimit:'100000',gasUsed:'80000',orbio:false,...changes});
const input=(swaps:FingerprintSwap[],changes:Partial<FeatureInput>={}):FeatureInput=>({swaps,block:1000,sec:sec+1000,delegated7702:false,knownRouters:[router],userops:[],useropsComplete:true,reactions:[],...changes});
const empty=():WalletFeatures=>walletFeatures(input([]));
describe('fp-1.0.0 pure features',()=>{
  it('defaults both windows to one day and bounds refreshes by watcher evidence',()=>{
    expect(fingerprintWindows({},{})).toEqual({lookbackDays:1,refreshDays:1});
    expect(fingerprintWindows({},{FINGERPRINT_LOOKBACK_DAYS:'4',FINGERPRINT_REFRESH_DAYS:'2'})).toEqual({lookbackDays:4,refreshDays:2});
    expect(()=>fingerprintWindows({},{FINGERPRINT_LOOKBACK_DAYS:'7'})).toThrow('must fit');
    expect(()=>fingerprintWindows({lookbackDays:0},{})).toThrow('must fit');
    expect(walletFeatures(input([swap(1,{sec:sec+1000-4*86400})],{lookbackDays:4})).swaps).toBe(1);
    expect(walletFeatures(input([swap(1,{sec:sec+1000-4*86400})])).swaps).toBe(0);
  });
  it('uses at most 200 swaps within an inclusive configured cut, excludes future blocks and deduplicates',()=>{
    const swaps=Array.from({length:201},(_,n)=>swap(n+1));
    swaps.push(swap(1001),swap(999,{sec:sec+1001}),swap(0,{sec:sec+1000-3*86400-1}),swap(201));
    expect(walletFeatures(input(swaps)).swaps).toBe(200);
    expect(walletFeatures(input([swap(1,{sec:sec+1000-86400})])).swaps).toBe(1);
    expect(()=>walletFeatures(input([swap(1),swap(1,{aa4337:true})]))).toThrow('Conflicting');
  });
  it('computes actor shares, modal routers/shapes, buy sizes and distinct transaction gas patterns',()=>{
    const swaps=Array.from({length:20},(_,n)=>swap(n+1,{aa4337:n<11,router:n<17?router:address(4),shape:n<19?'a':'b',ethNotional:n<13?'10004':'10009',gasLimit:String((n+1)*1000),gasUsed:String((n+1)*500)}));
    const f=walletFeatures(input(swaps,{userops:[{hash:hash(1),block:1,sec,paymaster:true},{hash:hash(1),block:1,sec,paymaster:true},{hash:hash(2),block:2,sec,paymaster:false}]}));
    expect(f).toMatchObject({aa4337Share:0.55,paymasterShare:0.5,routerTopShare:0.85,routerKnownAgent:true,calldataShapeShare:0.95,sizeRepeatShare:0.65,gasLimitRepeatShare:1,intervalCv:0,orbioCredit:false});
    expect(sizeBucket('99999')).toBe('100000');expect(sizeBucket('10004')).toBe('10000');expect(sizeBucket('0')).toBe('0');
  });
  it('uses block gaps and reaction times for same-second trades with sample floors',()=>{
    const swaps=Array.from({length:20},(_,n)=>swap(n+1,{sec}));
    expect(walletFeatures(input(swaps)).intervalCv).toBe(0);expect(walletFeatures(input(swaps.slice(1))).intervalCv).toBeNull();
    const reactions=Array.from({length:5},(_,n)=>({coin:address(n+10),firstBuyBlock:10+n,launchBlock:1,buyerRank:50}));
    expect(walletFeatures(input(swaps,{reactions})).reactionP10Blocks).toBe(9);
    expect(walletFeatures(input(swaps,{reactions:reactions.slice(1)})).reactionP10Blocks).toBeNull();
    expect(walletFeatures(input(swaps,{reactions:reactions.map(r=>({...r,buyerRank:51}))})).reactionP10Blocks).toBeNull();
    expect(walletFeatures(input(swaps,{block:9,reactions})).reactionP10Blocks).toBeNull();
  });
  it('computes Shannon entropies, seven-day UTC hours, selector/counterparty pairs and explicit missing observations',()=>{
    expect(entropy(Array.from({length:60},(_,n)=>String(n)))).toBeCloseTo(Math.log2(60));
    const swaps=Array.from({length:24},(_,n)=>swap(n+1,{sec:sec+n*3600}));
    expect(walletFeatures(input(swaps,{sec:sec+86400})).hourEntropy).toBeCloseTo(Math.log2(24));
    expect(walletFeatures(input([swap(1,{sec:sec-8*86400})],{sec})).hourEntropy).toBeNull();
    const f=walletFeatures(input([swap(1,{aa4337:null,shape:null,gasLimit:null,ethNotional:null,orbio:null})],{delegated7702:null,knownRouters:null,useropsComplete:false}));
    expect(f.missing).toEqual(expect.arrayContaining(['aa4337Share','calldataShapeShare','gasLimitRepeatShare','sizeRepeatShare','orbioCredit','paymasterShare','delegated7702','routerKnownAgent']));
    expect(f.txEntropy).toBe(0);expect(empty().swaps).toBe(0);
    expect(walletFeatures(input([swap(1,{buy:false,orbio:true})])).orbioCredit).toBeNull();
    expect(walletFeatures(input([swap(1,{orbio:true}),swap(2,{orbio:null})])).orbioCredit).toBe(true);
  });
  it.each([
    ['routerTopShare',0.8,0.80001,0.6],['calldataShapeShare',0.9,0.90001,0.9],['intervalCv',0.35,0.34999,1.3],
    ['secOfMinuteEntropy',3,2.99999,1.1],['hourEntropy',4.3,4.30001,0.7],['reactionP10Blocks',11,10,1.8],
    ['sizeRepeatShare',0.6,0.60001,0.9],['gasLimitRepeatShare',0.8,0.80001,0.7],
  ] as const)('honors exact %s score boundary',(key,off,on,weight)=>{
    const f={...empty(),swaps:5,[key]:off},base=likelyAgentScore(f);
    const logit=(v:number)=>Math.log(v/(1-v));
    expect(logit(likelyAgentScore({...f,[key]:on}))-logit(base)).toBeCloseTo(weight);
  });
  it('implements all continuous and boolean weights and precedence independently of risk bands',()=>{
    const f={...empty(),swaps:5};
    for(const [key,weight] of [['aa4337Share',1.6],['paymasterShare',0.8],['delegated7702',1.2],['routerKnownAgent',2],['orbioCredit',1.5]] as const) {
      const on=typeof f[key]==='boolean'||key==='delegated7702'||key==='routerKnownAgent'||key==='orbioCredit'?true:1;
      expect(likelyAgentScore({...f,[key]:on})).toBeCloseTo(1/(1+Math.exp(-(-3.2+weight))));
    }
    const model={...FP_MODEL,bias:0,threshold:0.5};
    expect(resolveFingerprintLabel(f,{model})).toMatchObject({label:'likely_agent',confidence:0.5,tier:null,beta:true});
    expect(resolveFingerprintLabel({...f,swaps:4})).toMatchObject({label:'human',tier:'low',score:0});
    const crew={status:'qualified' as const,crewId:'crew_fixture',confidence:0.95,evidence:[]};
    expect(resolveFingerprintLabel(f,{model,crew})).toMatchObject({label:'crew',tier:'high'});
    expect(resolveFingerprintLabel(f,{model,crew,declared:true})).toMatchObject({label:'declared_agent',confidence:0.99,crewId:'crew_fixture'});
    expect(()=>resolveFingerprintLabel(f,{crew:{...crew,status:'candidate'} as never})).toThrow('Unqualified');
    for(const confidence of [0.6,0.75,0.9])expect(resolveFingerprintLabel(f,{crew:{...crew,confidence}}).tier).toBe(confidence===0.6?'low':confidence===0.75?'medium':'high');
  });
  it('decodes supported multicall shapes without conflating deadlines or missing minimum-output observations',()=>{
    const abi=parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)','function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])']);
    const call=(minimum:bigint)=>encodeFunctionData({abi,functionName:'exactInputSingle',args:[{tokenIn:coin,tokenOut:router,fee:3000,recipient:wallet,amountIn:1n,amountOutMinimum:minimum,sqrtPriceLimitX96:0n}]});
    const data=(minimum:bigint,deadline:number)=>encodeFunctionData({abi,functionName:'multicall',args:[BigInt(deadline),[call(minimum)]]});
    expect(calldataShape(data(0n,sec+120),sec).shape).toBe(calldataShape(data(0n,sec+130),sec).shape);
    expect(calldataShape(data(1n,sec+120),sec).shape).not.toBe(calldataShape(data(0n,sec+120),sec).shape);
    expect(calldataShape('0x12345678',sec)).toEqual({selector:'0x12345678',shape:null});
  });
});
let db:ChainDb|undefined;
afterEach(async()=>{await db?.close();db=undefined;});
async function setup(){db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);await db.ensurePartitions(new Date(sec*1000));return db;}
async function indexed(db:ChainDb,block:number,a=wallet,fork=0) {
  await db.insert('chain_blocks',{number:String(block),block:String(block),hash:binary(hash(block+fork)),parent_hash:binary(hash(block-1)),ts:new Date(sec*1000)});
  await db.insert('swaps',{ts:new Date(sec*1000),block:String(block),tx_hash:binary(hash(block)),log_index:1,venue:'uniswap_v3',pool_id:binary(router),coin:binary(coin),quote_asset:binary(address(0)),trader:binary(a),tx_from:binary(a),tx_to:binary(block%2?router:address(4)),side:1,amount_coin:'1',amount_quote:'1000000000000000000',price_quote:1});
}
describe('indexed wallet fingerprint storage',()=>{
  it('refreshes an original cut from watcher evidence after its lookback day leaves raw swaps',async()=>{
    const db=await setup(),day=86400000,start=sec*1000,head=start+2*day+3600000;
    for(const [block,ts] of [[1,start+day/2],[2,start+day+day/2],[3,head]]) {
      await indexed(db,block);
      await db.sql.query('UPDATE chain_blocks SET ts=$2 WHERE number=$1',[block,new Date(ts)]);
      await db.sql.query('UPDATE swaps SET ts=$2 WHERE block=$1',[block,new Date(ts)]);
    }
    const before=await loadFingerprintInput(db,wallet,2);
    expect(before.input.swaps).toHaveLength(2);
    await runRetention(db,{quoteTokens:[],swapDays:1,transferDays:1,dryRun:false,pauseMs:0,now:()=>head});
    expect((await db.sql.query('SELECT block FROM swaps ORDER BY block')).rows).toEqual([{block:2},{block:3}]);
    expect((await db.sql.query('SELECT block FROM watcher_swap_evidence ORDER BY block')).rows).toEqual([{block:1}]);
    expect(await loadFingerprintInput(db,wallet,2)).toEqual(before);
  });

  it('updates changed wallets incrementally, replays bounded original cuts and snapshots without duplicate labels',async()=>{
    const db=await setup();for(let b=1;b<=6;b++)await indexed(db,b);
    expect(walletFeatures((await loadFingerprintInput(db,wallet,6)).input).swaps).toBe(6);
    const first=await replayFingerprints(db,1,6,{limit:2});expect(first).toMatchObject({processed:2,runs:2,labels:1,next:{block:2}});
    const next=await replayFingerprints(db,1,6,{limit:10,after:first.next!});expect(next).toMatchObject({processed:4,runs:4,labels:1,next:null});
    expect(await replayFingerprints(db,1,6)).toMatchObject({runs:0,labels:0});
    expect((await walletLabelsAt(db,[wallet],4n))[0]).toMatchObject({label:'human',tier:'low',features:{swaps:1,beta:true}});
    expect((await walletLabelsAt(db,[wallet],6n))[0]).toMatchObject({label:'human',tier:'medium',features:{swaps:5}});
    expect(await refreshFingerprints(db,6)).toMatchObject({wallets:1,runs:0});expect(await refreshFingerprints(db,6)).toMatchObject({wallets:0});
    await indexed(db,7);expect(await refreshFingerprints(db,7)).toMatchObject({wallets:1,runs:1,labels:0});
    await expect(db.sql.query('UPDATE wallet_fingerprint_runs SET score=0')).rejects.toThrow('append-only');
    await expect(db.sql.query('DELETE FROM wallet_labels')).rejects.toThrow('append-only');
  });
  it('relabels original history for a new immutable model version and retains declared/crew precedence',async()=>{
    const db=await setup();for(let b=1;b<=5;b++)await indexed(db,b);
    await replayFingerprints(db,1,5);
    const model={...FP_MODEL,version:'fp-fixture-2',bias:10};
    await replayFingerprints(db,1,5,{model,crewAt:async()=>({status:'qualified',crewId:'crew_fixture',confidence:0.95,evidence:['qualified_fixture']})});
    expect((await walletLabelsAt(db,[wallet],5n,model.version))[0]).toMatchObject({label:'crew',crew_id:'crew_fixture'});
    expect((await walletLabelsAt(db,[wallet],5n,FP_MODEL.version))[0].label).toBe('human');
    await db.insert('agent_registry',{agent_id:'1',owner:binary(address(8)),wallet:binary(wallet),registered_block:'2',wallet_block:'2',block:'2',block_hash:binary(hash(2)),evidence:'{}'});
    await replayFingerprints(db,1,5,{model,crewAt:async()=>({status:'qualified',crewId:'crew_fixture',confidence:0.95,evidence:['qualified_fixture']})});
    expect((await walletLabelsAt(db,[wallet],5n,model.version))[0]).toMatchObject({label:'declared_agent',crew_id:'crew_fixture'});
    await writeRegistryLabels(db,{crewAt:async()=>({status:'qualified',crewId:'crew_fixture',confidence:0.95,evidence:[]})});expect((await walletLabelsAt(db,[wallet],5n))[0]).toMatchObject({label:'declared_agent',crew_id:'crew_fixture'});
  });
  it('keeps orphaned feature and label rows immutable and unavailable, appends replacement-fork generations',async()=>{
    const db=await setup();for(let b=1;b<=5;b++)await indexed(db,b);
    await replayFingerprints(db,1,5);
    const before=(await db.sql.query('SELECT * FROM wallet_labels ORDER BY id')).rows;
    await db.tx(tx=>tx.deleteAbove(4n));expect((await walletLabelsAt(db,[wallet],5n))[0].tier).toBe('low');
    await indexed(db,5,wallet,100);await updateFingerprintWallet(db,wallet,5);
    expect((await walletLabelsAt(db,[wallet],5n))[0]).toMatchObject({tier:'medium',features:{swaps:5}});
    for(const old of before)expect((await db.sql.query('SELECT * FROM wallet_labels WHERE id=$1',[(old as {id:string}).id])).rows[0]).toEqual(old);
    expect((await db.sql.query("SELECT * FROM wallet_labels WHERE model_version LIKE '%:correction:%'")).rows).toHaveLength(1);
  });
  it('binds each UserOp to the swap log and actor; shared bundlers/paymasters never become agents or crews',async()=>{
    const db=await setup();await indexed(db,1);await indexed(db,2,address(9));
    const coverage={holderAttribution:{bindings:[{logIndex:'1',sender:wallet,operationHash:hash(100)},{logIndex:'3',sender:address(9),operationHash:hash(101)}],gaps:[]}};
    await db.insert('wallet_protocol_coverage',{chain_id:4663,block:'1',block_hash:binary(hash(1)),tx_hash:binary(hash(1)),timestamp_sec:String(sec),scope:'scoped_receipt',input_hash:binary(hash(50)),data:JSON.stringify(coverage)});
    expect(walletFeatures((await loadFingerprintInput(db,wallet,1)).input).aa4337Share).toBe(1);
    expect(walletFeatures((await loadFingerprintInput(db,address(9),2)).input).aa4337Share).toBeNull();
    await replayFingerprints(db,1,2);expect(await walletLabelsAt(db,[router],2n)).toEqual([]);
    expect((await walletLabelsAt(db,[wallet],2n))[0].crew_id).toBeNull();
    await db.insert('tokens',{address:binary(coin),first_block:'1',block:'1'});
    await db.insertMany('swaps',Array.from({length:50},(_,n)=>({ts:new Date(sec*1000),block:'1',tx_hash:binary(hash(500+n)),log_index:1,venue:'uniswap_v3',pool_id:binary(router),coin:binary(coin),quote_asset:binary(address(0)),trader:null,senders_pending:true,side:1,amount_coin:'1',amount_quote:'1',price_quote:1})));
    expect((await loadFingerprintInput(db,wallet,1)).input.reactions[0].buyerRank).toBe(51);
  });

  it('computes sponsored UserOp shares only with explicit history coverage and respects known-at cuts and code revocation',async()=>{
    const db=await setup();await indexed(db,1);await indexed(db,2);
    for(const b of [1,2])await db.insert('userops',{chain_id:4663,block:String(b),block_hash:binary(hash(b)),tx_hash:binary(hash(b)),timestamp_sec:String(sec),log_index:3,
      entry_point:binary(router),version:'0.7',user_op_hash:binary(hash(100+b)),sender:binary(wallet),paymaster:binary(b===1?address(8):address(0)),nonce:String(b),success:true,actual_gas_cost:'1',actual_gas_used:'1',data:'{}'});
    const history={useropHistoryAt:async()=>({complete:true,evidence:['coverage_fixture']})};
    expect(walletFeatures((await loadFingerprintInput(db,wallet,2,history)).input).paymasterShare).toBe(0.5);
    expect(walletFeatures((await loadFingerprintInput(db,wallet,2)).input).paymasterShare).toBeNull();
    await db.insert('wallet_protocol_coverage',{chain_id:4663,block:'1',block_hash:binary(hash(1)),tx_hash:binary(hash(1)),timestamp_sec:String(sec),scope:'scoped_receipt',input_hash:binary(hash(70)),
      data:JSON.stringify({knownAt:{cursor:{blockNumber:'2'}},holderAttribution:{bindings:[{logIndex:'1',sender:wallet,operationHash:hash(101)}],gaps:[]}})});
    expect(walletFeatures((await loadFingerprintInput(db,wallet,1)).input).aa4337Share).toBeNull();
    expect(walletFeatures((await loadFingerprintInput(db,wallet,2)).input).aa4337Share).toBeNull(); // the other swap is unobserved
    for(const b of [1,2])await db.insert('delegations_7702',{chain_id:4663,block:String(b),block_hash:binary(hash(b)),tx_hash:binary(hash(b)),timestamp_sec:String(sec),kind:'code',evidence_index:0,authority:binary(wallet),implementation:b===1?binary(router):null,
      data:JSON.stringify({code:b===1?`0xef0100${router.slice(2)}`:'0x'})});
    expect(walletFeatures((await loadFingerprintInput(db,wallet,1,{knownDelegates:[router]})).input).delegated7702).toBe(true);
    expect(walletFeatures((await loadFingerprintInput(db,wallet,2,{knownDelegates:[router]})).input).delegated7702).toBe(false);
  });
  it('does not look ahead to future swaps or delegation code and detects late protocol enrichment',async()=>{
    const db=await setup();await indexed(db,1);await indexed(db,2);
    await db.insert('delegations_7702',{chain_id:4663,block:'2',block_hash:binary(hash(2)),tx_hash:binary(hash(2)),timestamp_sec:String(sec),kind:'code',evidence_index:0,authority:binary(wallet),implementation:binary(router),data:JSON.stringify({code:`0xef0100${router.slice(2)}`})});
    expect(walletFeatures((await loadFingerprintInput(db,wallet,1,{knownDelegates:[router]})).input)).toMatchObject({swaps:1,delegated7702:null});
    expect(walletFeatures((await loadFingerprintInput(db,wallet,2,{knownDelegates:[router]})).input).delegated7702).toBe(true);
    await refreshFingerprints(db,2);
    await db.insert('wallet_protocol_coverage',{chain_id:4663,block:'1',block_hash:binary(hash(1)),tx_hash:binary(hash(1)),timestamp_sec:String(sec),scope:'full_transaction',input_hash:binary(hash(60)),data:JSON.stringify({principalBindings:'direct_transaction'})});
    expect(await refreshFingerprints(db,2)).toMatchObject({wallets:1,runs:2});
    expect(await refreshFingerprints(db,2)).toMatchObject({wallets:0});
  });
});

it('maintained ranks equal distinct raw buyers, pending events and retained history through repair, compaction, backfill and reorg',async()=>{
  const db=await setup();
  for(let b=1;b<=30;b++)await indexed(db,b,address(1000+b));
  await db.insert('tokens',{address:binary(coin),deployer:binary(router),first_block:'1',block:'1'});
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,side,amount_coin,amount_quote,senders_pending)
    SELECT to_timestamp($1),1+n%25,decode(lpad(to_hex(10000+n),64,'0'),'hex'),0,'uniswap_v3',$2,$3,$2,
      CASE WHEN n%17=0 THEN NULL ELSE decode(lpad(to_hex(2000+n%500),40,'0'),'hex') END,1,1,1,n%13=0
    FROM generate_series(1,1500) n`,[sec,binary(router),binary(coin)]);
  await indexed(db,31,wallet);
  // A pending row with a named trader can still be the wallet's own first buy under the original query.
  await db.sql.query(`UPDATE swaps SET trader=$1,senders_pending=true WHERE tx_hash=$2`,[binary(wallet),binary(hash(2))]);
  const oldRank=async()=>{
    const f=(await db.sql.query<{b:string}>(`SELECT min(b)::text AS b FROM (
      SELECT block AS b FROM swaps WHERE trader=$1 AND coin=$2 AND side=1 AND block<=31
      UNION ALL SELECT first_block FROM coin_buyer_firsts WHERE trader=$1 AND coin=$2 AND first_block<=31) x`,[binary(wallet),binary(coin)])).rows[0].b;
    const rank=(await db.sql.query<{n:string}>(`SELECT
      (SELECT count(*) FROM (SELECT trader FROM swaps WHERE coin=$1 AND side=1 AND block<=$2 AND trader IS NOT NULL AND NOT senders_pending
        UNION SELECT trader FROM coin_buyer_firsts WHERE coin=$1 AND first_block<=$2) k)
      +(SELECT count(*) FROM swaps WHERE coin=$1 AND side=1 AND block<=$2 AND (trader IS NULL OR senders_pending))
      +coalesce((SELECT sum(n) FROM coin_unknown_buys WHERE coin=$1 AND block<=$2),0)
      +coalesce((SELECT buyers FROM history_prunes WHERE coin=$1 AND NOT buyer_stats_complete AND swaps_through_block<$2),0) AS n`,[binary(coin),f])).rows[0].n;
    return {firstBuyBlock:Number(f),buyerRank:Number(rank)};
  };
  const equal=async()=>expect((await loadFingerprintInput(db,wallet,31)).input.reactions[0]).toMatchObject(await oldRank());
  await equal();
  await db.sql.query(`UPDATE swaps SET senders_pending=false WHERE trader=$1`,[binary(wallet)]);await equal();
  // Delete an earliest buy, then move a known buy back to pending.
  await db.sql.query('DELETE FROM swaps WHERE tx_hash=$1',[binary(hash(10001))]);await equal();
  await db.sql.query('UPDATE swaps SET senders_pending=true WHERE tx_hash=$1',[binary(hash(10002))]);await equal();
  const before=(await loadFingerprintInput(db,wallet,31)).input.reactions;
  await db.tx(async tx=>{
    const rows=(await tx.sql.query<Record<string,unknown>>('SELECT * FROM swaps WHERE block<=10')).rows;
    await recordBuyerStatistics(tx,binary(coin),rows);
    await tx.sql.query("SELECT set_config('eko.retention','on',true)");
    await tx.sql.query('DELETE FROM swaps WHERE block<=10');
  });
  expect((await loadFingerprintInput(db,wallet,31)).input.reactions).toEqual(before);await equal();
  // Exercise the actual rerunnable script's function, including stale projection recovery.
  const script=await readFile(new URL('../../../scripts/backfill-watcher-buyers.sql',import.meta.url),'utf8');
  await db.sql.query(script.slice(0,script.indexOf('-- psql executes')));
  await db.sql.query('DELETE FROM read_buyer_firsts');await db.sql.query('DELETE FROM read_unknown_buys');
  for(let n=0;n<2;n++){await db.sql.query('SELECT pg_temp.backfill_watcher_coin($1)',[binary(coin)]);await equal();}
  const orphanBuyer=address(9999);
  await db.sql.query(`INSERT INTO swaps SELECT ts,31,$1,log_index,venue,pool_id,coin,quote_asset,$2,tx_from,tx_to,recipient,side,amount_coin,amount_quote,price_quote,usd,priced_block,code_version,false,pricing_pending FROM swaps WHERE tx_hash=$3`,[binary(hash(90000)),binary(orphanBuyer),binary(hash(31))]);
  expect((await db.sql.query('SELECT first_block FROM read_buyer_firsts WHERE coin=$1 AND trader=$2',[binary(coin),binary(orphanBuyer)])).rows).toHaveLength(1);
  await db.tx(tx=>tx.deleteAbove(30n));
  expect((await db.sql.query('SELECT first_block FROM read_buyer_firsts WHERE coin=$1 AND trader=$2',[binary(coin),binary(orphanBuyer)])).rows).toHaveLength(0);
  await indexed(db,31,wallet,100);await equal();
  // Legacy prunes continue to contribute their conservative extra bound.
  await db.sql.query(`INSERT INTO history_prunes(coin,rule,through_block,swaps_through_block,buyers) VALUES($1,'raw_cap',1,1,9)`,[binary(coin)]);
  await equal();
});

it('bounds swap candidates per wallet refresh and resumes cuts while a busy wallet keeps trading',async()=>{
  const db=await setup();
  await db.sql.query(`INSERT INTO chain_blocks(number,block,hash,parent_hash,ts)
    SELECT n,n,decode(lpad(to_hex(n),64,'0'),'hex'),decode(lpad(to_hex(n-1),64,'0'),'hex'),to_timestamp($1) FROM generate_series(1,601) n`,[sec]);
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,side,amount_coin,amount_quote)
    SELECT to_timestamp($1),n,decode(lpad(to_hex(n),64,'0'),'hex'),1,'uniswap_v3',$2,
    decode(lpad(to_hex(100+n%200),40,'0'),'hex'),$2,$3,1,1,1 FROM generate_series(1,600) n`,[sec,binary(router),binary(wallet)]);
  const query=db.sql.query.bind(db.sql),tx=db.tx.bind(db);let candidates=0;
  const track=(original:typeof db.sql.query)=>(async(sql:string,params?:unknown[])=>{
    const result=await original(sql,params);
    if(sql.includes('FROM swaps')) {
      expect(sql).toMatch(/LIMIT (200|1)/);
      candidates+=sql.includes('WITH wallets AS')?(result.rows[0] as {blocks:string[]}).blocks.length:result.rows.length;
    }
    return result;
  }) as typeof db.sql.query;
  db.sql.query=track(query);
  db.tx=((work:Parameters<typeof db.tx>[0])=>tx(async inner=>{
    const original=inner.sql.query.bind(inner.sql);inner.sql.query=track(original);
    try{return await work(inner);}finally{inner.sql.query=original;}
  })) as typeof db.tx;
  try {
    expect(await refreshFingerprints(db,600)).toMatchObject({wallets:1,runs:FINGERPRINT_CUTS_PER_REFRESH});
    expect(candidates).toBeLessThanOrEqual(FINGERPRINT_REFRESH_ROW_BOUND);
  } finally {db.sql.query=query;db.tx=tx;}
  expect((await db.sql.query<{pending_blocks:string[]}>('SELECT pending_blocks FROM wallet_fingerprint_state')).rows[0].pending_blocks).toHaveLength(192);
  await db.sql.query(`INSERT INTO swaps SELECT ts,601,$1,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,recipient,side,amount_coin,amount_quote,price_quote,usd,priced_block,code_version,senders_pending,pricing_pending FROM swaps WHERE block=600`,[binary(hash(601))]);
  expect(await refreshFingerprints(db,601)).toMatchObject({wallets:1,runs:8});
  expect((await db.sql.query('SELECT block FROM wallet_fingerprint_runs ORDER BY block')).rows.map(r=>Number((r as {block:string}).block))).toEqual(Array.from({length:16},(_,n)=>401+n));
  await expect(refreshFingerprints(db,601,{walletLimit:5})).rejects.toThrow('Invalid fingerprint wallet bound');
});
