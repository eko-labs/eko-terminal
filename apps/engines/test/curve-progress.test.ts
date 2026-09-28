import { describe,expect,it } from 'vitest';
import { decodeEventLog } from 'viem';
import { ponsCurveAbi,ponsFactoryAbi } from '@eko/chain';
import launch from '../../../packages/chain/test/fixtures/4663/pons-launch.json' with {type:'json'};
import captured from '../../../packages/chain/test/fixtures/4663/pons-curve-logs.json' with {type:'json'};
import { curveProgress,curveProgressAt,type PonsEventRow } from '../src/curve-progress.js';
const start:PonsEventRow={block:'1',kind:'launch',data:{graduationThreshold:'10000'}};
const trade=(block:string,side:number,quote:string,fee='0',tax='0'):PonsEventRow=>({block,kind:'trade',data:{side,amountEth:quote,feeEth:fee,taxEth:tax}});
describe('Pons net real quote progress',()=>{
  it('starts at zero, excludes anti-snipe and creator fees, restores sell fees, and caps only the bar',()=>{
    const points=curveProgress([start,trade('2',1,'10000','9900'),trade('3',1,'8000','400','100'),trade('4',-1,'900','80','20'),trade('5',1,'3400'),trade('6',1,'100')],1);
    expect(points.map(p=>p.pct)).toEqual([0,1,76,66,100,100]);
    expect(curveProgressAt(points,0)).toBeUndefined();expect(curveProgressAt(points,3)).toBe(76);
  });
  it('uses each launch threshold in raw quote units, including ERC-20 quotes and large integers',()=>{
    const threshold=10n**40n;
    expect(curveProgress([{...start,data:{graduationThreshold:String(threshold),pairToken:'sample-quote'}},trade('2',1,String(threshold*3n/4n))],1).at(-1)?.pct).toBe(75);
  });
  it('takes the last event in a block and handles a launch-and-buy receipt',()=>{
    const points=curveProgress([trade('1',1,'1000'),start,trade('1',1,'2000')],1);
    expect(curveProgressAt(points,1)).toBe(30);
  });
  it('leaves missing, zero or invalid inputs unavailable instead of clipping failed accounting',()=>{
    for(const data of [{},{graduationThreshold:'0'},{graduationThreshold:'bad'}])expect(curveProgress([{...start,data},trade('2',1,'100')],1).at(-1)?.pct).toBeUndefined();
    expect(curveProgress([start,{...trade('2',1,'100'),data:{side:1,amountEth:'100',feeEth:'1'}}],1).at(-1)?.pct).toBeUndefined();
    expect(curveProgress([start,trade('2',-1,'100'),trade('3',1,'1000')],1).at(-1)?.pct).toBeUndefined();
    expect(curveProgress([start,trade('2',1,'1','2')],1).at(-1)?.pct).toBeUndefined();
    expect(curveProgress([start],0).at(-1)?.pct).toBeUndefined();
  });
  it('reconstructs captured buys and sells and confirms the buy fee convention against launch inventory',()=>{
    const args=launch.launch.args,n=String(launch.launch.blockNumber),rows:PonsEventRow[]=[{block:n,kind:'launch',data:{graduationThreshold:args.graduationThreshold}}];
    let reserve=0n;
    for(const raw of captured.logs){
      let decoded;try{decoded=decodeEventLog({abi:ponsCurveAbi,topics:raw.topics as [`0x${string}`,...`0x${string}`[]],data:raw.data as `0x${string}`});}catch{continue;}
      if(decoded.eventName!=='CurveBuy' && decoded.eventName!=='CurveSell')continue;
      const a=decoded.args as unknown as Record<string,bigint>,buy=decoded.eventName==='CurveBuy';
      rows.push(trade(String(raw.blockNumber),buy?1:-1,String(buy?a.quoteIn:a.quoteOut),String(a.fee),String(a.tax)));
      reserve+=buy ? a.quoteIn-a.fee-a.tax : -(a.quoteOut+a.fee+a.tax);
    }
    const points=curveProgress(rows,Number(n));
    expect(points[0].pct).toBe(0);expect(points.at(-1)?.pct).toBe(Number(reserve*10000n/BigInt(args.graduationThreshold))/100);
    const first=launch.receipt.logs.find(l=>l.topics[0]===captured.logs.find(l=>{
      try{return decodeEventLog({abi:ponsCurveAbi,topics:l.topics as [`0x${string}`,...`0x${string}`[]],data:l.data as `0x${string}`}).eventName==='CurveBuy';}catch{return false;}
    })!.topics[0])!;
    const decoded=decodeEventLog({abi:ponsCurveAbi,topics:first.topics as [`0x${string}`,...`0x${string}`[]],data:first.data as `0x${string}`});
    const a=decoded.args as unknown as Record<string,bigint>,net=a.quoteIn-a.fee-a.tax;
    const inventory=BigInt(launch.receipt.logs.find(l=>l.address===args.token.toLowerCase() && l.topics[1]===`0x${'0'.repeat(64)}`)!.data);
    // Captured native launch terms: the inventory/price equation independently verifies gross quoteIn.
    expect(inventory*net/(1680000000000000000n+net)).toBe(a.tokensOut);
    expect(decodeEventLog({abi:ponsFactoryAbi,topics:launch.launch.topics as [`0x${string}`,...`0x${string}`[]],data:launch.launch.data as `0x${string}`}).eventName).toBe('TokenLaunched');
  });
});
