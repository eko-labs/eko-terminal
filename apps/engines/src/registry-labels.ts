import { createHash } from 'node:crypto';
import { binary, hex, type ChainDb } from '@eko/db';
import { labelTier, type WalletLabel, type LabelTier } from '@eko/shared';
import type { Address } from 'viem';
// Canonical fingerprint dependencies also apply to declaration withdrawal projections.
const fingerprintCanonical=(alias:string)=>`NOT EXISTS(SELECT 1 FROM wallet_label_fingerprint_dependencies f JOIN wallet_fingerprint_dependencies d ON d.run_id=f.run_id WHERE f.label_id=${alias}.id AND NOT EXISTS(SELECT 1 FROM chain_blocks b WHERE b.number=d.block AND b.hash=d.block_hash))`;
const zero=`0x${'0'.repeat(40)}`;
export const REGISTRY_LABEL_MODEL='declared-1.0.0';
export interface WalletLabelRow {
  id:string;address:Uint8Array;label:WalletLabel;confidence:number;tier:LabelTier|null;source:string;crew_id:string|null;
  features:Record<string,unknown>;model_version:string;valid_from_block:string;
}
// TODO(spec): The qualified graph provider is absent in this revision; use a narrow point-in-time adapter without implementing its qualification rules.
/** Adapter output from the qualified coordination graph, never a soft candidate or NFT owner. */
export interface QualifiedCrewAttachment { status:'qualified'; crewId:string; confidence:number; evidence:unknown }
export interface RegistryLabelOptions {
  modelVersion?:string;
  crewAt?:(address:Address,block:bigint)=>Promise<QualifiedCrewAttachment|null>;
  /** Graph membership changes are independent point-in-time boundaries. */
  crewBlocks?:bigint[];
}
interface RegistryRow {agent_id:string;wallet:Uint8Array;owner:Uint8Array;wallet_block:string;registered_block:string;block_hash:Uint8Array;evidence:unknown}
/** §3.4 cut, plus canonical registry dependencies: orphaned derived rows stay retained but unavailable. */
export async function walletLabelsAt(db:ChainDb,addresses:Address[],block:bigint,modelVersion?:string) {
  if(block<0n)throw new Error('Invalid wallet-label cut');
  if(!addresses.length)return [];
  return (await db.sql.query<WalletLabelRow>(`SELECT DISTINCT ON(l.address) l.* FROM wallet_labels l
    WHERE l.address=ANY($1::bytea[]) AND l.valid_from_block<=$2 AND ($3::text IS NULL OR l.model_version=$3)
      AND NOT EXISTS(SELECT 1 FROM wallet_label_registry_dependencies d WHERE d.label_id=l.id AND NOT EXISTS(
        SELECT 1 FROM agent_registry r WHERE r.agent_id=d.agent_id AND r.wallet_block=d.wallet_block AND r.block_hash=d.block_hash))
      AND ${fingerprintCanonical('l')}
      AND NOT EXISTS(SELECT 1 FROM wallet_label_supersessions s JOIN wallet_labels replacement ON replacement.id=s.replacement_id
        WHERE s.prior_id=l.id AND ($3::text IS NULL OR replacement.model_version=$3) AND ${fingerprintCanonical('replacement')} AND NOT EXISTS(
        SELECT 1 FROM wallet_label_registry_dependencies d WHERE d.label_id=s.replacement_id AND NOT EXISTS(
          SELECT 1 FROM agent_registry r WHERE r.agent_id=d.agent_id AND r.wallet_block=d.wallet_block AND r.block_hash=d.block_hash)))
    ORDER BY l.address,l.valid_from_block DESC,l.id DESC`,[addresses.map(binary),block.toString(),modelVersion??null])).rows.map(r=>({...r,valid_from_block:String(r.valid_from_block)}));
}
/** Watcher owns every label write. Permissionless registration provides no behavioral score. */
export async function writeRegistryLabels(db:ChainDb,options:RegistryLabelOptions={}) {
  const model=options.modelVersion??REGISTRY_LABEL_MODEL;
  const snapshots=(await db.sql.query<RegistryRow>('SELECT * FROM agent_registry ORDER BY wallet_block,agent_id')).rows.map(r=>({...r,agent_id:String(r.agent_id),wallet_block:String(r.wallet_block),registered_block:String(r.registered_block)}));
  // The labels whose fingerprint run depends on a block that is no longer canonical, found once and per label: each
  // label's run has about five dependency rows. Written as the correlated check on `l` and again on `r`, the planner
  // compared every dependency row with every block, twice (8.9 million rows against 6.3 million on a copy of
  // 2026-10-13: 23.6 s, on three backends, each time a label was added; 3.1 s and the same rows this way).
  const independent=(await db.sql.query<WalletLabelRow>(`WITH orphaned AS MATERIALIZED (SELECT f.label_id FROM wallet_label_fingerprint_dependencies f
      CROSS JOIN LATERAL (SELECT 1 FROM wallet_fingerprint_dependencies d WHERE d.run_id=f.run_id
        AND NOT EXISTS(SELECT 1 FROM chain_blocks b WHERE b.number=d.block AND b.hash=d.block_hash) LIMIT 1) dependency)
    SELECT l.* FROM wallet_labels l WHERE source<>'erc8004' AND NOT EXISTS(SELECT 1 FROM orphaned o WHERE o.label_id=l.id)
      AND NOT EXISTS(SELECT 1 FROM wallet_label_supersessions s WHERE s.prior_id=l.id AND EXISTS(SELECT 1 FROM wallet_labels r WHERE r.id=s.replacement_id AND r.source=l.source
        AND NOT EXISTS(SELECT 1 FROM orphaned o WHERE o.label_id=r.id))) ORDER BY valid_from_block,id`)).rows.map(r=>{
    const behavioral=r.source==='fingerprint'?r.features.behavioral as {label:WalletLabel;confidence:number;tier:LabelTier|null;crewId:string|null}|undefined:undefined;
    return behavioral?{...r,label:behavioral.label,confidence:behavioral.confidence,tier:behavioral.tier,crew_id:behavioral.crewId}:r;
  });
  const independentAt=new Map<string,WalletLabelRow>();let independentIndex=0;
  const touched=new Set<string>(),addressAgents=new Map<string,Set<string>>();
  const blocks=[...new Set([...snapshots.map(r=>r.wallet_block),...independent.map(r=>String(r.valid_from_block)),...(options.crewBlocks??[]).map(String)])].map(BigInt).sort((a,b)=>a<b?-1:a>b?1:0);
  const state=new Map<string,RegistryRow>(),previous=new Map<string,WalletLabelRow>();
  let index=0,written=0;
  // Process all original boundaries: retroactive discovery can correct both the opening and closing cuts.
  for(const block of blocks) {
    const changed=new Set<string>();
    while(independentIndex<independent.length&&BigInt(independent[independentIndex].valid_from_block)<=block) {
      const r=independent[independentIndex++],address=hex(r.address);independentAt.set(address,r);
      if(touched.has(address))changed.add(address);
    }
    while(index<snapshots.length&&BigInt(snapshots[index].wallet_block)<=block) {
      const r=snapshots[index++],prior=state.get(r.agent_id);
      if(prior&&hex(prior.wallet)!==zero)changed.add(hex(prior.wallet));
      if(hex(r.wallet)!==zero)changed.add(hex(r.wallet));
      if(prior&&hex(prior.wallet)!==zero)touched.add(hex(prior.wallet));
      if(hex(r.wallet)!==zero)touched.add(hex(r.wallet));
      for(const w of [prior?.wallet,r.wallet])if(w&&hex(w)!==zero) {
        const ids=addressAgents.get(hex(w))??new Set<string>();ids.add(r.agent_id);addressAgents.set(hex(w),ids);
      }
      state.set(r.agent_id,r);
    }
    if(options.crewBlocks?.includes(block))for(const r of state.values())if(hex(r.wallet)!==zero)changed.add(hex(r.wallet));
    for(const address of [...changed].sort()) {
      const registrations=[...state.values()].filter(r=>hex(r.wallet)===address);
      const crew=await options.crewAt?.(address as Address,block)??null;
      if(crew&&(crew.status!=='qualified'||!crew.crewId||!Number.isFinite(crew.confidence)||crew.confidence<0||crew.confidence>1))throw new Error('Unqualified crew attachment');
      const prior=previous.get(address);
      // Keep independently written behavioral/crew evidence when the declaration is withdrawn.
      const fallback=independentAt.get(address);
      // Withdrawal without observed qualified crew/behavioral evidence remains explicitly unclassified.
      const label:WalletLabel=registrations.length?'declared_agent':crew?'crew':fallback?.label??'human';
      const confidence=registrations.length?0.99:crew?crew.confidence:fallback?.confidence??0;
      const tier=labelTier(confidence)??null,crewId=crew?.crewId??fallback?.crew_id??null;
      const features={permissionlessDeclaration:true,behavioralInference:false,registration:registrations.map(r=>({agentId:r.agent_id,registeredBlock:r.registered_block,walletBlock:r.wallet_block,evidence:r.evidence})),
        ...(crew?{crewEvidence:crew.evidence}:{}),...(!registrations.length?{withdrawn:true,unclassified:!crew&&!fallback,...(fallback?{restoredLabelId:fallback.id}:{})}:{})};
      const dependencies=[...state.values()].filter(r=>addressAgents.get(address)?.has(r.agent_id));
      const signature=JSON.stringify({label,tier,crewId});
      const independentOverridesDeclaration=registrations.length>0&&fallback&&BigInt(fallback.valid_from_block)===block
        && (fallback.label!==label||fallback.tier!==tier||fallback.crew_id!==crewId);
      if(prior&&JSON.stringify({label:prior.label,tier:prior.tier,crewId:prior.crew_id})===signature&&!independentOverridesDeclaration)continue;
      const digest=createHash('sha256').update(JSON.stringify({model,address,block:String(block),signature,features,dependencies:dependencies.map(r=>[r.agent_id,r.wallet_block,hex(r.block_hash)])})).digest('hex');
      await db.tx(async tx=>{
        const current=(await walletLabelsAt(tx,[address as Address],block)).find(r=>r.source==='erc8004'&&BigInt(r.valid_from_block)===block);
        const baseId=`wallet-label:${digest}`;
        const used=(await tx.sql.query('SELECT id FROM wallet_labels WHERE id=$1',[baseId])).rows.length>0;
        const id=current?.features.projectionHash===digest?current.id:used&&current?.id!==baseId
          ?`wallet-label:${createHash('sha256').update(`${digest}:${current?.id??'unavailable'}`).digest('hex')}`:baseId;
        const storedFeatures={...features,projectionHash:digest};
        const existing=(await tx.sql.query<{id:string}>('SELECT id FROM wallet_labels WHERE address=$1 AND valid_from_block=$2 AND model_version=$3',[binary(address),block.toString(),model])).rows[0];
        // Immutable correction rows use a fresh explicit generation, including replacement forks and retroactive inputs.
        const generation=existing&&existing.id!==id?`${model}:correction:${id.slice('wallet-label:'.length)}`:model;
        const inserted=await tx.sql.query(`INSERT INTO wallet_labels(id,address,label,confidence,tier,source,crew_id,features,model_version,valid_from_block)
          VALUES($1,$2,$3,$4,$5,'erc8004',$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,[id,binary(address),label,confidence,tier,crewId,JSON.stringify(storedFeatures),generation,block.toString()]);
        if(inserted.rows.length)written++;
        for(const r of dependencies)await tx.sql.query('INSERT INTO wallet_label_registry_dependencies(label_id,agent_id,wallet_block,block_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,r.agent_id,r.wallet_block,binary(hex(r.block_hash))]);
        if(fallback&&!registrations.length)await tx.sql.query('INSERT INTO wallet_label_fingerprint_dependencies(label_id,run_id) SELECT $1,run_id FROM wallet_label_fingerprint_dependencies WHERE label_id=$2 ON CONFLICT DO NOTHING',[id,fallback.id]);
        if(fallback&&BigInt(fallback.valid_from_block)===block&&registrations.length)await tx.sql.query('INSERT INTO wallet_label_supersessions(prior_id,replacement_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[fallback.id,id]);
        await tx.sql.query(`INSERT INTO wallet_label_supersessions(prior_id,replacement_id)
          SELECT id,$1 FROM wallet_labels WHERE address=$2 AND valid_from_block=$3 AND id<>$1
            AND (model_version=$4 OR starts_with(model_version,$4 || ':correction:')) ON CONFLICT DO NOTHING`,[id,binary(address),block.toString(),model]);
        previous.set(address,{id,address:binary(address),label,confidence,tier,source:'erc8004',crew_id:crewId,features:storedFeatures,model_version:generation,valid_from_block:block.toString()});
      });
    }
  }
  return {written,registryAgents:state.size,modelVersion:model,coverage:'indexed_mints_only'};
}
