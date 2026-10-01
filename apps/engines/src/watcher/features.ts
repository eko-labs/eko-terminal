/** BACKEND §5.2: bounded, actor-level observations; null means unavailable. */
export interface FingerprintSwap {
  block:number; sec:number; txHash:string; logIndex:number; coin:string; buy:boolean; router:string|null;
  aa4337:boolean|null; shape:string|null; selector:string|null; ethNotional:string|null;
  gasLimit:string|null; gasUsed:string|null; orbio:boolean|null;
}
export interface WalletFeatures {
  swaps:number; aa4337Share:number|null; delegated7702:boolean|null; paymasterShare:number|null;
  routerTopShare:number|null; routerKnownAgent:boolean|null; calldataShapeShare:number|null;
  intervalCv:number|null; secOfMinuteEntropy:number|null; hourEntropy:number|null; reactionP10Blocks:number|null;
  sizeRepeatShare:number|null; gasLimitRepeatShare:number|null; orbioCredit:boolean|null; txEntropy:number|null;
  missing:string[];
}
export interface FeatureInput {
  swaps:readonly FingerprintSwap[]; block:number; sec:number; lookbackDays?:number;
  delegated7702:boolean|null; knownRouters:readonly string[]|null;
  userops:readonly {block:number;sec:number;hash:string;paymaster:boolean|null}[];
  useropsComplete:boolean;
  reactions:readonly {coin:string;firstBuyBlock:number;launchBlock:number;buyerRank:number}[];
}
const share=(values:readonly (string|null)[])=>values.length && values.every(v=>v!==null) ? modal(values as string[])/values.length : null;
function modal(values:readonly string[]) { const counts=new Map<string,number>();for(const v of values)counts.set(v,(counts.get(v)??0)+1);return Math.max(0,...counts.values()); }
export function entropy(values:readonly string[]):number|null {
  if(!values.length)return null;
  const counts=new Map<string,number>();for(const v of values)counts.set(v,(counts.get(v)??0)+1);
  return [...counts.values()].reduce((sum,n)=>sum-n/values.length*Math.log2(n/values.length),0);
}
/** Exact integer wei rounding to four significant digits; no floating-point token amounts. */
export function sizeBucket(wei:string):string {
  if(!/^[0-9]+$/.test(wei))throw new Error('Invalid ETH notional');
  const n=BigInt(wei),digits=n.toString().length;if(digits<=4)return n.toString();
  const scale=10n**BigInt(digits-4);return ((n+scale/2n)/scale*scale).toString();
}
export function walletFeatures(input:FeatureInput):WalletFeatures {
  const {block,sec}=input,days=input.lookbackDays ?? 1;
  if(!Number.isInteger(days)||days<1)throw new Error('Invalid fingerprint lookback');
  if(!Number.isSafeInteger(block)||block<0||!Number.isSafeInteger(sec)||sec<0)throw new Error('Invalid feature cut');
  const unique=new Map<string,FingerprintSwap>();
  for(const s of input.swaps)if(s.block<=block && s.sec<=sec && s.sec>=sec-days*86400) {
    const key=`${s.txHash}:${s.logIndex}`;
    if(unique.has(key)&&JSON.stringify(unique.get(key))!==JSON.stringify(s))throw new Error('Conflicting swap observation');
    unique.set(key,s);
  }
  const swaps=[...unique.values()].sort((a,b)=>b.block-a.block||b.txHash.localeCompare(a.txHash)||b.logIndex-a.logIndex).slice(0,200).reverse();
  const n=swaps.length;
  const aa4337Share=n&&swaps.every(s=>s.aa4337!==null)?swaps.filter(s=>s.aa4337).length/n:null;
  const ops=[...new Map(input.userops.filter(o=>o.block<=block&&o.sec<=sec&&o.sec>=sec-days*86400).map(o=>[o.hash,o])).values()];
  const paymasterShare=input.useropsComplete ? ops.length&&ops.every(o=>o.paymaster!==null)?ops.filter(o=>o.paymaster).length/ops.length:ops.length===0?0:null : null;
  const routers=swaps.map(s=>s.router?.toLowerCase()??null),routerTopShare=share(routers);
  // Equal modal routers are resolved lexically, independent of ingest order.
  const top=routers.every(r=>r!==null)?[...new Set(routers as string[])].sort((a,b)=>routers.filter(r=>r===b).length-routers.filter(r=>r===a).length||a.localeCompare(b))[0]:null;
  const routerKnownAgent=top&&input.knownRouters!==null?input.knownRouters.some(r=>r.toLowerCase()===top):null;
  const gaps=swaps.slice(1).map((s,i)=>s.block-swaps[i].block),mean=gaps.reduce((a,b)=>a+b,0)/gaps.length;
  const intervalCv=n>=20&&mean>0?Math.sqrt(gaps.reduce((sum,v)=>sum+(v-mean)**2,0)/gaps.length)/mean:null;
  const buys=swaps.filter(s=>s.buy),txs=[...new Map(swaps.map(s=>[s.txHash,s])).values()];
  const fixedLimit=share(txs.map(s=>s.gasLimit));
  const ratio=share(txs.map(s=>s.gasLimit!==null&&s.gasUsed!==null&&BigInt(s.gasUsed)>0n?`${BigInt(s.gasLimit)/gcd(BigInt(s.gasLimit),BigInt(s.gasUsed))}/${BigInt(s.gasUsed)/gcd(BigInt(s.gasLimit),BigInt(s.gasUsed))}`:null));
  const reactions=[...new Map(input.reactions.filter(r=>r.firstBuyBlock<=block&&r.launchBlock<=r.firstBuyBlock&&r.buyerRank<=50&&r.buyerRank>=1&&buys.some(s=>s.coin===r.coin&&s.block===r.firstBuyBlock)).map(r=>[r.coin,r.firstBuyBlock-r.launchBlock])).values()].sort((a,b)=>a-b);
  // TODO(spec): percentile estimator, deadline buckets and entropy sample floors are unspecified; use nearest-rank p10, minute buckets, and any observed sample (CV/reaction retain the specified floors).
  const f:WalletFeatures={swaps:n,aa4337Share,delegated7702:input.delegated7702,paymasterShare,routerTopShare,routerKnownAgent,
    calldataShapeShare:share(swaps.map(s=>s.shape)),intervalCv,secOfMinuteEntropy:entropy(swaps.map(s=>String(s.sec%60))),
    hourEntropy:entropy(swaps.filter(s=>s.sec>=sec-7*86400).map(s=>String(Math.floor(s.sec/3600)%24))),
    reactionP10Blocks:reactions.length>=5?reactions[Math.ceil(reactions.length*0.1)-1]:null,
    sizeRepeatShare:share(buys.map(s=>s.ethNotional===null?null:sizeBucket(s.ethNotional))),
    gasLimitRepeatShare:fixedLimit===null?null:Math.max(fixedLimit,ratio??0),
    orbioCredit:buys.some(s=>s.orbio===true)?true:buys.length&&buys.every(s=>s.orbio!==null)?false:null,
    txEntropy:txs.length&&txs.every(s=>s.selector!==null&&s.router!==null)?entropy(txs.map(s=>`${s.selector}:${s.router!.toLowerCase()}`)):null,missing:[]};
  f.missing=Object.entries(f).filter(([key,value])=>key!=='missing'&&value===null).map(([key])=>key);
  return f;
}
function gcd(a:bigint,b:bigint):bigint {while(b){const next=a%b;a=b;b=next;}return a;}
