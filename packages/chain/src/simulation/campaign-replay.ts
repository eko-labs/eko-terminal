import { compareGuardCursors, guardKnownBy, type GuardCursor, type Rational } from '@eko/shared';
import { referenceDigest } from './reference.js';
import { ponsBuy, ponsSell, ponsCharges, type PonsCurveState } from './pons-math.js';
import { campaignPressure, type PressureLeg } from './campaign-pressure.js';
import { CampaignReplayInputSchema, type CampaignReplayInput, type CampaignState, type CampaignLeg, type CampaignTransaction } from './campaign-input.js';
const rawCurve = (s: NonNullable<CampaignState['curve']>): PonsCurveState => Object.fromEntries(Object.entries(s).map(([k,v]) => [k, BigInt(v)])) as unknown as PonsCurveState;
const wireCurve = (s: PonsCurveState) => Object.fromEntries(Object.entries(s).map(([k,v]) => [k, v.toString()])) as NonNullable<CampaignState['curve']>;
const terms = (ts: CampaignState['fees']['buy']) => ts.map(t => ({ ...t, bps: BigInt(t.bps), fixedWei: BigInt(t.fixedWei) }));
const clone = <T>(x: T): T => structuredClone(x);
type F = { n: bigint; d: bigint };
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; while (b) [a,b] = [b,a%b]; return a; };
const f = (n: bigint, d = 1n): F => { const g = gcd(n,d); return { n:n/g, d:d/g }; };
const plus = (a:F,b:F) => f(a.n*b.d+b.n*a.d,a.d*b.d);
const scale = (a:F,n:bigint,d=1n) => f(a.n*n,a.d*d);
const wire = (a:F):Rational => ({numerator:a.n.toString(),denominator:a.d.toString()});
const read = (a:Rational):F => f(BigInt(a.numerator),BigInt(a.denominator));
const cmp = (a:F,b:F) => a.n*b.d < b.n*a.d ? -1 : a.n*b.d > b.n*a.d ? 1 : 0;
const returnPp = (value:F,cost:F) => f((value.n*cost.d-cost.n*value.d)*100n,value.d*cost.n);
export function campaignStateHash(state: CampaignState) { return referenceDigest(state); }
function wallet(s:CampaignState, account:string) {
  let w = s.wallets.find(w => w.account===account);
  if (!w) { w={account:account as `0x${string}`,quote:'0',token:'0',allowance:'0'}; s.wallets.push(w); }
  return w;
}
function move(s:CampaignState, account:string, field:'quote'|'token', delta:bigint) {
  const w=wallet(s,account), value=BigInt(w[field])+delta;
  if(value<0n)throw new Error(`negative_${field}_balance`); w[field]=value.toString();
}
function feesFor(s:CampaignState, account:string, kind:'buy'|'sell') { return s.fees.overrides.find(x=>x.account===account)?.[kind]??s.fees[kind]; }
function payout(s:CampaignState, gross:bigint, ts:CampaignState['fees']['buy']) {
  let remaining=gross;
  for(const t of ts) { const amount=ponsCharges(t.base==='gross'?gross:remaining,[{...t,base:'gross',bps:BigInt(t.bps),fixedWei:BigInt(t.fixedWei)}]).total;
    move(s,t.recipient,'quote',amount); remaining-=amount; }
}
interface Tracked { id:string; cohort:'before'|'during'; owner:string; units:bigint; acquired:bigint; cost:F|null; realized:F; }
interface Track { lots:Tracked[]; side:Set<string> }
function consume(s:CampaignState, owner:string, amount:bigint, recipient:string|null, net:bigint|null, track?:Track) {
  let remaining=amount;
  // Checkpoint order is the ledger's FIFO order; newly acquired lots append chronologically.
  for(const lot of [...s.lots].filter(l=>l.owner===owner)) {
    if(!remaining)break;
    const original=BigInt(lot.units), take=original<remaining?original:remaining;
    const tracked=track?.lots.find(l=>l.id===lot.id && l.owner===owner);
    if(tracked) {
      if(net!==null)tracked.realized=plus(tracked.realized,f(net*take,amount));
      else if(!recipient)tracked.cost=null;
      tracked.units-=take;
      // Independent gifts preserve origin in state but do not assign recipient acquisition cash cost.
      if(recipient) track!.lots.push({id:referenceDigest([lot.id,recipient,s.lots.length]),cohort:tracked.cohort,owner:recipient,
        units:take,acquired:take,cost:null,realized:f(0n)});
    }
    const transferred={...lot,id:referenceDigest([lot.id,recipient,s.lots.length]),owner:recipient as `0x${string}`,units:take.toString(),cost:null,payer:null};
    lot.units=(original-take).toString();
    if(lot.cost)lot.cost=wire(scale(read(lot.cost),original-take,original));
    if(recipient)s.lots.push(transferred);
    remaining-=take;
  }
  s.lots=s.lots.filter(l=>l.units!=='0');
  if(remaining)throw new Error('lot_conservation');
}
interface Execution { leg:CampaignLeg; before:CampaignState; after:CampaignState; spent:bigint; net:bigint; gross:bigint; output:bigint }
function execute(state:CampaignState, tx:CampaignTransaction, removed:Set<string>, timestampSec:bigint, track?:Track): {state:CampaignState;executions:Execution[]} {
  const s=clone(state), executions:Execution[]=[];
  const legs=tx.legs.filter(l=>!removed.has(l.id)&&!((l.kind==='transfer'||l.kind==='quote_transfer')&&l.economicId&&removed.has(l.economicId)));
  if(!legs.length)return {state:s,executions};
  move(s,tx.gasPayer,'quote',-BigInt(tx.gasQuote)); move(s,tx.gasRecipient,'quote',BigInt(tx.gasQuote));
  const swaps=legs.filter(l=>l.kind==='buy'||l.kind==='sell');
  if(swaps.length>1 && track && BigInt(tx.gasQuote)>0n)throw new Error('unallocated_acquisition_gas');
  for(const leg of legs) {
    const before=clone(s); let spent=0n,net=0n,gross=0n,output=0n;
    switch(leg.kind) {
      case 'unsupported': throw new Error(`unsupported_${leg.reason}`);
      case 'launch': if(s.curve)throw new Error('duplicate_launch'); s.curve=clone(leg.curve);s.fees=clone(leg.fees);break;
      case 'fees': s.fees=clone(leg.fees);break;
      case 'approve': wallet(s,leg.account).allowance=leg.units;break;
      case 'quote_transfer': move(s,leg.from,'quote',-BigInt(leg.units));move(s,leg.to,'quote',BigInt(leg.units));break;
      case 'transfer': move(s,leg.from,'token',-BigInt(leg.units));move(s,leg.to,'token',BigInt(leg.units));consume(s,leg.from,BigInt(leg.units),leg.to,null,track);break;
      case 'buy': case 'sell': {
        if(!s.curve || leg.executable!=='supported')throw new Error('unsupported_route_or_checks');
        if(BigInt(leg.deadlineSec)<timestampSec)throw new Error('deadline');
        const amount=BigInt(leg.input), ts=feesFor(s,leg.account,leg.kind);
        if(leg.kind==='buy') {
          // Original submitted value, including refundable input, must be funded.
          if(BigInt(wallet(s,leg.account).quote)<amount)throw new Error('funding');
          const b=ponsBuy(rawCurve(s.curve),amount,terms(ts));
          if(b.tokens===0n || b.tokens<BigInt(leg.minimumOutput))throw new Error('minimum_output');
          spent=b.spent;output=b.tokens;s.curve=wireCurve(b.state);
          move(s,leg.account,'quote',-spent);move(s,leg.recipient,'token',output);payout(s,spent,ts);
          const cost=leg.account===leg.recipient?f(spent+(tx.gasPayer===leg.account?BigInt(tx.gasQuote):0n)):null;
          s.lots.push({id:leg.id,owner:leg.recipient,origin:leg.account,units:output.toString(),cost:cost?wire(cost):null,payer:leg.account});
          if(track&&!track.side.has(leg.recipient))track.lots.push({id:leg.id,cohort:'during',owner:leg.recipient,units:output,acquired:output,cost,realized:f(0n)});
        } else {
          const w=wallet(s,leg.account);
          if(BigInt(w.allowance)<amount)throw new Error('allowance');
          const q=ponsSell(rawCurve(s.curve),amount,terms(ts));
          if(!q.capacity)throw new Error('capacity');
          if(q.returned<BigInt(leg.minimumOutput))throw new Error('minimum_output');
          gross=q.quoted;net=q.returned;output=net;s.curve=wireCurve(q.state);
          move(s,leg.account,'token',-amount);move(s,leg.recipient,'quote',net);payout(s,gross,ts);
          w.allowance=(BigInt(w.allowance)-amount).toString();
          consume(s,leg.account,amount,null,leg.account===leg.recipient?net-(tx.gasPayer===leg.account?BigInt(tx.gasQuote):0n):null,track);
        }
        break;
      }
    }
    executions.push({leg,before,after:clone(s),spent,net,gross,output});
  }
  reconcile(s);
  if(!legs.some(l=>l.kind==='launch')&&(totals(state).quote!==totals(s).quote||totals(state).token!==totals(s).token))throw new Error('reserve_balance_conservation');
  return {state:s,executions};
}
function totals(s:CampaignState) { return {quote:s.wallets.reduce((n,w)=>n+BigInt(w.quote),0n)+BigInt(s.curve?.realQuote??'0'),token:s.wallets.reduce((n,w)=>n+BigInt(w.token),0n)+BigInt(s.curve?.tokens??'0')}; }
/** Local normalized transaction executor; observations must supply independently acquired post-state pins. */
export function applyPonsCampaignTransaction(state:CampaignState,tx:CampaignTransaction,timestampSec:string) {
  return execute(state,tx,new Set(),BigInt(timestampSec)).state;
}
function reconcile(s:CampaignState) {
  if(new Set(s.wallets.map(w=>w.account)).size!==s.wallets.length||new Set(s.lots.map(l=>l.id)).size!==s.lots.length)throw new Error('duplicate_state_identity');
  for(const w of s.wallets)if(s.lots.filter(l=>l.owner===w.account).reduce((n,l)=>n+BigInt(l.units),0n)!==BigInt(w.token))throw new Error('lot_conservation');
  if(s.lots.some(l=>!s.wallets.some(w=>w.account===l.owner))||s.lots.some(l=>l.cost && BigInt(l.cost.numerator)<0n))throw new Error('invalid_lot');
  if(s.curve&&BigInt(s.curve.reservedTokens)>BigInt(s.curve.tokens))throw new Error('invalid_curve');
}
function trackOpening(s:CampaignState, side:Set<string>):Track {
  return {side,lots:s.lots.filter(l=>!side.has(l.owner)).map(l=>({id:l.id,cohort:'before',owner:l.owner,units:BigInt(l.units),acquired:BigInt(l.units),
    cost:l.cost&&l.payer===l.owner?read(l.cost):null,realized:f(0n)}))};
}
function valueCohorts(s:CampaignState,t:Track,i:CampaignReplayInput) {
  s=clone(s); // Each wallet liquidation reads the same observed state.
  const values=new Map<string,F|null>();
  for(const owner of new Set(t.lots.map(l=>l.owner))) {
    const quantity=BigInt(wallet(s,owner).token);
    if(!quantity){values.set(owner,f(0n));continue;}
    try {
      if(!s.curve||i.campaign.closeLiquidationGasQuote===null||!i.campaign.liquidationAccounts.includes(owner as `0x${string}`))throw new Error('liquidation_unknown');
      const q=ponsSell(rawCurve(s.curve),quantity,terms(feesFor(s,owner,'sell')));
      if(!q.capacity)throw new Error('capacity');
      values.set(owner,f(q.returned-BigInt(i.campaign.closeLiquidationGasQuote)));
    }catch{values.set(owner,null);}
  }
  return (['before','during'] as const).map(cohort=>{
    const lots=t.lots.filter(l=>l.cohort===cohort), wallets=[];
    let total=f(0n),value=f(0n),knownCost=f(0n),valuedUnits=0n,allUnits=0n,hurtCost=f(0n),hurtCount=0;
    for(const owner of new Set(lots.map(l=>l.owner))) {
      const own=lots.filter(l=>l.owner===owner), units=own.reduce((n,l)=>n+l.acquired,0n); allUnits+=units;
      const cost=own.reduce((n,l)=>plus(n,l.cost??f(0n)),f(0n)); knownCost=plus(knownCost,cost);
      const exit=values.get(owner)??null;
      if(own.some(l=>l.cost===null)||cost.n<=0n||exit===null){wallets.push({owner,cost:wire(cost),returnPp:null,status:'unknown' as const});continue;}
      const held=BigInt(wallet(s,owner).token), remaining=own.reduce((n,l)=>n+l.units,0n);
      const proceeds=plus(own.reduce((n,l)=>plus(n,l.realized),f(0n)),held?scale(exit,remaining,held):f(0n));
      const ret=returnPp(proceeds,cost); total=plus(total,cost);value=plus(value,proceeds);valuedUnits+=units;
      if(cmp(ret,f(-30n))<=0){hurtCount++;hurtCost=plus(hurtCost,cost);}
      wallets.push({owner,cost:wire(cost),returnPp:wire(ret),status:'valued' as const});
    }
    const returns=wallets.filter(w=>w.returnPp!==null).map(w=>read(w.returnPp!)).sort(cmp);
    const quantile=(n:number,d:number)=>returns.length?wire(returns[Math.max(0,Math.ceil(returns.length*n/d)-1)]):null;
    const denominator=i.campaign.totalCost[cohort],costCoverage=denominator&&BigInt(denominator.numerator)>0n?scale(total,BigInt(denominator.denominator)*100n,BigInt(denominator.numerator)):null;
    const positionCoverage=allUnits?f(valuedUnits*100n,allUnits):null;
    const sufficient=i.campaign.coverageComplete&&costCoverage!==null&&positionCoverage!==null&&cmp(costCoverage,f(90n))>=0&&cmp(positionCoverage,f(90n))>=0&&cmp(costCoverage,f(100n))<=0;
    return {cohort,wallets,cost:wire(total),knownBasisCost:wire(knownCost),value:wire(value),costWeightedReturnPp:total.n>0n?wire(returnPp(value,total)):null,
      medianPp:returns.length?wire(returns.length%2?returns[(returns.length-1)/2]:scale(plus(returns[returns.length/2-1],returns[returns.length/2]),1n,2n)):null,quantilesPp:{p10:quantile(1,10),p90:quantile(9,10)},hurtCount,hurtCost:wire(hurtCost),
      costCoveragePct:costCoverage?wire(costCoverage):null,positionCoveragePct:positionCoverage?wire(positionCoverage):null,sufficient};
  });
}

/** Explicit queued/offline computation. Does not evaluate Guard, run RPC, or publish labels. */
export function replayPonsCampaign(raw:CampaignReplayInput) {
  const i=CampaignReplayInputSchema.parse(raw), c=i.campaign;
  if(i.coin===i.quoteAsset||new Set(c.sellingSide).size!==c.sellingSide.length||c.quoteUsd&&BigInt(c.quoteUsd.numerator)<=0n)throw new Error('campaign_asset_or_side');
  if(i.checkpoint.cursor.boundary!=='block_end'||campaignStateHash(i.checkpoint.state)!==i.checkpoint.stateHash)throw new Error('checkpoint_pin');
  reconcile(i.checkpoint.state);
  let previous=i.checkpoint.cursor;
  const transactions:{tx:CampaignTransaction;cursor:GuardCursor}[]=[];
  for(const block of i.blocks) {
    if(block.cursor.boundary!=='block_end'||block.cursor.chainId!==previous.chainId||BigInt(block.cursor.blockNumber)!==BigInt(previous.blockNumber)+1n||block.parentHash!==previous.blockHash||BigInt(block.cursor.timestampSec)<BigInt(previous.timestampSec))throw new Error('prefix_chain');
    block.transactions.forEach((tx,index)=>{if(tx.index!==index)throw new Error('transaction_prefix');transactions.push({tx,cursor:{...block.cursor,boundary:'after_tx',transactionIndex:index,executionOrdinal:0}});}); previous=block.cursor;
  }
  const allLegs=transactions.flatMap(x=>x.tx.legs),ids=allLegs.map(l=>l.id);
  if(new Set(ids).size!==ids.length||new Set(transactions.map(x=>x.tx.id)).size!==transactions.length||new Set(c.saleIds).size!==c.saleIds.length)throw new Error('duplicate_transaction_or_leg');
  if(c.from.boundary!=='before_tx'||compareGuardCursors(c.from,c.through)>0||compareGuardCursors(i.checkpoint.cursor,c.from)>=0||!guardKnownBy({cursor:c.through,acquisitionSequence:'0'},i.knownAt))throw new Error('campaign_boundary');
  const start=transactions.findIndex(x=>x.cursor.blockHash===c.from.blockHash&&x.tx.index===c.from.transactionIndex);
  const throughBlock=i.blocks.find(b=>b.cursor.blockHash===c.through.blockHash);
  const end=c.through.boundary==='block_end'&&throughBlock?transactions.findLastIndex(x=>BigInt(x.cursor.blockNumber)<=BigInt(c.through.blockNumber)):
    transactions.findIndex(x=>x.cursor.blockHash===c.through.blockHash&&x.tx.index===c.through.transactionIndex);
  if(start>=0&&referenceDigest(c.from)!==referenceDigest({...transactions[start].cursor,boundary:'before_tx'}))throw new Error('campaign_boundary_pin');
  if(end>=0&&referenceDigest(c.through)!==referenceDigest(c.through.boundary==='block_end'?throughBlock!.cursor:transactions[end].cursor))throw new Error('campaign_boundary_pin');
  if(start<0||end<start||c.through.boundary==='before_tx'||c.from.executionOrdinal!==0||c.through.boundary==='after_tx'&&c.through.executionOrdinal!==0)throw new Error('unsupported_boundary');
  const side=new Set(c.sellingSide),selected=new Set(c.saleIds);
  if(transactions.slice(start,end+1).flatMap(x=>x.tx.legs).some(l=>l.kind==='sell'&&side.has(l.account)&&!selected.has(l.id)))throw new Error('incomplete_side_sales');
  const economic=new Set(allLegs.filter(l=>l.kind==='buy'||l.kind==='sell').map(l=>l.id));
  if(transactions.some(x=>x.tx.legs.some(l=>l.economicId&&(!economic.has(l.economicId)||!x.tx.legs.some(s=>s.id===l.economicId&&(s.kind==='buy'||s.kind==='sell'))))))throw new Error('unbound_inherent_transfer');
  if(c.saleIds.some(id=>!transactions.slice(start,end+1).some(x=>x.tx.legs.some(l=>l.id===id&&l.kind==='sell'&&side.has(l.account)))))throw new Error('unidentified_sale');
  let state=clone(i.checkpoint.state),opening:CampaignState|null=null,track:Track|undefined;
  const boundaries:{before:GuardCursor;after:GuardCursor;preStateHash:string;postStateHash:string}[]=[],pressure:PressureLeg[]=[],sales:{id:string;cursor:GuardCursor;units:string;gross:string;net:string}[]=[];
  let failure:string|null=c.routeReviewed?null:'unreviewed_route',failedTransaction:string|null=null,buyDebit=0n,netReceipt=0n,grossReceipt=0n,sold=0n;
  for(let k=0;k<=end&&!failure;k++) {
    const {tx,cursor}=transactions[k];
    if(k===start){opening=clone(state);track=trackOpening(state,side);}
    try {
      const result=execute(state,tx,new Set(),BigInt(cursor.timestampSec),track);
      if(campaignStateHash(result.state)!==tx.expectedStateHash)throw new Error('replay_fidelity');
      boundaries.push({before:{...cursor,boundary:'before_tx'},after:cursor,preStateHash:campaignStateHash(state),postStateHash:campaignStateHash(result.state)});
      state=result.state;
      if(k>=start)for(const x of result.executions) {
        if(x.leg.kind==='buy'&&side.has(x.leg.account))buyDebit+=x.spent;
        if(x.leg.kind==='sell'&&side.has(x.leg.account))netReceipt+=side.has(x.leg.recipient)?x.net:0n;
        if(!selected.has(x.leg.id)||x.leg.kind!=='sell')continue;
        sold+=BigInt(x.leg.input);grossReceipt+=x.gross;
        sales.push({id:x.leg.id,cursor,units:x.leg.input,gross:x.gross.toString(),net:x.net.toString()});
        if(x.leg.pressureFraction&&x.before.curve&&x.after.curve)pressure.push({before:{n:BigInt(x.before.curve.realQuote)+BigInt(x.before.curve.virtualQuote),d:BigInt(x.before.curve.tokens)},
          after:{n:BigInt(x.after.curve.realQuote)+BigInt(x.after.curve.virtualQuote),d:BigInt(x.after.curve.tokens)},fraction:read(x.leg.pressureFraction)});
      }
    }catch(e){failure=e instanceof Error?e.message:'replay_failed';failedTransaction=tx.id;break;}
  }
  const actual=failure||!track?null:valueCohorts(state,track,i),cash=netReceipt-buyDebit;
  const pressureComplete=sales.length===selected.size&&transactions.slice(start,end+1).flatMap(x=>x.tx.legs).filter(l=>selected.has(l.id)).every(l=>l.kind==='sell'&&l.pressureFraction!==null);
  const interventions=(['sell_only','net_trading'] as const).map(kind=>{
    let s=opening?clone(opening):null,t=s?trackOpening(s,side):null,error=failure,failed:string|null=failedTransaction;
    const remove=new Set(selected);
    if(kind==='net_trading')transactions.slice(start,end+1).flatMap(x=>x.tx.legs).filter(l=>(l.kind==='buy'||l.kind==='sell')&&side.has(l.account)).forEach(l=>remove.add(l.id));
    if(s&&t&&!error)for(const {tx,cursor} of transactions.slice(start,end+1)) {
      try {s=execute(s,tx,remove,BigInt(cursor.timestampSec),t).state;}catch(e){error=e instanceof Error?e.message:'intervention_failed';failed=tx.id;break;}
    }
    const cohorts=s&&t&&!error?valueCohorts(s,t,i):null;
    if(cohorts?.some(x=>x.wallets.some(w=>w.status==='unknown')))error='unpriced_basis_or_position';
    return {kind,status:error||!s?'indeterminate' as const:'valid' as const,failure:error,failedTransaction:failed,removedLegIds:[...remove].sort(),
      closeStateHash:s&&!error?campaignStateHash(s):null,cohorts:error?null:cohorts,
      contributionPp:cohorts&&!error&&actual?cohorts.map((v,k)=>({cohort:v.cohort,value:v.costWeightedReturnPp&&actual[k].costWeightedReturnPp?
        wire(plus(read(v.costWeightedReturnPp),scale(read(actual[k].costWeightedReturnPp!),-1n))):null})):null};
  });
  const materialBranches={float:c.openingFloat? sold*100n>=BigInt(c.openingFloat):null,
    netUsd:c.quoteUsd?cash>0n&&cash*BigInt(c.quoteUsd.numerator)>=500n*10n**BigInt(i.quoteDecimals)*BigInt(c.quoteUsd.denominator):null,
    reserve:opening?.curve&&BigInt(opening.curve.realQuote)>0n?grossReceipt*10n>=BigInt(opening.curve.realQuote):null};
  const material=Object.values(materialBranches).some(x=>x===true),sellOnly=interventions[0];
  const harmfulCandidate=material&&cash>0n&&sellOnly.status==='valid'&&actual?.some((v,k)=>v.sufficient&&v.costWeightedReturnPp&&cmp(read(v.costWeightedReturnPp),f(-30n))<=0&&sellOnly.cohorts?.[k].sufficient&&sellOnly.contributionPp?.[k].value&&cmp(read(sellOnly.contributionPp[k].value!),f(10n))>=0)===true;
  const episodes: {saleIds:string[];from:GuardCursor;through:GuardCursor;status:'open'|'closed';pressure:ReturnType<typeof campaignPressure>|null}[]=[];
  for(const sale of sales) {
    const e=episodes.at(-1),tail=e?.through;
    if(!e||!tail||BigInt(sale.cursor.timestampSec)-BigInt(tail.timestampSec)>60n||BigInt(sale.cursor.timestampSec)-BigInt(e.from.timestampSec)>=300n)episodes.push({saleIds:[sale.id],from:sale.cursor,through:sale.cursor,status:'open',pressure:null});
    else {e.saleIds.push(sale.id);e.through=sale.cursor;}
  }
  for(const e of episodes) {
    e.status=BigInt(c.through.timestampSec)-BigInt(e.through.timestampSec)<=60n&&BigInt(c.through.timestampSec)-BigInt(e.from.timestampSec)<300n?'open':'closed';
    if(pressureComplete)e.pressure=campaignPressure(e.saleIds.map(id=>pressure[sales.findIndex(s=>s.id===id)]));
  }
  // A campaign remains provisional while its latest bounded episode is open.
  const status=episodes.at(-1)?.status??'closed';
  const body={methodVersion:i.methodVersion,mode:'shadow' as const,origin:i.origin,inputDigest:referenceDigest(i),coin:i.coin,from:c.from,through:c.through,knownAt:i.knownAt,
    status,validation:'local_replay' as const,failure,failedTransaction,boundaries,openingState:opening,closeState:failure?null:state,sales,
    pressure:pressureComplete?campaignPressure(pressure):null,pressureStatus:pressureComplete?'bounded':'unknown',
    rawComplete:!failure,raw:{sold:sold.toString(),gross:grossReceipt.toString(),netTradingCashOut:cash.toString(),openingRealReserve:opening?.curve?.realQuote??null},
    windows:([300,3600,86400] as const).map(windowSec=>{const cut=BigInt(c.through.timestampSec)-BigInt(windowSec),ss=sales.filter(s=>BigInt(s.cursor.timestampSec)>cut);return {windowSec,coverageComplete:!failure&&c.coverageComplete&&(BigInt(c.from.timestampSec)<=cut||transactions.slice(0,start).some(x=>x.tx.legs.some(l=>l.kind==='launch')&&BigInt(x.cursor.timestampSec)>=cut)),pressure:pressureComplete?campaignPressure(ss.map(s=>pressure[sales.indexOf(s)])):null,saleIds:ss.map(s=>s.id),sold:ss.reduce((n,s)=>n+BigInt(s.units),0n).toString(),gross:ss.reduce((n,s)=>n+BigInt(s.gross),0n).toString()};}),
    episodes,actual,interventions,materialBranches,harmfulCandidate,provisional:status==='open',
    // Independent labels/history are owned by later packets; no fixture or unaccepted replay is released truth.
    attributionAvailable:i.origin==='measured'&&!failure&&c.coverageComplete&&c.routeReviewed&&c.fidelityAccepted&&sellOnly.status==='valid',evidenceIds:c.evidenceIds,profileHash:c.profileHash};
  return {id:referenceDigest(body),...body};
}
export type CampaignReplayResult=ReturnType<typeof replayPonsCampaign>;
