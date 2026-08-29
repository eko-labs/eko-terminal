/** Candidate integer kernel. A reviewed route must pin rounding and charge order; no deployment defaults. */
export interface PonsChargeTerm {
  kind: 'ordinary' | 'creator' | 'temporary' | 'hook';
  base: 'gross' | 'remaining'; bps: bigint; fixedWei: bigint;
}
export interface PonsCurveState { tokens: bigint; realQuote: bigint; virtualQuote: bigint; reservedTokens: bigint }
export interface PonsCharges { ordinary: bigint; creator: bigint; temporary: bigint; hook: bigint; total: bigint }
export function ponsCharges(gross: bigint, terms: readonly PonsChargeTerm[]): PonsCharges {
  if (gross < 0n) throw new Error('Negative quote');
  const out: PonsCharges = {ordinary:0n,creator:0n,temporary:0n,hook:0n,total:0n};
  for (const t of terms) {
    if (t.bps < 0n || t.bps > 10000n || t.fixedWei < 0n) throw new Error('Invalid fee term');
    const n = (t.base === 'gross' ? gross : gross-out.total)*t.bps/10000n+t.fixedWei;
    if (out.total+n > gross) throw new Error('Quote below fixed charges');
    out[t.kind] += n; out.total += n;
  }
  return out;
}
function checked(s:PonsCurveState) {
  if(s.tokens<=0n || s.realQuote<0n || s.virtualQuote<=0n || s.reservedTokens<0n || s.reservedTokens>s.tokens)throw new Error('Invalid curve state');
}
export function ponsNoTaxSell(s:PonsCurveState,tokens:bigint) {
  checked(s); if(tokens<=0n)throw new Error('Invalid sell quantity');
  const quote=tokens*(s.realQuote+s.virtualQuote)/(s.tokens+tokens);
  return {quote,capacity:quote<=s.realQuote};
}
export function ponsBuy(s:PonsCurveState,requested:bigint,terms:readonly PonsChargeTerm[]) {
  checked(s);if(requested<=0n)throw new Error('Invalid buy size');
  const quote=s.realQuote+s.virtualQuote, available=s.tokens-s.reservedTokens;
  if(available===0n)return {spent:0n,refund:requested,tokens:0n,fees:{ordinary:0n,creator:0n,temporary:0n,hook:0n,total:0n},state:{...s}};
  // Output-floor kernel. Cap the final purchase and refund the remaining gross input.
  const required=s.reservedTokens===0n?null:(available*quote+s.reservedTokens-1n)/s.reservedTokens;
  const net=(gross:bigint)=>gross-ponsCharges(gross,terms).total;
  let spent=requested;
  if(required!==null && net(requested)>=required) {
    let lo=0n,hi=requested;
    while(lo<hi) {const mid=(lo+hi)/2n;let n:bigint;try{n=net(mid);}catch{n=-1n;}if(n>=required)hi=mid;else lo=mid+1n;}
    spent=lo;
  }
  const fees=ponsCharges(spent,terms),reserveIn=spent-fees.total;
  const raw=reserveIn*s.tokens/(quote+reserveIn),tokens=raw>available?available:raw;
  return {spent,refund:requested-spent,tokens,fees,state:{...s,tokens:s.tokens-tokens,realQuote:s.realQuote+reserveIn}};
}
export function ponsSell(s:PonsCurveState,tokens:bigint,terms:readonly PonsChargeTerm[]) {
  const {quote,capacity}=ponsNoTaxSell(s,tokens);
  if(!capacity) return {capacity:false as const,quoted:quote};
  const fees=ponsCharges(quote,terms);
  return {capacity:true as const,quoted:quote,returned:quote-fees.total,fees,state:{...s,tokens:s.tokens+tokens,realQuote:s.realQuote-quote}};
}
export function ponsLocalRoundTrip(s:PonsCurveState,size:bigint,buyTerms:readonly PonsChargeTerm[],sellTerms:readonly PonsChargeTerm[]) {
  const buy=ponsBuy(s,size,buyTerms),sell=ponsSell(buy.state,buy.tokens,sellTerms);
  return {buy,sell};
}
