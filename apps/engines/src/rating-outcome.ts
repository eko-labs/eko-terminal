import type { CoinCard } from '@eko/shared';
import { digest } from './card.js';

/** Every structural component is named independently so overlapping changes remain visible in telemetry. */
export function ratingComponents(card:CoinCard,rulesVersion:string) {
  const {curvePct:_,pools,...identity}=card.identity;
  const sections=Object.entries(card.meta ?? {}).sort(([a],[b])=>a.localeCompare(b));
  const fields=<T,>(pick:(m:NonNullable<NonNullable<CoinCard['meta']>['identity']>)=>T)=>Object.fromEntries(sections.map(([key,m])=>[key,pick(m)]));
  return {
    level:card.verdict.level,
    playbooks:card.verdict.playbooks.map(m=>({id:m.id,level:m.level})).sort((a,b)=>a.id.localeCompare(b.id)),
    evaluatedSet:[...new Set(card.verdict.evaluatedPlaybooks ?? [])].sort(),
    rulesVersion:{rulesVersion,schemaVersion:card.verdict.schemaVersion},
    identity:{...identity,pools:pools.map(({liquidityUsd:_,...pool})=>pool).sort((a,b)=>a.id.localeCompare(b.id))},
    ownerPowers:card.control,clone:card.clone ?? null,honeypot:card.tradeability.honeypot,
    lpStatus:card.liquidity.lpStatus,antiSnipe:!!card.tradeability.antiSnipe,setupGrade:card.verdict.beta?.setupGrade ?? null,
    sectionAvailability:fields(m=>m.unavailable ?? false),
    missingFields:fields(m=>[...(m.missing ?? [])].sort()),flags:fields(m=>[...(m.flags ?? [])].sort()),
    coverage:fields(m=>Object.fromEntries(Object.entries(m.coverageGaps ?? {}).sort(([a],[b])=>a.localeCompare(b)).map(([key,g])=>
      [key,{status:g.status,reason:g.reason,window:g.window,threshold:g.threshold}])))
  };
}
/**
 * Missing measurement fields and attribution coverage are mutable latest measurements. Availability and evaluated
 * checks still distinguish unknown from measured decisions. All categorical buyer-facing changes remain immutable
 * outcomes. Verdict receipts retain the original input, including original measurement and coverage details.
 */
export function ratingOutcome(card: CoinCard, rulesVersion: string) {
  const {missingFields:_,coverage:_coverage,...outcome}=ratingComponents(card,rulesVersion);
  outcome.flags=Object.fromEntries(Object.entries(outcome.flags).map(([section,flags])=>[section,flags.filter(flag=>flag!=='attribution_incomplete')]));
  return digest(outcome);
}
export type RatingComponent=keyof ReturnType<typeof ratingComponents>;
export class OutcomeDifferences {
  private comparisons=0;
  private counts:Partial<Record<RatingComponent,number>>={};
  constructor(private emit:(value:unknown)=>void=value=>console.log(JSON.stringify(value))) {}
  record(before:CoinCard,beforeRules:string,after:CoinCard,afterRules:string) {
    this.comparisons++;
    const a=ratingComponents(before,beforeRules),b=ratingComponents(after,afterRules);
    for(const key of Object.keys(a) as RatingComponent[])if(digest(a[key])!==digest(b[key]))this.counts[key]=(this.counts[key] ?? 0)+1;
  }
  /** Called once a minute by the worker, including minutes without completed evaluations. */
  flush() {
    const components=Object.fromEntries((['level','playbooks','evaluatedSet','rulesVersion','identity','ownerPowers','clone','honeypot',
      'lpStatus','antiSnipe','setupGrade','sectionAvailability','missingFields','flags','coverage'] as RatingComponent[]).map(key=>[key,this.counts[key] ?? 0]));
    this.emit({event:'rating_outcome_differences',comparisons:this.comparisons,components});
    this.comparisons=0;this.counts={};
  }
}
