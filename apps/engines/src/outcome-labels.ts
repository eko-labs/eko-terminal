import { compareGuardCursors, guardKnownBy, AvailabilityCutSchema, type AvailabilityCut, type GuardCursor, type Rational } from '@eko/shared';
import { referenceDigest, replayPonsCampaign } from '@eko/chain';
import { OutcomeLabelInputSchema, type OutcomeLabelInput, type OutcomeResponsibility } from './outcome-input.js';

export const OUTCOME_CONFIRMATION_LAG_SEC = 30;
const n = (r: Rational) => BigInt(r.numerator), d = (r: Rational) => BigInt(r.denominator);
const cmp = (a: Rational, b: Rational) => n(a)*d(b) < n(b)*d(a) ? -1 : n(a)*d(b) > n(b)*d(a) ? 1 : 0;
const integer = (v: number): Rational => ({ numerator: String(v), denominator: '1' });
const sub = (a: Rational, b: Rational): Rational => ({ numerator: String(n(a)*d(b)-n(b)*d(a)), denominator: String(d(a)*d(b)) });
const drawdown = (a: Rational, b: Rational): Rational => { const diff = sub(a,b); return { numerator: String(n(diff)*d(a)*100n), denominator: String(d(diff)*n(a)) }; };
const same = (a: GuardCursor, b: GuardCursor) => a.chainId===b.chainId&&a.blockNumber===b.blockNumber&&a.blockHash===b.blockHash&&a.timestampSec===b.timestampSec&&a.boundary===b.boundary&&a.transactionIndex===b.transactionIndex&&a.executionOrdinal===b.executionOrdinal;
type Qualification = 'qualified' | 'not_qualified' | 'unknown';
type Kind = 'restriction' | 'rug' | 'harmful_disposition' | 'dump' | 'collapse' | 'survived';
type Status = 'provisional' | 'confirmed_under_policy' | 'indeterminate' | 'censored';
type Mark = {cursor:GuardCursor;value:Rational};
type Attribution = 'operator' | 'non_operator' | 'origin_unresolved' | 'unknown';

function responsibility(p: OutcomeResponsibility|null, event: GuardCursor, cut: AvailabilityCut): Attribution {
  if (!p || !guardKnownBy(p.knownAt,cut) || compareGuardCursors(p.effectiveFrom,event)>0 ||
    p.effectiveThrough && compareGuardCursors(event,p.effectiveThrough)>0 || !p.reviewed) return 'unknown';
  if (p.kind==='non_operator') return 'non_operator';
  if (p.kind==='origin') return 'origin_unresolved';
  if (['authenticated_control','reviewed_closed_loop','exercised_configuration'].includes(p.kind) && p.operatorGroupId && p.precisionAccepted) return 'operator';
  return 'unknown';
}
export function outcomeStreamKey(i: OutcomeLabelInput) {
  return referenceDigest({ coin:i.coin,chainId:i.launchCursor.chainId,eventId:i.eventId,horizonSec:i.horizonSec,
    outcomeVersion:i.outcomeVersion,identityVersion:i.identityVersion,replayMode:i.replayMode,accountClass:i.accountClass });
}

/** Validate no-lookahead evidence and block-end selection independently of label predicates. */
export function validateOutcomeInput(raw: OutcomeLabelInput) {
  const i=OutcomeLabelInputSchema.parse(raw);
  if (i.coin===i.quoteAsset || i.launchCursor.boundary!=='block_end' || !same(i.boundaries[0].cursor,i.launchCursor)) throw new Error('Outcome launch/asset pin');
  const available = (p:{cursor:GuardCursor;knownAt:AvailabilityCut}) => {
    if (!guardKnownBy(p.knownAt,i.availabilityCut) || compareGuardCursors(p.cursor,p.knownAt.cursor)>0) throw new Error('Outcome evidence exceeds availability cut');
  };
  let previous:GuardCursor|null=null;
  for (const b of i.boundaries) {
    if (b.cursor.boundary!=='block_end' || compareGuardCursors(b.cursor,i.availabilityCut.cursor)>0 ||
      previous && (BigInt(b.cursor.blockNumber)!==BigInt(previous.blockNumber)+1n || b.parentHash!==previous.blockHash || BigInt(b.cursor.timestampSec)<BigInt(previous.timestampSec))) throw new Error('Outcome completed prefix');
    previous=b.cursor;
  }
  const blockIndex=new Map(i.boundaries.map(b=>[b.cursor.blockNumber,b]));
  const within = (c:GuardCursor) => {
    const b=blockIndex.get(c.blockNumber);
    if (!b || b.cursor.blockHash!==c.blockHash || b.cursor.timestampSec!==c.timestampSec || c.chainId!==i.launchCursor.chainId || compareGuardCursors(c,i.launchCursor)<0) throw new Error('Outcome event pin');
  };
  for (const p of [...i.entries,...i.checkpoints,...i.withdrawals,...i.restrictions,...i.selling.sales]) { available(p);within(p.cursor); }
  for (const c of i.relevantBoundaries) within(c);
  for (const w of i.withdrawals) if(w.successorObservedThrough) {within(w.successorObservedThrough);if(compareGuardCursors(w.cursor,w.successorObservedThrough)>0)throw new Error('Outcome successor interval');}
  for (const c of i.campaigns) {
    if(c.input.coin!==i.coin || c.input.origin!==i.origin || c.input.quoteAsset!==i.quoteAsset || c.input.quoteDecimals!==i.quoteDecimals || !guardKnownBy(c.input.knownAt,i.availabilityCut)) throw new Error('Outcome campaign binding');
    within(c.input.campaign.from);within(c.input.campaign.through);
  }
  if(new Set([...i.campaigns,...i.withdrawals,...i.restrictions].map(e=>e.eventId)).size!==i.campaigns.length+i.withdrawals.length+i.restrictions.length)throw new Error('Duplicate outcome event ID');
  if(new Set(i.entries.map(e=>e.sizeUsd)).size!==i.entries.length || new Set(i.checkpoints.map(e=>`${e.cursor.chainId}:${e.cursor.blockNumber}:${e.cursor.boundary}:${e.cursor.transactionIndex}:${e.sizeUsd}`)).size!==i.checkpoints.length)throw new Error('Duplicate benchmark record');
  for (const e of i.checkpoints) if(e.quoteAsset!==i.quoteAsset||e.quoteDecimals!==i.quoteDecimals||e.cursor.boundary!=='block_end'||e.status==='executed'&&(!e.netQuote||!e.routeId||e.quantity==='0'))throw new Error('Outcome exit binding');
  return i;
}

/** Pure fixture/shadow labeler. Confirmation is an operational policy, never a finality claim. */
export function evaluateOutcomeLabels(raw: OutcomeLabelInput, rawWatermark: AvailabilityCut, canonicalRechecked: boolean) {
  const i=validateOutcomeInput(raw), watermark=AvailabilityCutSchema.parse(rawWatermark);
  if(watermark.cursor.boundary!=='block_end'||!guardKnownBy(i.availabilityCut,watermark))throw new Error('Outcome watermark precedes capture');
  const target=BigInt(i.launchCursor.timestampSec)+BigInt(i.horizonSec);
  const boundaryAt=(sec:bigint)=>{
    let lo=0,hi=i.boundaries.length;
    while(lo<hi){const mid=Math.floor((lo+hi)/2);if(BigInt(i.boundaries[mid].cursor.timestampSec)<sec)lo=mid+1;else hi=mid;}
    return i.boundaries[lo]?.cursor??null;
  };
  const maturity=boundaryAt(target), entryCursor=boundaryAt(BigInt(i.launchCursor.timestampSec)+60n);
  const mature=!!maturity&&compareGuardCursors(maturity,watermark.cursor)<=0;
  const confirmed=mature&&BigInt(watermark.cursor.timestampSec)>=BigInt(maturity!.timestampSec)+30n&&canonicalRechecked;
  const immature=BigInt(watermark.cursor.timestampSec)<target;
  const scheduled:GuardCursor[]=[],scheduledKeys=new Set<string>();
  const schedule=(c:GuardCursor|null)=>{if(c&&!scheduledKeys.has(`${c.blockNumber}:${c.boundary}:${c.transactionIndex}`)){scheduledKeys.add(`${c.blockNumber}:${c.boundary}:${c.transactionIndex}`);scheduled.push(c);}};
  for(let sec=BigInt(i.launchCursor.timestampSec)+60n;sec<=target;sec+=60n) {const c=boundaryAt(sec);schedule(c);}
  schedule(maturity);
  for(const c of i.relevantBoundaries) if(entryCursor&&compareGuardCursors(c,entryCursor)>=0&&maturity&&compareGuardCursors(c,maturity)<=0)schedule(c);
  scheduled.sort(compareGuardCursors);
  const usableExit=(e:OutcomeLabelInput['checkpoints'][number])=>e.status==='executed'&&e.independentlyVerified&&(i.origin==='fixture'||e.fidelityAccepted);
  const exitIndex=new Map(i.checkpoints.map(e=>[`${e.sizeUsd}:${e.cursor.blockNumber}`,e]));
  const benchmarks=([100,1000] as const).map(sizeUsd=>{
    const entry=i.entries.find(e=>e.sizeUsd===sizeUsd), checkpoints=scheduled.map(cursor=>{const e=exitIndex.get(`${sizeUsd}:${cursor.blockNumber}`);return e&&same(e.cursor,cursor)?e:null;});
    const validEntry=!!entry&&entry.status==='purchased'&&entry.quantity!=='0'&&n(entry.inputQuote)>0n&&n(entry.spentQuote)>0n&&cmp(entry.spentQuote,entry.inputQuote)<=0&&n(entry.gasQuote)>=0n&&entry.independentlyVerified&&(i.origin==='fixture'||entry.fidelityAccepted)&&!!entryCursor&&same(entry.cursor,entryCursor);
    const complete=validEntry&&!!maturity&&i.coverage.checkpoints&&checkpoints.length>0&&checkpoints.every(e=>!!e&&e.quantity===entry!.quantity&&usableExit(e));
    return {sizeUsd,entry:entry??null,complete,checkpoints};
  });
  const primary=benchmarks[0];
  let peak:Mark|null=null,trough:Mark|null=null,largest:Rational|null=null;
  // Chronological running peak -> later trough. Strict updates retain earliest ties and any recovered collapse.
  for(const e of primary.checkpoints) if(e&&entryCursor&&primary.entry?.status==='purchased'&&primary.entry.independentlyVerified&&(i.origin==='fixture'||primary.entry.fidelityAccepted)&&same(primary.entry.cursor,entryCursor)&&e.quantity===primary.entry.quantity&&usableExit(e)&&e.netQuote) {
    if(peak&&n(peak.value)>0n){const dd=drawdown(peak.value,e.netQuote);if(!largest||cmp(dd,largest)>0){largest=dd;trough={cursor:e.cursor,value:e.netQuote};}}
    if(!peak||cmp(e.netQuote,peak.value)>0)peak={cursor:e.cursor,value:e.netQuote};
  }
  // Pin the peak for the maximum drawdown, separately from the eventual global/horizon value.
  let collapsePeak:Mark|null=null;
  if(trough) for(const e of primary.checkpoints) if(e&&e.quantity===primary.entry?.quantity&&usableExit(e)&&e.netQuote&&compareGuardCursors(e.cursor,trough.cursor)<0&&(!collapsePeak||cmp(e.netQuote,collapsePeak.value)>0))collapsePeak={cursor:e.cursor,value:e.netQuote};
  const collapseQ:Qualification=largest&&cmp(largest,integer(90))>=0?'qualified':primary.complete?'not_qualified':'unknown';
  const sellingComplete=i.selling.swapsComplete&&i.selling.transfersComplete&&i.selling.actorsComplete;
  const declineSales=collapsePeak&&trough?i.selling.sales.filter(s=>compareGuardCursors(s.cursor,collapsePeak!.cursor)>0&&compareGuardCursors(s.cursor,trough!.cursor)<=0):[];
  let recovery:Mark|null=null;
  if(trough)for(const e of primary.checkpoints)if(e&&usableExit(e)&&e.netQuote&&compareGuardCursors(e.cursor,trough.cursor)>0&&(!recovery||cmp(e.netQuote,recovery.value)>0))recovery={cursor:e.cursor,value:e.netQuote};
  const noSellingLiteral=collapseQ==='qualified'&&sellingComplete&&declineSales.every(s=>s.units==='0'||s.operatorOrLaunchLinked===false);
  const allEventChecks=i.coverage.events&&i.coverage.controls&&i.coverage.routes;
  const facts:{kind:Kind;eventId:string;qualification:Qualification;attribution:Attribution;unresolved:boolean;details:unknown;evidenceIds:string[]}[]=[];
  const add=(kind:Kind,eventId:string,qualification:Qualification,attribution:Attribution,unresolved:boolean,details:unknown,evidenceIds:string[]=i.evidenceIds)=>facts.push({kind,eventId,qualification,attribution,unresolved,details,evidenceIds});
  for(const c of i.campaigns.filter(c=>!maturity||compareGuardCursors(c.input.campaign.through,maturity)<=0)) {
    const r=replayPonsCampaign(c.input), sellOnly=r.interventions.find(x=>x.kind==='sell_only')!;
    const f=c.input.campaign.openingFloat,usd=c.input.campaign.quoteUsd,reserve=r.raw.openingRealReserve;
    const materialBranches={float:f&&BigInt(f)>0n?BigInt(r.raw.sold)*100n>=BigInt(f):null,
      netUsd:usd&&n(usd)>0n?BigInt(r.raw.netTradingCashOut)>0n&&BigInt(r.raw.netTradingCashOut)*n(usd)>=500n*10n**BigInt(i.quoteDecimals)*d(usd):null,
      reserve:reserve&&BigInt(reserve)>0n?BigInt(r.raw.gross)*10n>=BigInt(reserve):null};
    const material=Object.values(materialBranches).some(v=>v===true);
    const materialKnown=material||Object.values(materialBranches).every(v=>v!==null);
    const cohortTests=r.actual?.map(cohort=>{
      const cf=sellOnly.cohorts?.find(v=>v.cohort===cohort.cohort),contribution=sellOnly.contributionPp?.find(v=>v.cohort===cohort.cohort)?.value??null;
      const coverage=cohort.sufficient&&!!cf?.sufficient;
      return {cohort:cohort.cohort,coverage,loss:cohort.costWeightedReturnPp,contribution,
        passes:coverage&&!!cohort.costWeightedReturnPp&&cmp(cohort.costWeightedReturnPp,integer(-30))<=0&&!!contribution&&cmp(contribution,integer(10))>=0};
    })??[];
    const netPositive=BigInt(r.raw.netTradingCashOut)>0n;
    const q:Qualification=!r.rawComplete||r.status==='open'?'unknown':!netPositive||materialKnown&&!material?'not_qualified':
      sellOnly.status!=='valid'||!cohortTests.some(t=>t.coverage)?'unknown':material&&cohortTests.some(t=>t.passes)?'qualified':materialKnown&&cohortTests.every(t=>t.coverage||!r.actual?.find(v=>v.cohort===t.cohort)?.wallets.length)?'not_qualified':'unknown';
    const attr=responsibility(c.responsibility,r.from,i.availabilityCut);
    const controlled=attr==='operator'&&!!c.responsibility&&['authenticated_control','reviewed_closed_loop'].includes(c.responsibility.kind)&&c.input.campaign.sellingSide.every(a=>c.responsibility!.saleActors.includes(a));
    const details={replayId:r.id,materialBranches,raw:r.raw,cohorts:r.actual,cohortTests,interventions:r.interventions,pressure:r.pressure,originActors:c.input.campaign.sellingSide};
    add('harmful_disposition',c.eventId,q,attr,q==='qualified'&&['unknown','origin_unresolved'].includes(attr),details,r.evidenceIds);
    add('dump',c.eventId,q==='not_qualified'?'not_qualified':q==='qualified'&&attr==='non_operator'?'not_qualified':
      q==='qualified'&&controlled&&r.rawComplete&&c.input.campaign.fidelityAccepted&&c.input.campaign.coverageComplete&&c.calibrated?'qualified':'unknown',attr,!controlled,details,r.evidenceIds);
  }
  if(!facts.some(f=>f.kind==='harmful_disposition')) for(const kind of ['harmful_disposition','dump'] as const)add(kind,i.eventId,i.coverage.events?'not_qualified':'unknown','unknown',false,null);
  for(const w of i.withdrawals.filter(w=>!maturity||compareGuardCursors(w.cursor,maturity)<=0)) {
    const value=w.preInventoryUsd,remaining=w.remainingInventoryUsd,pre=w.preTokenWideSell2,post=w.postTokenWideSell2;
    const observation=w.successorObservedThrough&&BigInt(w.successorObservedThrough.timestampSec)>=BigInt(w.cursor.timestampSec)+600n;
    const inventoryPct=value&&remaining&&n(value)>0n?drawdown(value,remaining):null;
    const depthPct=pre&&post&&n(pre)>0n?drawdown(pre,post):null;
    const known=value&&remaining&&pre&&post&&inventoryPct&&depthPct&&[value,remaining,pre,post].every(v=>n(v)>=0n)&&cmp(remaining,value)<=0&&cmp(post,pre)<=0;
    const q:Qualification=w.removable==='nonwithdrawable'||w.successor==='equivalent_reachable'?'not_qualified':
      w.removable!=='verified'||!w.authorizedRemover||!w.authorityVerified||!known||!w.routeDiscoveryComplete||w.successor==='unknown'||!observation?'unknown':
      cmp(value!,integer(500))>=0&&cmp(inventoryPct!,integer(99))>=0&&cmp(depthPct!,integer(90))>=0?'qualified':'not_qualified';
    const attr=w.responsibility?.actor===w.authorizedRemover?responsibility(w.responsibility,w.cursor,i.availabilityCut):'unknown';
    add('rug',w.eventId,q,attr,q==='qualified'&&['unknown','origin_unresolved'].includes(attr),{...w,inventoryPct,depthPct},w.evidenceIds);
  }
  if(!facts.some(f=>f.kind==='rug'))add('rug',i.eventId,i.coverage.events&&i.coverage.routes?'not_qualified':'unknown','unknown',false,null);
  for(const r of i.restrictions.filter(r=>!maturity||compareGuardCursors(r.cursor,maturity)<=0)) {
    const q:Qualification=!['token_enforced','confiscation'].includes(r.failure)?'not_qualified':r.independentlyReproduced&&r.temporaryResolved&&r.accountClass===i.accountClass?'qualified':'unknown';
    const a=responsibility(r.responsibility,r.cursor,i.availabilityCut);
    const attr=r.responsibility&&['authenticated_control','exercised_configuration'].includes(r.responsibility.kind)?a:'unknown';
    add('restriction',r.eventId,q,attr,q==='qualified'&&attr==='unknown',r,r.evidenceIds);
  }
  if(!facts.some(f=>f.kind==='restriction'))add('restriction',i.eventId,i.coverage.controls&&i.coverage.events?'not_qualified':'unknown','unknown',false,null);
  add('collapse',i.eventId,collapseQ,'unknown',false,{peak:collapsePeak,trough,drawdownPct:largest,recovery,horizonValue:maturity?i.checkpoints.find(e=>e.sizeUsd===100&&same(e.cursor,maturity)&&usableExit(e))?.netQuote??null:null,
    withoutObservedOperatorOrLaunchLinkedSelling:noSellingLiteral,checkpoints:primary.checkpoints.map(e=>e?{blockNumber:e.cursor.blockNumber,netQuote:e.netQuote,status:e.status,evidenceIds:e.evidenceIds}:null)});
  const adverse=facts.some(f=>f.qualification==='qualified'),unknown=facts.some(f=>f.qualification==='unknown');
  add('survived',i.eventId,adverse?'not_qualified':!unknown&&allEventChecks&&benchmarks.every(b=>b.complete)&&i.coverage.archive?'qualified':'unknown','unknown',false,{benchmarks:benchmarks.map(b=>({...b,checkpoints:b.checkpoints.map(e=>e?{blockNumber:e.cursor.blockNumber,status:e.status,netQuote:e.netQuote,evidenceIds:e.evidenceIds}:null)}))});
  const records=facts.map(f=>{
    const status:Status=immature||mature&&!confirmed?'provisional':!i.coverage.archive||['collapse','survived'].includes(f.kind)&&!benchmarks.every(b=>b.complete)?'censored':
      !mature||f.qualification==='unknown'||f.unresolved||(['collapse','survived'].includes(f.kind)?!allEventChecks:!i.coverage.events||!i.coverage.routes||(f.kind==='restriction'&&!i.coverage.controls))?'indeterminate':'confirmed_under_policy';
    const body={coin:i.coin,eventId:f.eventId,kind:f.kind,horizonSec:i.horizonSec,outcomeVersion:i.outcomeVersion,identityVersion:i.identityVersion,
      availabilityCut:i.availabilityCut,knownAt:watermark,qualification:f.qualification,status,attribution:f.attribution,
      entryCursor,maturityCursor:maturity,details:f.details,evidenceIds:f.evidenceIds,mode:'shadow' as const,origin:i.origin,
      historyEligible:i.origin==='measured'&&i.replayMode==='production'&&i.calibrated&&status==='confirmed_under_policy'&&f.qualification==='qualified'&&f.attribution==='operator'&&['dump','rug','restriction'].includes(f.kind)};
    return {id:referenceDigest(body),...body};
  }).sort((a,b)=>['restriction','rug','dump','harmful_disposition','collapse','survived'].indexOf(a.kind)-['restriction','rug','dump','harmful_disposition','collapse','survived'].indexOf(b.kind)||a.eventId.localeCompare(b.eventId));
  const body={schemaVersion:'outcome-revision-1' as const,streamId:outcomeStreamKey(i),inputDigest:referenceDigest(i),mode:'shadow' as const,origin:i.origin,
    availabilityCut:i.availabilityCut,knownAt:watermark,confirmationPolicy:{lagSec:30 as const,canonicalRechecked,protocolFinality:false as const},maturityCursor:maturity,
    records,dependencyIds:i.dependencyIds,requiredCheckpoints:scheduled,complete:confirmed&&allEventChecks&&i.coverage.archive&&benchmarks.every(b=>b.complete)&&!unknown};
  return {id:referenceDigest(body),...body};
}
export type OutcomeLabelRevision = ReturnType<typeof evaluateOutcomeLabels>;
export { OutcomeLabelInputSchema, type OutcomeLabelInput } from './outcome-input.js';
