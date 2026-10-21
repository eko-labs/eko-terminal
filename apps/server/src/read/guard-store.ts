import { HEADER_COUNTS_SQL, GUARD_HEADER_TODAY_SQL, GUARD_LIVE_COINS_SQL } from './header-totals.js';
import { MinuteSnapshot } from './minute-snapshot.js';
import { binary, hex, guardRowsKnownAt, GuardReceiptStore, type ChainDb, type GuardStoredRow } from '@eko/db';
import { keccak256, toHex } from 'viem';
import {
  GuardAvailabilityManifestSchema, GuardAssessmentV2Schema, GuardVerdictRevisionInputSchema,
  GuardEvidenceResponseSchema, NegotiatedCoinCardSchema, NegotiatedGuardVerdictSchema,
  GuardReadRequestSchema, GuardTotalsSchema, GuardListResponseSchema, GuardScanResponseSchema, Bytes32Schema,
  type Address, type GuardStoredEvidence, type GuardVerdictRevisionInput, type GuardAvailabilityManifest,
  type CoinSummaryV2, type GuardTotals,
} from '@eko/shared';
import { LaunchRoleSnapshotSchema } from '@eko/chain';
import { toUntrusted } from '@eko/untrusted';
import type { ReadStore } from './store.js';
import { projectCoinCardV2 } from './guard-card.js';
import { decodeCursor, encodeCursor } from './pagination.js';
import { InputError } from '../http/v1/helpers.js';

/** §7.2: a candidate read path never changes the active 1.0.x manifest. */
export const GUARD_READ_ACTIVE_VERSION = 'verdict-1' as const;
// V2 includes indexed partial non-Pons identity. V1 eligibility remains unchanged.
export class GuardReadStore {
  constructor(readonly legacy: ReadStore) {
    this.header=new MinuteSnapshot<GuardTotals>({status:'unavailable',activeVersion:GUARD_READ_ACTIVE_VERSION,failureCode:'missing'},()=>this.computeTotals(),()=>legacy.now());
    legacy.onSummaryRefresh(()=>this.header.refresh());
  }
  get db():ChainDb {return this.legacy.db;}
  private async manifest():Promise<GuardAvailabilityManifest|null> {
    const rows=(await this.db.sql.query<{data:unknown}>(`SELECT m.data FROM guard_availability m
      WHERE m.chain_id=4663 AND m.replay_mode='production' AND NOT EXISTS(SELECT 1 FROM guard_source_events e WHERE e.target_id=m.id)
      ORDER BY m.watermark_position DESC,m.acquisition_sequence DESC,m.id LIMIT 1`)).rows;
    return rows[0]?GuardAvailabilityManifestSchema.parse(rows[0].data):null;
  }
  async read(request:unknown,resource:'card'|'verdict') {
    const {address,version}=GuardReadRequestSchema.parse(request);
    return resource==='card'?this.negotiatedCard(address,version):this.negotiatedVerdict(address,version);
  }
  private cut(coin:Address,m:GuardAvailabilityManifest) {return {coin,chainId:4663,manifestId:m.id,state:m.watermark,availability:m.cut};}
  async verdict(coin:Address) {
    const m=await this.manifest(); if(!m)return null;
    const rows=await guardRowsKnownAt<GuardVerdictRevisionInput>(this.db,'guard_verdict_revisions',this.cut(coin,m));
    // Only token-wide assessment contexts; an order-specific result is not a coin verdict.
    const r=rows.filter(r=>r.data.context.routeId===null && r.data.context.sizeUsd===null && r.data.context.accountClass===null).at(-1);
    if(!r)return null;
    const a=GuardAssessmentV2Schema.parse(r.data.assessment), receipt=await new GuardReceiptStore(this.db).get(a.receipt.id);
    if(!receipt)throw new Error('Guard assessment receipt unavailable');
    return {...a,receipt:receipt.receipt};
  }
  private decode(row:GuardStoredRow<GuardStoredEvidence> & {content?:Uint8Array}) {
    if(!row.content || keccak256(toHex(row.content))!==row.payload_hash || row.object_ref!==row.payload_hash)throw new Error('Guard evidence content hash mismatch');
    return JSON.parse(new TextDecoder().decode(row.content)) as unknown;
  }
  async card(coin:Address) {
    const token=(await this.db.sql.query<{name:string|null;symbol:string|null}>('SELECT name,symbol FROM tokens WHERE address=$1',[binary(coin)])).rows[0];
    if(!token)return null;
    const assessment=await this.verdict(coin);
    let m=await this.manifest();
    if(assessment) {
      // Keep the card at the decision's original captured availability, not a newer source cut.
      const row=(await this.db.sql.query<{data:GuardVerdictRevisionInput}>('SELECT data FROM guard_verdict_revisions WHERE receipt_id=$1',[assessment.receipt.id])).rows[0];
      const stored=GuardVerdictRevisionInputSchema.parse(row.data);
      m=GuardAvailabilityManifestSchema.parse((await this.db.sql.query<{data:unknown}>('SELECT data FROM guard_availability WHERE id=$1',[stored.manifestId])).rows[0].data);
    }
    let cursor=assessment?.cursor ?? m?.watermark;
    if(!cursor) {
      const header=(await this.db.sql.query<{number:string;hash:Uint8Array;ts:Date}>(`SELECT number,hash,ts FROM chain_blocks ORDER BY number DESC LIMIT 1`)).rows[0];
      if(!header)return null; // Never invent a state hash for legacy-only data.
      cursor={chainId:4663,blockNumber:String(header.number),blockHash:hex(header.hash),timestampSec:String(Math.floor(new Date(header.ts).getTime()/1000)),transactionIndex:null,executionOrdinal:null,boundary:'block_end'};
    }
    const cut=assessment?.availabilityCut ?? m?.cut ?? {cursor,acquisitionSequence:'0'};
    const read=m?{...this.cut(coin,m),state:cursor,availability:cut}:null;
    const measurements=read?await guardRowsKnownAt<GuardStoredEvidence>(this.db,'guard_measurement_evidence',read):[];
    const chains=read?await guardRowsKnownAt<GuardStoredEvidence>(this.db,'guard_chain_evidence',read):[];
    const launchRow=chains.filter(r=>r.data.sourceItemId==='launch-roles').at(-1);
    const launchContent=launchRow?this.decode(launchRow):null;
    const launch=launchContent && typeof launchContent==='object' && 'snapshot' in launchContent ? {snapshot:LaunchRoleSnapshotSchema.parse(launchContent.snapshot),evidence:{...launchRow!.data.evidence,id:Bytes32Schema.parse(launchRow!.id)}}:null;
    const legacy=(await this.db.sql.query<{rules_version:string}>('SELECT rules_version FROM verdicts WHERE coin=$1 AND NOT EXISTS(SELECT 1 FROM verdict_events e WHERE e.verdict_id=verdicts.id AND e.kind=\'orphaned\') ORDER BY valid_from_block DESC,id DESC LIMIT 1',[binary(coin)])).rows[0];
    return projectCoinCardV2({manifest:m,coin,...token,cursor,cut,servedAtSec:Math.floor(this.legacy.now()/1000),assessment,
      legacy:await this.legacy.verdict(coin),legacyRulesVersion:legacy?.rules_version ?? null,launch,
      measurements:measurements.map(r=>({content:this.decode(r),evidence:{...r.data.evidence,id:Bytes32Schema.parse(r.id)}}))});
  }
  /** Explicit negotiation used by REST and future MCP readers; default V1 is untouched. */
  async negotiatedCard(coin:Address,version:1|2) {
    if(version===2)return NegotiatedCoinCardSchema.parse({version,card:await this.card(coin)});
    const card=await this.legacy.card(coin);return card?NegotiatedCoinCardSchema.parse({version,card}):null;
  }
  async negotiatedVerdict(coin:Address,version:1|2) {
    if(version===2)return NegotiatedGuardVerdictSchema.parse({version,verdict:await this.verdict(coin)});
    const verdict=await this.legacy.verdict(coin);return verdict?NegotiatedGuardVerdictSchema.parse({version,verdict}):null;
  }
  async evidence(coin:Address,id:string) {
    const key=Bytes32Schema.parse(id),m=await this.manifest();if(!m)return null;
    const read=this.cut(coin,m);
    for(const table of ['guard_chain_evidence','guard_measurement_evidence'] as const) {
      const rows=await guardRowsKnownAt<GuardStoredEvidence>(this.db,table,read),row=rows.find(r=>r.id===key);
      if(row)return GuardEvidenceResponseSchema.parse({reference:{...row.data.evidence,id:key,...(row.data.evidence.text?{text:toUntrusted(row.data.evidence.text.text,4000)}:{})},payload:toUntrusted(JSON.stringify(this.decode(row)),16000),dependencyIds:row.dependency_ids});
    }
    return null;
  }
  async summary(coin:Address):Promise<CoinSummaryV2> {
    const token=(await this.db.sql.query<{name:string|null;symbol:string|null}>('SELECT name,symbol FROM tokens WHERE address=$1',[binary(coin)])).rows[0];
    const a=await this.verdict(coin);
    return {address:coin,name:toUntrusted(token?.name,120),symbol:toUntrusted(token?.symbol,32),level:a?.level ?? null,verdictPending:a===null,incompleteCoverage:a!==null && (!a.completeness.buyCriticalComplete || !a.completeness.lowerTierComplete),mode:a?.mode ?? null};
  }
  async list(cursor?:string) {
    await this.legacy.currentModels();
    const key=decodeCursor(cursor,'guard-coins');
    if(key && (key.length!==1 || typeof key[0]!=='string' || !/^0x[0-9a-f]{40}$/.test(key[0])))throw new InputError('Invalid Guard cursor');
    // The host computes eligibility with the totals once a minute. Seek the sorted snapshot in logarithmic time.
    let lo=0,hi=this.live.length;
    if(key)while(lo<hi) {const mid=(lo+hi)>>>1;if(this.live[mid]<=String(key[0]))lo=mid+1;else hi=mid;}
    const rows=this.live.slice(lo,lo+101).map(coin=>({coin:binary(coin)}));
    const page=rows.slice(0,100);
    const summaries:CoinSummaryV2[]=[];for(const row of page)summaries.push(await this.summary(hex(row.coin)));
    return GuardListResponseSchema.parse({version:2,rows:summaries,cursor:rows.length>100?encodeCursor('guard-coins',[hex(page.at(-1)!.coin)]):null,totals:await this.totals()});
  }
  async scan(q:string) {
    const query=q.replace(/^\$/,'');
    const rows=(await this.db.sql.query<{address:Uint8Array}>(`SELECT address FROM tokens WHERE lower(symbol)=lower($1) OR lower(name)=lower($1) OR encode(address,'hex')=lower($2) ORDER BY address LIMIT 101`,[query,query.replace(/^0x/,'')])).rows;
    const candidates:CoinSummaryV2[]=[];for(const row of rows.slice(0,100))candidates.push(await this.summary(hex(row.address)));
    const card=rows.length===1?await this.card(hex(rows[0].address)):null;
    return GuardScanResponseSchema.parse({version:2,status:!rows.length?'not_found':rows.length>1?'ambiguous':card?.verdict?'ready':'pending',cards:card?[card]:[],candidates});
  }
  private live:Address[]=[];
  private header:MinuteSnapshot<GuardTotals>;
  totals():Promise<GuardTotals> {return Promise.resolve(this.header.value);}
  /** Explicit host/test refresh, never called by a request. */
  refreshTotals() {return this.header.refresh(true);}
  private async computeTotals():Promise<GuardTotals> {
    await this.legacy.currentModels({ snapshot: true });
    const cutoff=new Date(this.legacy.now()-7*86400000),day=Math.floor(this.legacy.now()/86400000)*86400;
    const source=(await this.db.sql.query('SELECT 1 FROM chain_blocks LIMIT 1')).rows.length;
    if(!source)return GuardTotalsSchema.parse({status:'unavailable',activeVersion:GUARD_READ_ACTIVE_VERSION,failureCode:'missing'});
    const counts=(await this.db.sql.query<{coins:string;lower:string;elevated:string;high:string;incomplete:string;no_verdict:string}>(HEADER_COUNTS_SQL,[cutoff])).rows[0];
    const today=(await this.db.sql.query<{n:string}>(GUARD_HEADER_TODAY_SQL,[day,day+86400,cutoff])).rows[0];
    const live=(await this.db.sql.query<{coin:Uint8Array}>(GUARD_LIVE_COINS_SQL,[cutoff])).rows.map(r=>hex(r.coin));
    this.live=live;
    const n=Number(counts.no_verdict),incomplete=Number(counts.incomplete);
    return GuardTotalsSchema.parse({status:'observed',activeVersion:GUARD_READ_ACTIVE_VERSION,coins:Number(counts.coins),lower:Number(counts.lower),elevated:Number(counts.elevated),high:Number(counts.high),incomplete,noVerdict:n,incompleteCoverage:incomplete,evaluatedToday:Number(today.n),clear:Number(counts.lower),monitor:Number(counts.elevated),danger:Number(counts.high),pending:incomplete+n});
  }
}
