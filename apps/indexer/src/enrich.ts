import { receiptMappingRevision } from './receipt-actors.js';
import { walletProtocolTopics } from './wallet-protocol.js';
import { createMeteredClients, loadRegistry, type RpcEnv } from '@eko/chain';
import { binary, hex, refreshBars, type ChainDb } from '@eko/db';
import { isAddress, toHex, type Address } from 'viem';
import { createClients, lower } from './clients.js';
import { BlockDecoder } from './decode.js';
import { Semaphore, settle } from './concurrency.js';
import { loadSenderScope } from './sender-scope.js';
import { BlockRows } from './rows.js';
import type { ChainClient, RpcBlock, RpcReceipt, TokenMetadata } from './types.js';
interface Pending {block:string;tx_hash:Uint8Array;log_index:number;ts:Date|null;source:string;raw_data:import('./types.js').RpcLog|null}
/** On-demand historical sender/metadata fill. Every network read precedes its bounded write transaction.
 * @remarks
 * Validate the indexed coin and acquire bounded historical sender/metadata evidence before
 * canonical lease/current-block-checked write transactions and derived bar refresh. Indexer
 * operator supplies the client or role-configured metered RPC; no wallet auth. Missing indexed
 * coin, inconsistent provider evidence, budget/SQL failures reject; retained gaps stay explicit
 * and owned meter is closed in finally.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
 */
export async function enrichSenders(db:ChainDb, coin:Address, providedClient?:ChainClient) {
  if(!isAddress(coin))throw new Error('Invalid enrichment coin');
  const registry=loadRegistry(),mappingRevision=receiptMappingRevision(registry);
  const owned=providedClient?undefined:createMeteredClients(process.env as RpcEnv,{db,transientRetrySec:300});
  const client=providedClient??createClients(process.env as RpcEnv,registry,owned!.meter,{enrich:true});
  const decoder=new BlockDecoder(client,registry),rpc=new Semaphore(16);
  decoder.storeWalletProtocol=process.env.INDEX_WALLET_PROTOCOL!=='off';
  let enriched=0;
  try {
    const scope=await loadSenderScope(db);
    const discovered=new Map<string,{block:string;pool:import('./types.js').PoolMetadata}>();
    const raw=(await db.sql.query<{emitter:Uint8Array;block:string}>(`SELECT emitter,min(block)::text AS block FROM pending_pool_events WHERE emitter IN (SELECT emitter FROM pending_pool_events WHERE currency_hints ? $1) GROUP BY emitter`,[lower(coin)])).rows;
    await settle(raw.map(r=>rpc.run(async()=>{const id=hex(r.emitter);const p=await client.v3Pool(id as Address,BigInt(r.block));if(p&&[p.currency0,p.currency1].some(a=>lower(a)===lower(coin))){discovered.set(id,{block:r.block,pool:p});scope.pools.set(id,p);scope.poolRows.push({id:r.emitter,venue:'uniswap_v3',currency0:binary(p.currency0),currency1:binary(p.currency1),fee:p.fee,tick_spacing:p.tickSpacing,hooks:null,creation_verified:false,created_block:r.block});for(const address of [p.currency0,p.currency1])if(!scope.tokenRows.some(t=>hex(t.address)===lower(address)))scope.tokenRows.push({address:binary(address),curve:null,launchpad:null,decimals:null,name:null,symbol:null});}})));
    const pools=new Map([...scope.pools].filter(([,p])=>[p.currency0,p.currency1].some(a=>lower(a)===lower(coin))));
    const metadata=new Map<string,TokenMetadata>(scope.tokenRows.map(t=>[hex(t.address),{symbol:t.symbol,name:t.name,decimals:t.decimals,totalSupply:t.total_supply==null?null:BigInt(t.total_supply),supplyBlock:t.supply_block==null?null:BigInt(t.supply_block)}]));
    const addresses=[...new Set([coin,...[...pools.values()].flatMap(p=>[p.currency0,p.currency1])].map(lower))].filter(a=>a!=='0x0000000000000000000000000000000000000000') as Address[];
    const fresh=addresses.filter(a=>{const m=metadata.get(lower(a));return m?.decimals==null||m.symbol==null||m.name==null||m.totalSupply==null;});
    const token=(await db.sql.query<{first_block:string}>('SELECT first_block FROM tokens WHERE address=$1',[binary(coin)])).rows[0];
    const firstBlock=token?.first_block??[...discovered.values()].map(r=>r.block).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1)[0];
    if(firstBlock==null)throw new Error('Enrichment coin is not indexed');
    if(fresh.length){const n=BigInt(firstBlock);const facts=client.tokenMetadataBatch ? await client.tokenMetadataBatch(fresh,n):await Promise.all(fresh.map(a=>client.tokenMetadata(a,n)));if(facts.length!==fresh.length)throw new Error('Incomplete enrichment metadata');fresh.forEach((a,i)=>{const old=metadata.get(lower(a));metadata.set(lower(a),{...facts[i],decimals:facts[i].decimals??old?.decimals??null,name:facts[i].name??old?.name??null,symbol:facts[i].symbol??old?.symbol??null,totalSupply:facts[i].totalSupply??old?.totalSupply??null,supplyBlock:facts[i].supplyBlock??old?.supplyBlock??null});});}
    // A token can keep returning unavailable metadata. Visit each identity once per
    // invocation, retaining its pricing marker for a later retry instead of looping.
    let after:{block:string;tx_hash:Uint8Array;log_index:number}|undefined;
    for(;;) {
      const rawIds=[...discovered.keys()];
      const params:unknown[]=[binary(coin),...rawIds.map(binary),mappingRevision];
      // Unresolved logs already attempted with these receipt brackets and registry
      // stay idle. A new deployment/mapping revision makes them eligible again.
      const mappingParameter=`$${params.length}::text`;
      const unresolved=(table:string,field:string)=>`${table}.${field} IS NULL AND NOT EXISTS(SELECT 1 FROM wallet_protocol_coverage c
        WHERE c.chain_id=4663 AND c.tx_hash=${table}.tx_hash AND c.block=${table}.block AND c.data->>'receipt'='complete'
        AND c.data->'holderAttribution'->>'mappingRevision'=${mappingParameter}
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(c.data->'holderAttribution'->'gaps','[]'::jsonb)) g
          WHERE g->>'logIndex'=${table}.log_index::text))`;
      const position=after?`WHERE (block,tx_hash,log_index)>($${params.length+1}::bigint,$${params.length+2}::bytea,$${params.length+3}::integer)`:'';
      if(after)params.push(after.block,after.tx_hash,after.log_index);
      // A swap or liquidity event outside the sender scope is stored with the wallet its transfers name and no
      // transaction sender (decode.ts); enriching the coin reads its receipts once and records the resolved sender.
      const pending=(await db.sql.query<Pending>(`SELECT * FROM (SELECT block,tx_hash,log_index,ts,'swaps' AS source,NULL::jsonb AS raw_data FROM swaps WHERE (coin=$1 OR quote_asset=$1) AND (senders_pending OR pricing_pending OR (tx_from IS NULL AND venue<>'pons_curve') OR (${unresolved('swaps','trader')}))
        UNION ALL SELECT e.block,e.tx_hash,e.log_index,e.ts,'liquidity' AS source,NULL::jsonb AS raw_data FROM liquidity_events e JOIN pools p ON p.id=e.pool_id
        WHERE (p.currency0=$1 OR p.currency1=$1) AND (e.senders_pending OR e.tx_from IS NULL OR (${unresolved('e','actor')}))
        UNION ALL SELECT e.block,e.tx_hash,e.log_index,b.ts,'raw' AS source,e.data AS raw_data FROM pending_pool_events e LEFT JOIN chain_blocks b ON b.number=e.block WHERE e.emitter IN (${rawIds.map((_,i)=>`$${i+2}`).join(',')||'NULL'})) p ${position} ORDER BY block,tx_hash,log_index LIMIT 1000`,params)).rows;
      if(!pending.length){if(fresh.length)await db.tx(async tx=>{for(const a of fresh){const m=metadata.get(lower(a))!;await tx.sql.query('UPDATE tokens SET name=coalesce(name,$2),symbol=coalesce(symbol,$3),decimals=coalesce(decimals,$4),total_supply=coalesce(total_supply,$5::numeric),supply_block=coalesce(supply_block,$6::bigint) WHERE address=$1',[binary(a),m.name,m.symbol,m.decimals,m.totalSupply?.toString()??null,m.totalSupply==null?null:(m.supplyBlock??BigInt(firstBlock)).toString()]);}});break;}
      const numbers=[...new Set(pending.map(r=>r.block))].slice(0,32);
      const rawKeys=new Set(pending.filter(r=>r.source==='raw').map(r=>`${hex(r.tx_hash)}:${r.log_index}`));
      const batch=new BlockRows(),hashes=new Map<string,{hash:string;stored:boolean}>();
      const updates:{table:'swaps'|'liquidity_events';row:Record<string,unknown>}[]=[];
      await settle(numbers.map(number=>rpc.run(async()=>{
        const n=BigInt(number),stored=await db.blockHash(n);
        const needsTime=pending.some(r=>r.block===number&&r.ts==null);
        const header=stored&&!needsTime?undefined:await (client.header?.(n)??client.block(n));
        if(header && BigInt(header.number)!==n)throw new Error('Wrong enrichment header');
        const expected=stored??lower(header!.hash);
        if(header && lower(header.hash)!==expected)throw new Error('Reorg during enrichment header read');
        hashes.set(number,{hash:expected,stored:stored!=null});
        const all=await client.receipts(n);
        if(new Set(all.map(r=>lower(r.transactionHash))).size!==all.length || all.some(r=>BigInt(r.blockNumber)!==n||lower(r.blockHash)!==expected||!r.from||!('to' in r)||r.logs.some(l=>l.removed||BigInt(l.blockNumber)!==n||lower(l.blockHash)!==expected||lower(l.transactionHash)!==lower(r.transactionHash))))throw new Error('Reorg during sender enrichment');
        const keys=new Set(pending.filter(r=>r.block===number).map(r=>`${hex(r.tx_hash)}:${r.log_index}`));
        const selected=all.filter(r=>r.logs.some(l=>keys.has(`${lower(l.transactionHash)}:${Number(BigInt(l.logIndex))}`)));
        const found=new Set(selected.flatMap(r=>r.logs).filter(l=>keys.has(`${lower(l.transactionHash)}:${Number(BigInt(l.logIndex))}`)).map(l=>`${lower(l.transactionHash)}:${Number(BigInt(l.logIndex))}`));
        for(const row of pending.filter(r=>r.block===number&&r.raw_data)){const raw=row.raw_data!;const canonical=selected.flatMap(r=>r.logs).find(l=>lower(l.transactionHash)===hex(row.tx_hash)&&Number(BigInt(l.logIndex))===row.log_index);if(!canonical||lower(raw.blockHash)!==expected||lower(raw.address)!==lower(canonical.address)||raw.data!==canonical.data||raw.topics.map(lower).join()!==canonical.topics.map(lower).join())throw new Error('Deferred log differs from canonical receipt');}
        if(found.size!==keys.size)throw new Error('Pending log missing from enrichment receipts');
        const time=pending.find(r=>r.block===number&&r.ts!=null)?.ts;
        const timestamp=time?toHex(BigInt(Math.floor(new Date(time).getTime()/1000))):header!.timestamp;
        const block:RpcBlock={number:toHex(n),hash:expected as RpcBlock['hash'],parentHash:'0x',timestamp,transactionsComplete:false,transactions:selected.map(r=>({hash:r.transactionHash,from:r.from!,to:r.to!,type:r.type,transactionIndex:r.transactionIndex}))};
        // Retain raw EntryPoint context logs for protocol evidence; collect only requested event identities.
        const context=selected.map(r=>({...r,logs:r.logs.filter(l=>keys.has(`${lower(l.transactionHash)}:${Number(BigInt(l.logIndex))}`)||walletProtocolTopics.includes(l.topics[0]))}));
        const remote=await decoder.prefetch(block,context,{scope,forceSenders:true,discoveredPools:pools,knownTokens:metadata});
        const state=await decoder.prepare(db,block,context,{scope,remote,forceSenders:true,poolRows:scope.poolRows});
        const filtered:RpcReceipt[]=selected.map(r=>({...r,logs:r.logs.filter(l=>keys.has(`${lower(l.transactionHash)}:${Number(BigInt(l.logIndex))}`))}));
        decoder.committed(state);
        const rows=decoder.collect(block,filtered,state);
        for(const table of ['swaps','liquidity_events'] as const)for(const row of rows.get(table)){if(rawKeys.has(`${hex(row.tx_hash as Uint8Array)}:${row.log_index}`)){batch.add(table,row);enriched++;}else updates.push({table,row});}
        for(const [id,p] of discovered)if(filtered.some(r=>r.logs.some(l=>lower(l.address)===id)))batch.add('pools',{id:binary(id),venue:'uniswap_v3',currency0:binary(p.pool.currency0),currency1:binary(p.pool.currency1),fee:p.pool.fee,tick_spacing:p.pool.tickSpacing,created_block:p.block,block:p.block,creation_verified:false});
        for(const token of state.tokens.values())if(remote.metadata.has(lower(token.address)))batch.add('tokens',{address:binary(token.address),symbol:token.symbol,name:token.name,decimals:token.decimals,total_supply:token.totalSupply?.toString()??null,supply_block:token.totalSupply==null?null:(token.supplyBlock??BigInt(firstBlock)).toString(),first_block:number,block:number});
        for(const table of ['wallets','userops','delegations_7702','wallet_protocol_coverage'] as const)for(const row of rows.get(table))batch.add(table,row);
      })));
      await db.tx(async tx=>{
        const beforeEnriched=enriched;tx.afterRollback(()=>{enriched=beforeEnriched;});
        await tx.sql.query("SET LOCAL lock_timeout='5s'");
        await tx.sql.query('LOCK TABLE tokens,pools,swaps,token_transfers IN SHARE ROW EXCLUSIVE MODE');
        await tx.sql.query('LOCK TABLE chain_blocks IN SHARE MODE');
        for(const [number,expected] of hashes){const stored=await tx.blockHash(BigInt(number));if((expected.stored || stored!=null) && stored!==expected.hash)throw new Error('Reorg before sender enrichment commit');}
        await batch.lockReadCoins(tx,updates.map(({row})=>row.coin as Uint8Array).filter(coin=>coin instanceof Uint8Array));
        for(const token of batch.get('tokens'))await tx.sql.query(`UPDATE tokens SET symbol=coalesce(symbol,$2),name=coalesce(name,$3),decimals=coalesce(decimals,$4),total_supply=coalesce(total_supply,$5::numeric),supply_block=coalesce(supply_block,$6::bigint) WHERE address=$1`,[token.address,token.symbol,token.name,token.decimals,token.total_supply,token.supply_block]);
        for(const table of ['swaps','liquidity_events'] as const) {
          const rows=updates.filter(u=>u.table===table).map(u=>u.row);
          for(let offset=0;offset<rows.length;offset+=250){
            const fields=table==='swaps'?['tx_hash','log_index','block','trader','tx_from','tx_to','price_quote','usd','priced_block','pricing_pending']:['tx_hash','log_index','block','actor','tx_from','tx_to'];
            const types=table==='swaps'?['bytea','integer','bigint','bytea','bytea','bytea','double precision','double precision','bigint','boolean']:['bytea','integer','bigint','bytea','bytea','bytea'];
            const params:unknown[]=[];
            const values=rows.slice(offset,offset+250).map(r=>`(${fields.map((f,i)=>{params.push(r[f]);return `$${params.length}::${types[i]}`;}).join(',')})`);
            const changes=fields.slice(3).map(f=>['trader','actor','tx_from','tx_to'].includes(f) ? `${f}=coalesce(p.${f},s.${f})` : `${f}=p.${f}`).join(',');
            const result=await tx.sql.query(`UPDATE ${table} s SET ${changes},senders_pending=false FROM (VALUES ${values}) AS p(${fields}) WHERE s.tx_hash=p.tx_hash AND s.log_index=p.log_index AND s.block=p.block AND (s.senders_pending OR s.tx_from IS NULL OR s.${table==='swaps'?'trader':'actor'} IS NULL${table==='swaps'?' OR (s.pricing_pending AND NOT p.pricing_pending)':''}) RETURNING s.tx_hash`,params);
            enriched+=result.rows.length;
          }
        }
        await batch.flush(tx);
        for(const r of pending.filter(r=>r.source==='raw'&&numbers.includes(r.block)))await tx.sql.query('DELETE FROM pending_pool_events WHERE tx_hash=$1 AND log_index=$2 AND block=$3',[r.tx_hash,r.log_index,r.block]);
        await refreshBars(tx,[...batch.get('swaps'),...updates.filter(u=>u.table==='swaps').map(({row})=>row)].map(row=>({coin:row.coin as Uint8Array,minute:new Date(Math.floor(new Date(row.ts as Date).getTime()/60000)*60000)})));
      },{retry:true});
      after=pending.filter(r=>numbers.includes(r.block)).at(-1)!;
    }
    return {enriched};
  } finally {if(owned)await owned.meter.usage();} // The database's shared application meter owns shutdown.
}
