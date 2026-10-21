import { hex, binary, ScanJobs, scanTarget, type ScanJob } from '@eko/db';
import { toUntrusted } from '@eko/untrusted';
import type { ScanResult, RadarRow } from '@eko/shared';
import type { ReadStore } from './store.js';
export class ScanService {
  readonly jobs:ScanJobs;
  constructor(readonly store:ReadStore) {this.jobs=new ScanJobs(store.db,()=>store.now());}
  async get(id:string):Promise<ScanResult|undefined> {
    const job=await this.jobs.get(id);
    return job ? this.resolve(scanTarget(job) ?? job.query,job) : undefined;
  }
  async scan(query:string):Promise<ScanResult> {return this.resolve(query.trim().replace(/^\$/,'').toLowerCase());}
  private async resolve(query:string,job?:ScanJob):Promise<ScanResult> {
    await this.store.currentModels();
    const q=query.replace(/^\$/,'').toLowerCase();
    const isAddress=/^0x[0-9a-f]{40}$/.test(q);
    let ids:Uint8Array[];
    if(isAddress)ids=[binary(q)];
    else ids=(await this.store.db.sql.query<{address:Uint8Array}>(`WITH matches AS MATERIALIZED (
      (SELECT address FROM tokens WHERE left(lower(symbol),64)=left($1,64) AND lower(symbol)=$1 ORDER BY address LIMIT 101) UNION
      (SELECT address FROM tokens WHERE read_name_terms(name) @> ARRAY[left($1,least(length($1),3))] AND position($1 in lower(name))>0 LIMIT 101)
    ) SELECT address FROM matches ORDER BY address LIMIT 101`,[q])).rows.map(t=>t.address);
    const found=await this.store.db.sql.query<{address:Uint8Array;name:string;symbol:string;launchpad:string;curve:Uint8Array|null;graduated_block:string|null;level:RadarRow['verdict']|null}>(`SELECT t.address,t.name,t.symbol,t.launchpad,t.curve,t.graduated_block,c.data->'verdict'->>'level' AS level FROM tokens t
      LEFT JOIN coin_card_latest c ON c.coin=t.address AND c.coin=ANY($1::bytea[]) WHERE t.address=ANY($1::bytea[]) ORDER BY t.address`,[ids]);
    const matches=found.rows.map(t=>({row:{address:hex(t.address),name:toUntrusted(t.name ?? '',120),symbol:toUntrusted(t.symbol ?? '',32),launchpad:t.launchpad==='pons' ? 'pons' : 'other',stage:t.curve && !t.graduated_block ? 'curve' : 'graduated',priceUsd:0,priceUnavailable:true,change1hPct:0,liquidityUsd:0,verdict:t.level ?? 'pending',verdictPending:!t.level,ageSec:0,flow:{window:'1h',agentPct:0,crewPct:0,humanPct:0,washEstPct:0,beta:true,confidence:0},exitCost1kPct:0,rank:0,unavailable:['exitCost','flow','liquidity','signal','change','marketCap']} as RadarRow}));
    const target=matches.length===1 ? matches[0].row.address : isAddress ? q as import('@eko/shared').Address : undefined;
    const card=matches.length===1 ? await this.store.card(matches[0].row.address) : null;
    const status=card ? 'ready' : matches.length>1 ? 'ambiguous' : matches.length===1 || isAddress ? 'pending' : 'not_found';
    job ??=await this.jobs.ensure(q,target,status);
    if(status==='pending')await this.store.db.sql.query('UPDATE scan_jobs SET first_pending_at=coalesce(first_pending_at,$2) WHERE id=$1 AND first_pending_at IS NULL',[job.id,new Date(this.store.now())]);
    const base={id:job.id,shareUrl:`/scan/${job.id}`};
    if(!matches.length) {
      if(isAddress && job.status!=='not_found')return {...base,status:'pending',message:'Token acquisition is queued or awaiting indexed evidence.'};
      return {...base,status:'not_found',message:'No token matches this search.'};
    }
    if(matches.length>1)return {...base,status:'ambiguous',candidates:matches.slice(0,100).map(m=>m.row)};
    return card ? {...base,status:'ready',card} : {...base,status:'pending',candidates:[matches[0].row],message:'Token identity is indexed. A coin card is not available yet.'};
  }
}
