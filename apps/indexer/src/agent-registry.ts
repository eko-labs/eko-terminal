import { binary, hex, type ChainDb } from '@eko/db';
import { decodeEventLog, isAddress, keccak256, parseAbi, toEventSelector, type AbiEvent, type Address, type Hex } from 'viem';
import type { AddressRegistry } from '@eko/chain';
import { AdaptiveWindow } from './backfill.js';
import type { ChainClient, RpcLog } from './types.js';
const zero=`0x${'0'.repeat(40)}`;
const lower=(s:string)=>s.toLowerCase() as Hex;
export const agentRegistryReadAbi=parseAbi([
  'function ownerOf(uint256 agentId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function tokenURI(uint256 agentId) view returns (string)',
]);
export const agentTransferAbi=parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
// TODO(spec): No verified wallet-change ABI/evidence envelope is supplied; accept explicit reviewed profiles only and report the gap otherwise.
/** Reviewed local evidence, never a guessed wallet-change signature. ABI names the uint256 agent id. */
export interface RegistryWalletEventProfile {
  event: AbiEvent; agentIdField: string; codeHash: Hex; fromBlock: string; toBlock: string;
  evidence: { reviewId: string; log: RpcLog };
}
/**
 * Validate reviewed local wallet-event evidence scope, code hash shape and decodable uint256
 * agent-id field. Operator supplies the profile; no wallet auth or RPC. Invalid profile/log/ABI
 * throws; scan separately checks actual code and canonical log presence.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
 */
export function validateWalletEventProfile(profile:RegistryWalletEventProfile,address:Address) {
  if(!/^[a-z0-9_-]{1,80}$/i.test(profile.evidence.reviewId)||!/^0x[\da-f]{64}$/i.test(profile.codeHash)||
    BigInt(profile.fromBlock)<0n||BigInt(profile.toBlock)<BigInt(profile.fromBlock))throw new Error('Invalid registry verification profile');
  const l=profile.evidence.log;
  if(lower(l.address)!==lower(address)||l.removed||BigInt(l.blockNumber)<BigInt(profile.fromBlock)||BigInt(l.blockNumber)>BigInt(profile.toBlock))throw new Error('Registry verification log outside profile');
  if(!profile.event.inputs.some(i=>i.name===profile.agentIdField&&i.type==='uint256'))throw new Error('Registry event lacks agent id');
  const decoded=decodeEventLog({abi:[profile.event],topics:l.topics,data:l.data,strict:true});
  if(typeof (decoded.args as Record<string,unknown>)[profile.agentIdField]!=='bigint')throw new Error('Registry verification log lacks agent id');
  return profile;
}
export class AgentRegistryCollector {
  private stopped=false;
  /**
   * Wire registry/provider/storage and structurally validate every supplied wallet-event profile.
   * Indexer operator construction only; missing manifest address or invalid profile throws; actual
   * code/log authentication occurs in scan.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  constructor(readonly client:ChainClient,readonly db:ChainDb,readonly registry:AddressRegistry,
    readonly options:{walletEvents?:RegistryWalletEventProfile[];window?:number;reorgDepth?:number}={}) {
    for(const profile of options.walletEvents??[])validateWalletEventProfile(profile,registry.requireAddress('erc8004.identityRegistry'));
  }
  /**
   * Request stop before further registry scan windows. Host lifecycle only; no wallet auth; already
   * started reads/transactions may finish.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  stop(){this.stopped=true;}
  private header(n:bigint){return this.client.header?.(n)??this.client.block(n);}
  /** Registry recovery only touches indexer-owned registry evidence. Derived labels retain their rows.
   * @remarks
   * Recover only indexer-owned registry evidence to a retained canonical checkpoint within the
   * bounded sparse window, retaining derived labels. Indexer role only; provider/SQL failure or
   * missing retained ancestor rejects.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async reconcile() {
    const cursor=(await this.db.sql.query<{block:string;hash:Uint8Array}>('SELECT block,hash FROM ingest_cursors WHERE stream=$1',['agent_registry'])).rows[0];
    if(!cursor?.hash||lower((await this.header(BigInt(cursor.block))).hash)===hex(cursor.hash))return;
    // Address-filtered ranges have sparse anchors. Recover from the prior canonical scan boundary,
    // bounded by one maximum log window; the head follower still owns its chain-wide depth limit.
    const checkpoints=(await this.db.sql.query<{block:string;block_hash:Uint8Array}>('SELECT block,block_hash FROM agent_registry_checkpoints WHERE block<$1 AND block>=$2 ORDER BY block DESC',[cursor.block,(BigInt(cursor.block)-BigInt(Math.max(this.options.reorgDepth??256,20000))).toString()])).rows;
    for(const c of checkpoints) {
      if(lower((await this.header(BigInt(c.block))).hash)!==hex(c.block_hash))continue;
      await this.db.tx(async tx=>{
        for(const table of ['agent_registry_events','agent_registry','agent_registry_checkpoints'])await tx.sql.query(`DELETE FROM ${table} WHERE block>$1`,[c.block]);
        await tx.setCursor('agent_registry',BigInt(c.block),hex(c.block_hash));
      });
      return;
    }
    throw new Error('Registry reorg exceeds retained checkpoint depth');
  }
  /**
   * Require valid interval/chain and pinned registry reads; authenticate configured wallet-event
   * profiles against code/log evidence, capture canonical ordered events/wallet state and commit
   * scan checkpoints. Indexer operator supplies reviewed profiles. Invalid/missing evidence,
   * inconsistent reads, fork changes or RPC/SQL failure rejects; scan coverage is returned after
   * work.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async scan(from:bigint,to:bigint) {
    if(from<0n||to<from)throw new Error('Invalid registry interval');
    if(await this.client.chainId()!==4663)throw new Error('Registry chain must be 4663');
    if(!this.client.agentWallets)throw new Error('Registry pinned reads unavailable');
    const address=this.registry.requireAddress('erc8004.identityRegistry'),window=new AdaptiveWindow(this.options.window??2000);
    for(const profile of this.options.walletEvents??[]) {
      const sample=profile.evidence.log,n=BigInt(sample.blockNumber),header=await this.header(n);
      const code=await this.client.code(address,n);
      if(code==='0x'||lower(header.hash)!==lower(sample.blockHash)||keccak256(code)!==profile.codeHash)throw new Error('Registry verification bytecode mismatch or orphaned log');
      const observed=await this.client.logs({from:n,to:n,address,topics:[toEventSelector(profile.event)]});
      if(!observed.some(l=>!l.removed&&lower(l.blockHash)===lower(sample.blockHash)&&lower(l.address)===lower(address)&&lower(l.transactionHash)===lower(sample.transactionHash)&&BigInt(l.logIndex)===BigInt(sample.logIndex)&&l.data===sample.data&&l.topics.join()===sample.topics.join()))throw new Error('Registry verification log unavailable');
    }
    for(let first=from;first<=to&&!this.stopped;) {
      const last=first+BigInt(window.size)-1n<to?first+BigInt(window.size)-1n:to;
      const end=await this.header(last);
      const profiles=(this.options.walletEvents??[]).filter(p=>BigInt(p.fromBlock)<=last&&BigInt(p.toBlock)>=first);
      let logs:RpcLog[];
      try {logs=await this.client.logs({from:first,to:last,address,topics:[toEventSelector(agentTransferAbi[0]),...profiles.map(p=>toEventSelector(p.event))]});}
      catch(error){if(window.failure(error))continue;throw error;}
      const groups=new Map<bigint,RpcLog[]>();
      const unique=new Map<string,RpcLog>();
      for(const l of logs) {
        if(l.removed||lower(l.address)!==lower(address)||BigInt(l.blockNumber)<first||BigInt(l.blockNumber)>last)throw new Error('Registry log outside canonical scope');
        const key=`${lower(l.transactionHash)}:${BigInt(l.logIndex)}`,previous=unique.get(key);
        if(previous&&JSON.stringify(previous)!==JSON.stringify(l))throw new Error('Conflicting registry log');
        unique.set(key,l);
      }
      for(const l of [...unique.values()].sort((a,b)=>BigInt(a.blockNumber)===BigInt(b.blockNumber)?Number(BigInt(a.logIndex)-BigInt(b.logIndex)):BigInt(a.blockNumber)<BigInt(b.blockNumber)?-1:1)) {
        const n=BigInt(l.blockNumber),group=groups.get(n)??[];group.push(l);groups.set(n,group);
      }
      const prepared:{n:bigint;hash:Hex;events:Record<string,unknown>[];ids:Set<bigint>;burned:Set<bigint>;readIds:bigint[];reads:{owner:Address;wallet:Address;tokenUri:string|null}[]}[]=[];
      for(const [n,ls] of groups) {
        const header=await this.header(n);
        if(ls.some(l=>lower(l.blockHash)!==lower(header.hash)))throw new Error('Registry log/header mismatch');
        const events:Record<string,unknown>[]=[],ids=new Set<bigint>(),burned=new Set<bigint>();
        for(const l of ls) {
          let id:bigint,kind:string,owner:Address|null=null,reviewId:string|null=null;
          if(l.topics[0]===toEventSelector(agentTransferAbi[0])) {
            const {args}=decodeEventLog({abi:agentTransferAbi,topics:l.topics,data:l.data,strict:true});
            id=args.tokenId;owner=args.to;kind=lower(args.from)===zero?'mint':'transfer';
            if(lower(args.to)===zero)burned.add(id);else burned.delete(id);
          } else {
            const profile=profiles.find(p=>toEventSelector(p.event)===l.topics[0]&&BigInt(p.fromBlock)<=n&&BigInt(p.toBlock)>=n);
            if(!profile)throw new Error('Unverified registry wallet event');
            const code=await this.client.code(address,n);
            if(code==='0x'||keccak256(code)!==profile.codeHash)throw new Error('Registry wallet-event bytecode mismatch');
            id=(decodeEventLog({abi:[profile.event],topics:l.topics,data:l.data,strict:true}).args as Record<string,bigint>)[profile.agentIdField];
            kind='wallet_change';reviewId=profile.evidence.reviewId;
          }
          ids.add(id);
          events.push({block:n.toString(),block_hash:binary(header.hash),tx_hash:binary(l.transactionHash),log_index:Number(BigInt(l.logIndex)),agent_id:id.toString(),kind,owner:owner?binary(owner):null,evidence:JSON.stringify({log:l,reviewId})});
        }
        const readIds=[...ids].filter(id=>!burned.has(id)),reads=readIds.length?await this.client.agentWallets(readIds,n):[];
        if(reads.length!==readIds.length)throw new Error('Incomplete registry wallet reads');
        if(lower((await this.header(n)).hash)!==lower(header.hash))throw new Error('Registry fork changed during read');
        prepared.push({n,hash:header.hash,events,ids,burned,readIds,reads});
      }
      if(lower((await this.header(last)).hash)!==lower(end.hash))throw new Error('Registry range changed during scan');
      await this.db.tx(async tx=>{
        for(const {n,hash,events,ids,burned,readIds,reads} of prepared) {
          await tx.insertMany('agent_registry_events',events);
          for(const id of ids) {
            const mint=(await tx.sql.query<{block:string;evidence:unknown;tx_hash:Uint8Array;log_index:number}>('SELECT block,evidence,tx_hash,log_index FROM agent_registry_events WHERE agent_id=$1 AND kind=$2 AND block<=$3 ORDER BY block,log_index LIMIT 1',[id.toString(),'mint',n.toString()])).rows[0];
            if(!mint)continue; // An incomplete transfer-only range cannot invent registration.
            const value=burned.has(id)?{owner:zero,wallet:zero,tokenUri:null}:reads[readIds.indexOf(id)];
            if(!isAddress(value.owner)||!isAddress(value.wallet))throw new Error('Invalid registry address read');
            await tx.insert('agent_registry',{agent_id:id.toString(),owner:binary(value.owner),wallet:binary(value.wallet),token_uri:value.tokenUri,registered_block:mint.block,wallet_block:n.toString(),block:n.toString(),block_hash:binary(hash),evidence:JSON.stringify({registration:{block:mint.block,txHash:hex(mint.tx_hash),logIndex:mint.log_index},read:{block:n.toString(),blockHash:hash,boundary:'block_end'},events:events.map(e=>e.evidence)})});
          }
        }
        await tx.sql.query('INSERT INTO agent_registry_checkpoints(from_block,block,block_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[first.toString(),last.toString(),binary(end.hash)]);
        const cursor=await tx.cursor('agent_registry');
        if(cursor==null||last>=cursor)await tx.setCursor('agent_registry',last,end.hash);
      });
      first=last+1n;window.success();
    }
    return this.coverage();
  }
  /** Snapshot discoveries at a pinned head, never backdate current wallets to registration.
   * @remarks
   * Read current indexed nonburned agents at the pinned head and append changed wallet/owner
   * snapshots without backdating registration. Indexer role only; incomplete/invalid reads, fork
   * changes or RPC/SQL failure rejects. It does not discover arbitrary unindexed agents.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async snapshot(n:bigint) {
    if(!this.client.agentWallets)throw new Error('Registry pinned reads unavailable');
    const header=await this.header(n);
    const agents=(await this.db.sql.query<{agent_id:string;registered_block:string;evidence:unknown;wallet:Uint8Array;owner:Uint8Array}>('SELECT a.* FROM agent_registry_ids i CROSS JOIN LATERAL (SELECT * FROM agent_registry r WHERE r.agent_id=i.agent_id AND r.wallet_block<=$1 ORDER BY r.wallet_block DESC LIMIT 1) a ORDER BY a.agent_id',[n.toString()])).rows.filter(r=>hex(r.owner)!==zero);
    for(let offset=0;offset<agents.length;offset+=200) {
      const batch=agents.slice(offset,offset+200),reads=await this.client.agentWallets(batch.map(r=>BigInt(r.agent_id)),n);
      if(reads.length!==batch.length)throw new Error('Incomplete registry snapshot');
      if(lower((await this.header(n)).hash)!==lower(header.hash))throw new Error('Registry snapshot fork changed');
      await this.db.tx(async tx=>{
        for(const [i,a] of batch.entries()) {
          const r=reads[i];if(!isAddress(r.owner)||!isAddress(r.wallet))throw new Error('Invalid registry snapshot address');
          if(hex(a.wallet)===lower(r.wallet)&&hex(a.owner)===lower(r.owner))continue;
          await tx.insert('agent_registry',{agent_id:a.agent_id,registered_block:a.registered_block,owner:binary(r.owner),wallet:binary(r.wallet),token_uri:r.tokenUri,wallet_block:n.toString(),block:n.toString(),block_hash:binary(header.hash),evidence:JSON.stringify({prior:a.evidence,read:{block:n.toString(),blockHash:header.hash,boundary:'block_end'},source:'head_snapshot'})});
        }
      });
    }
  }
  /**
   * Reconcile registry cursor, scan newly observed blocks and capture a head snapshot before
   * returning indexed coverage. Indexer role only; reconciliation/provider/SQL failures reject.
   * Wallet event completeness remains explicitly dependent on supplied profiles.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async poll() {
    await this.reconcile();const head=await this.client.head(),cursor=await this.db.cursor('agent_registry');
    if(cursor==null||cursor<head)await this.scan(cursor==null?0n:cursor+1n,head);
    await this.snapshot(head);return this.coverage();
  }
  /**
   * Return indexed-mint counts, retained contiguous/genesis scan bounds and explicit wallet-change-
   * profile status. Public worker diagnostic without wallet auth; SQL failures reject. This reports
   * indexed scope, not every registry actor or historical wallet change.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  async coverage() {
    const counts=(await this.db.sql.query<{agents:number;nonzero_wallets:number}>('SELECT count(*)::int AS agents,count(*) FILTER(WHERE wallet<>$1)::int AS nonzero_wallets FROM (SELECT a.wallet FROM agent_registry_ids i CROSS JOIN LATERAL (SELECT wallet FROM agent_registry r WHERE r.agent_id=i.agent_id ORDER BY r.wallet_block DESC LIMIT 1) a) a',[binary(zero)])).rows[0];
    const scanned=(await this.db.sql.query<{from_block:string|null;to_block:string|null;contiguous:boolean|null}>(`SELECT min(from_block) AS from_block,max(block) AS to_block,bool_and(prior_end IS NULL OR from_block<=prior_end+1) AS contiguous FROM (
      SELECT from_block,block,max(block) OVER(ORDER BY from_block,block ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_end FROM agent_registry_checkpoints
    ) ranges`)).rows[0];
    return {...counts,mintScan:{fromBlock:scanned.from_block==null?null:String(scanned.from_block),toBlock:scanned.to_block==null?null:String(scanned.to_block),coversGenesis:scanned.from_block!=null&&BigInt(scanned.from_block)===0n&&scanned.contiguous===true},throughBlock:(await this.db.cursor('agent_registry'))?.toString()??null,walletChangeEvents:this.options.walletEvents?.length?'supplied_verified_profiles':'unverified',scope:'indexed_mints_only'};
  }
}
