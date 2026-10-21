import { CoinCardSchema, findingsFirst, isHardDanger, type CoinCard, type RadarRow } from '@eko/shared';
import { toUntrusted } from '@eko/untrusted';

/** One current revision per coin, with both entry and UTF-8 payload bounds. Shared by HTTP and live reads. */
export class RowProjectionCache {
  constructor(readonly maxEntries=2048,readonly maxBytes=32*1024*1024) {}
  private bytes=0;
  private entries=new Map<string,{revision:string;bytes:number;projection:RowProjection}>();
  get size(){return this.entries.size;}
  get byteSize(){return this.bytes;}
  get(coin:string,revision:string) {
    const entry=this.entries.get(coin);
    if(!entry || entry.revision!==revision)return undefined;
    this.entries.delete(coin);this.entries.set(coin,entry);
    return entry.projection;
  }
  set(coin:string,revision:string,data:unknown,name:string|null,symbol:string|null) {
    const existing=this.get(coin,revision);if(existing)return existing;
    const card=data ? CoinCardSchema.parse(data) : null,verdict=card?.verdict;
    const projection:RowProjection={card,name:toUntrusted(name ?? '',120),symbol:toUntrusted(symbol ?? '',32),
      missingChecks:[...new Set(Object.values(card?.meta ?? {}).flatMap(m=>m.missing ?? []))],missingKey:undefined,
      topPlaybook:verdict ? findingsFirst(verdict.playbooks)[0]?.id : undefined,
      hardDanger:verdict?.playbooks.some(m=>m.level==='danger' && isHardDanger(m.id)) ?? false};
    // Serialize immutable nested sections once. Their ordinary object/array shape remains available to consumers.
    const sections=[card?.signal,verdict?.playbooks,verdict?.evaluatedPlaybooks,verdict?.beta,projection.missingChecks,projection.name,projection.symbol];
    for(const value of sections)memoizeJson(value);
    if(card)freeze(card);
    const bytes=Buffer.byteLength(JSON.stringify(projection))+sections.reduce((n,v)=>n+(v ? Buffer.byteLength(JSON.stringify(v)) : 0),0)+4096;
    const old=this.entries.get(coin);if(old){this.bytes-=old.bytes;this.entries.delete(coin);}
    if(bytes>this.maxBytes)return projection;
    this.entries.set(coin,{revision,bytes,projection});this.bytes+=bytes;
    while(this.entries.size>this.maxEntries || this.bytes>this.maxBytes) {
      const key=this.entries.keys().next().value!;this.bytes-=this.entries.get(key)!.bytes;this.entries.delete(key);
    }
    return projection;
  }
}
const serialized=new WeakMap<object,string>();
function memoizeJson(value:unknown) {
  if(value && typeof value==='object'){serialized.set(value,JSON.stringify(value));freeze(value);}
}
function freeze(value:object) {
  if(Object.isFrozen(value))return;
  for(const child of Object.values(value))if(child && typeof child==='object')freeze(child);
  Object.freeze(value);
}
/** Reuse exact static fragments while serializing the row's live fields in their existing property order. */
export function serializeRadarRow(row:object):string {
  const fields:string[]=[];
  for(const [key,value] of Object.entries(row)) {
    const json=value && typeof value==='object' ? serialized.get(value) ?? JSON.stringify(value) : JSON.stringify(value);
    if(json!==undefined)fields.push(JSON.stringify(key)+':'+json);
  }
  return '{'+fields.join(',')+'}';
}
export function serializeRadarResponse(value:unknown):string {
  const page=value as {rows:object[]};
  return '{'+Object.entries(page).filter(([,v])=>v!==undefined).map(([key,v])=>JSON.stringify(key)+':'+(key==='rows' ? '['+page.rows.map(serializeRadarRow).join(',')+']' : JSON.stringify(v))).join(',')+'}';
}
export function rowMissingChecks(projection:RowProjection,card:CoinCard|null) {
  const key=JSON.stringify([card?.meta?.flow?.missing,card?.meta?.tradeability?.missing]);
  if(key!==projection.missingKey) {
    projection.missingChecks=[...new Set(Object.values(card?.meta ?? {}).flatMap(m=>m.missing ?? []))];
    projection.missingKey=key;memoizeJson(projection.missingChecks);
  }
  return projection.missingChecks;
}
export interface RowProjection {
  missingKey?:string;card:CoinCard|null;name:RadarRow['name'];symbol:RadarRow['symbol'];missingChecks:string[];
  topPlaybook:RadarRow['topPlaybook'];hardDanger:boolean;
}
