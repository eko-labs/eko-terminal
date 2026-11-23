import { rememberCoinIdentity } from '../../lib/coinIdentity';
import { RateNoticeView } from '../../components/RateNotice';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoinOverview, CoinVerdict } from './CoinCard';
import { formatCoinPrice } from '../../lib/format';
import { TradePanel } from '../../components/trade/TradePanel';
import { TimeframeControls } from '../../components/chart/TimeframeControls';
import { CoinSignalPanel } from './CoinSignal';
import { createRadarCard, createRadarRows } from '../../mocks/demo/radar';
import { CandlesSchema, mergeMarkers } from './useCoin';
import * as coinData from './useCoin';
import Coin, {RAW_TRADES_NOTE} from './Coin';
import { ChartStage } from '../../components/chart/ChartStage';
import { reconcileCandleTicks } from '../../components/chart/coinMath';
import { SUB_MINUTE_UNAVAILABLE } from '../../copy/availability';
import { coinMarkers } from '../../mocks/demo/coin';
import { CHAIN_KEY } from '../../lib/chain';
import { BUILD_NETWORK } from '../../lib/deployment';
const row=createRadarRows()[0],card=createRadarCard(row.address)!;
vi.mock('../../lib/useMedia',()=>({useMedia:()=>false}));
afterEach(()=>vi.restoreAllMocks());
describe('coin card and signal copy',()=>{
 it('retains the list identity while all coin reads are waiting and shows one quiet request notice',()=>{
   const cached = { ...row, address: `0x${'d'.repeat(40)}` as typeof row.address, name: { ...row.name, text: 'Demo coin' } };
   rememberCoinIdentity(cached);
   vi.spyOn(coinData,'useCoin').mockReturnValue({candlesUnavailable:false,candlesLoading:true,lastTradeTs:null,labelsUnavailable:true,card:null,verdict:null,bars:[],markers:[],flows:[],error:'',unknown:false,ageSec:0,retry:()=>{}});
   const html=renderToStaticMarkup(<><RateNoticeView seconds={24}/><Coin params={{address:cached.address}}/></>);
   expect(html).toContain('Demo coin'); expect(html).not.toContain('<h1>Coin</h1>');
   expect(html.match(/Too many requests from this browser/g)).toHaveLength(1);
   expect(html).toContain('Retrying in 24 s.'); expect(html).not.toContain('Retry Guard'); expect(html).not.toContain('Retry quote');
 });
 it('offers Scan for an unindexed coin and retains an existing card after a partial 404',()=>{
   const data={candlesUnavailable:false,candlesLoading:false,lastTradeTs:null,labelsUnavailable:true,card:null,verdict:null,bars:[],markers:[],flows:[],error:'Coin not found.',unknown:true,ageSec:0,retry:()=>{}};
   const hook=vi.spyOn(coinData,'useCoin').mockReturnValue(data);
   const missing=renderToStaticMarkup(<Coin params={{address:row.address}}/>);
   expect(missing).toContain('<h1>Not indexed yet</h1>');expect(missing).toContain('>Scan</button>');
   hook.mockReturnValue({...data,card,verdict:card.verdict});
   const retained=renderToStaticMarkup(<Coin params={{address:row.address}}/>);
   expect(retained).not.toContain('<h1>Not indexed yet</h1>');expect(retained).toContain('>Amount<');expect(retained).toContain('Coin not found.');
 });
 it.each(['1s','15s'] as const)('displays supported %s REST bars and live prices, with an explicit warning for partial history',tf=>{
   const response=CandlesSchema.parse({tf,bars:[{ts:120,o:.002,h:.004,l:.001,c:.003,vUsd:12}],asOfBlock:42,unavailable:[]});
   const bars=reconcileCandleTicks(response.bars,[{ts:135,price:.00789,volumeUsd:4,block:43}],135,tf);
   const data={candlesUnavailable:false,candlesLoading:false,lastTradeTs:135,labelsUnavailable:true,card,verdict:card.verdict,bars,markers:[],flows:[],error:'',unknown:false,ageSec:0,retry:()=>{}};
   const hook=vi.spyOn(coinData,'useCoin').mockReturnValue(data);
   const html=renderToStaticMarkup(<Coin params={{address:row.address}}/>);
   expect(html).toContain('>Watch</button>');expect(html).toContain('--trade-sheet-clearance:140px');expect(html).toContain('>Amount<');
   expect(html).toContain('$0.00789');expect(html).not.toContain(SUB_MINUTE_UNAVAILABLE);expect(html).not.toContain('No trades in this window');
   expect(renderToStaticMarkup(<ChartStage market="DEMO" timeframe={tf} onTimeframe={()=>{}} bars={bars} markers={[]} supply={1} verdict={null}/>)).toContain(`data-timeframe="${tf}"`);
   hook.mockReturnValue({...data,candlesUnavailable:true});
   expect(renderToStaticMarkup(<Coin params={{address:row.address}}/>)).toContain(SUB_MINUTE_UNAVAILABLE);
   hook.mockReturnValue({...data,bars:[],lastTradeTs:null});
   expect(renderToStaticMarkup(<Coin params={{address:row.address}}/>)).toContain('No trades in this window');
 });
 it('renders the five readings with fixed weights and a reproducible receipt, without agent copy',()=>{const html=renderToStaticMarkup(<CoinSignalPanel signal={card.signal!}/>);expect(html).toContain('Signal · five readings');expect(html).toContain('<th>Reading</th>');expect(html).toContain('How we got this');expect(html).not.toMatch(/agent/i);for(const reading of ['Momentum','Liquidity','Holders','Narrative','Risk'])expect(html).toContain(reading);expect(html).toContain('30%');expect(html).toContain('Beta');});
 it('has all card sections and only renders Swarm for verdict.beta',()=>{const render=(beta=undefined as typeof card.verdict.beta)=>renderToStaticMarkup(<CoinOverview card={card} verdict={{...card.verdict,beta}} flows={[card.flow]} evidenceOpen/>);const html=render();for(const word of ['Verdict','Round trip','Liquidity','Who holds it','Owner powers','Receipt','Identity','Trading flow'])expect(html).toContain(word);expect(html).not.toContain('Swarm');expect(render({apeScore:42})).toContain('Swarm');expect(html).toContain('86% confidence');expect(html).toContain('Evidence');});
 it('renders the verdict alone before the card and escapes evidence',()=>{const html=renderToStaticMarkup(<CoinVerdict verdict={{...card.verdict,reasons:['<script>alert(1)</script>']}}/>);expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('Verdict');});
 it('uses the shared coin price formatter in the guarded trade panel',()=>{
   const html=renderToStaticMarkup(<TradePanel coin={row.address} priceUsd={.0032176} priceFormat={formatCoinPrice}/>);
   expect(html).toContain('<dt>Price</dt><dd>$0.00322</dd>');
 });
 it('opens the coin elsewhere beside the copy button: DexScreener once graduated on Robinhood, otherwise the explorer',()=>{
   const data={candlesUnavailable:false,candlesLoading:false,lastTradeTs:null,labelsUnavailable:true,bars:[],markers:[],flows:[],error:'',unknown:false,ageSec:0,retry:()=>{}};
   const hook=vi.spyOn(coinData,'useCoin');
   const header=(stage:'graduated'|'curve')=>{hook.mockReturnValue({...data,card:{...card,identity:{...card.identity,stage}},verdict:card.verdict});return renderToStaticMarkup(<Coin params={{address:row.address}}/>).match(/<span class="coin-ca">.*?<\/a><\/span>/)?.[0]??'';};
   const graduated=header('graduated'),curve=header('curve');
   expect(graduated).toContain('aria-label="Copy address"');
   expect(curve).toContain(`href="${BUILD_NETWORK.explorerUrl}/token/${row.address}" target="_blank" rel="noopener noreferrer"`);
   expect(curve).toContain('>Explorer<');
   if(CHAIN_KEY==='robinhood'){
     expect(graduated).toContain(`href="https://dexscreener.com/robinhood/${row.address}" target="_blank" rel="noopener noreferrer"`);
     expect(graduated).toContain('>DexScreener<');
     expect(curve).toContain('href="https://robinhoodchain.blockscout.com/token/');
   } else {
     expect(graduated).toContain('>Explorer<');expect(graduated).not.toContain('dexscreener');
   }
 });
 it('keeps all eight contract intervals and the prototype 30m option in the toolbar',()=>{
   const html=renderToStaticMarkup(<TimeframeControls value="5m" onChange={()=>undefined}/>);
   for(const tf of ['1s','15s','1m','5m','15m','30m','1h','4h','1d'])expect(html).toContain(`>${tf}<`);
   expect(html).toContain('More timeframes');
 });
 it('deduplicates marker REST/WS snapshots without removing distinct trades',()=>{const ms=coinMarkers(row.address);expect(mergeMarkers(ms,ms)).toEqual(ms);expect(mergeMarkers(ms,[{...ms[0],sizeUsd:ms[0].sizeUsd+1}])).toHaveLength(ms.length+1);});
});

it('explains that individual trades end while chart and summary history remain',()=>{
  expect(RAW_TRADES_NOTE).toBe('Individual trades cover recent history. Older activity remains in the chart and coin summaries.');
});
