import { expect,type Page } from '@playwright/test';
import { test } from './helpers';
import fixtures from '../src/mocks/contracts.json' with { type: 'json' };
const identity='0x'+(801).toString(16).padStart(40,'0');
async function noOverflow(page:Page) {
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 for(const selector of ['.rt-wrap','.rt','.prow','.coin-head']) {
  for(const el of await page.locator(selector).all())if(await el.isVisible())expect(await el.evaluate(e=>e.scrollWidth<=e.clientWidth+1),selector).toBe(true);
  if(selector==='.prow')for(const el of await page.locator(selector).all())if(await el.isVisible())expect(await el.evaluate(e=>e.scrollHeight<=e.clientHeight+1),'Guard labels remain unclipped').toBe(true);
 }
}
async function symbolFits(page:Page,selector:string) {
 const symbol=page.locator(selector).first();await expect(symbol).toHaveAttribute('title',/^\$/);
 expect(await symbol.evaluate(e=>{const s=getComputedStyle(e);return s.whiteSpace==='nowrap' && s.textOverflow==='ellipsis';})).toBe(true);
}
test('indexed review states at desktop and phone widths',async({page})=>{
 const errors:string[]=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('pageerror',e=>errors.push(e.message));
 // Packet 077 now requests quotes on coin pages. Only quotes are synthetic; indexed reads stay real.
 await page.route('**/v1/trade/quote',route=>{
  const input=route.request().postDataJSON();
  return route.fulfill({json:{...fixtures.TradeQuote,coin:input.coin,side:input.side,amountUsd:input.amountUsd,account:undefined,binding:false,amountIn:'100',valueWei:'0',expectedOut:'100',minOut:'99',approvals:[],fee:{bps:0,usd:0,destination:null},route:{venue:'uniswap_v3',executable:false},expiresAt:new Date(Date.now()+15000).toISOString()}});
 });
 await page.goto('/radar');await expect(page.locator('tr[data-address]').first()).toBeVisible();
 const result=await page.request.get('/v1/radar');expect(result.ok()).toBe(true);const radar=await result.json();
 expect(radar.totals.danger).toBe(5);expect(radar.rows.filter((r:{verdict:string})=>r.verdict==='danger')).toHaveLength(0);
 await expect(page.locator('.head-stats div').filter({hasText:'Danger now'})).toContainText(String(radar.totals.danger));
 await expect(page.locator('.head-stats div').filter({hasText:'Scanned today'})).toContainText(String(radar.totals.evaluatedToday));
 await expect(page.locator('.head-stats div').filter({hasText:'Honeypots refused'})).toContainText('—');
 await expect(page.locator('.head-stats div').filter({hasText:'Honeypots refused'})).toContainText('not checked yet');
 const exit=page.locator('tr[data-address] .c-exit [aria-label="Not checked yet"]').first();await expect(exit).toBeVisible();await expect(exit).toHaveText('—');await expect(exit).toHaveAttribute('title','Not checked yet');
 await expect(page.getByText('— not checked yet: exit costs and buyer mix arrive with the trade simulation and wallet labels',{exact:true})).toBeVisible();
 expect(radar.rows.some((r:{address:string})=>r.address===identity)).toBe(false);
 await noOverflow(page);await symbolFits(page,'.rt-sym');
 if(page.viewportSize()!.width===1440){await expect(page.locator('tr[data-address] .c-act button').first()).toBeVisible();await page.setViewportSize({width:1280,height:900});await noOverflow(page);await page.setViewportSize({width:1440,height:900});}
 await page.goto('/pairs');await expect(page.locator('li[data-address]').first()).toBeVisible();await noOverflow(page);await symbolFits(page,'.pr-sym');
 const pair=page.locator('li[data-address]').first();
 for(const cell of await pair.locator('.pr-cell').all()){const label=cell.locator('.pr-l'),value=cell.locator(':scope > [aria-label="Not checked yet"]');if(await value.count()){const l=await label.boundingBox(),v=await value.boundingBox();expect(l!.y+l!.height).toBeLessThanOrEqual(v!.y);}}
await expect(pair.getByText('Not fully checked',{exact:true})).toHaveCount(1);await expect(pair.locator('.pr-exit [aria-label="Not checked yet"]')).toBeVisible();
 const near=await page.request.get('/v1/pairs?stage=near_grad');expect((await near.json()).rows[0].curvePct).toBe(80);
 const migrated=await page.request.get('/v1/pairs?stage=migrated');expect((await migrated.json()).rows.some((r:{address:string})=>r.address===identity)).toBe(false);
 if(page.viewportSize()!.width===390)await page.getByRole('button',{name:/Near grad/}).click();
 await expect(page.locator('li[data-address]').filter({hasText:'80%'})).toBeVisible();
 const scan=await page.request.get('/v1/scan?q=$POOL');expect((await scan.json()).status).toBe('pending');
 await page.goto('/feed');await expect(page.locator('[data-feed-id]').first()).toBeVisible();
 for(const label of ['Trades','Ghost Reports','Swarm calls','Burns'])await expect(page.locator('.feed-kind').filter({hasText:label}).locator('[aria-label="Not tracked yet"]')).toHaveText('—');
 for(const kind of ['trade','ghost','swarm','burn'])await expect(page.locator(`.feed-mix .k-${kind} [aria-label="Not tracked yet"]`)).toHaveText('—');
 await noOverflow(page);await symbolFits(page,'.fr-sym');
 // The captured launch's last trade is ten hours old; real empty candles are distinct from loading.
 await page.goto(`/coin/${radar.rows[0].address}`);await expect(page.locator('.coin-id h1')).toContainText('LONGSAMPLESYMBOL');await symbolFits(page,'.coin-id h1');await noOverflow(page);
 const captured=radar.rows.find((r:{symbol:{text:string}})=>r.symbol.text==='FIX');expect(captured).toBeTruthy();
 await page.goto(`/coin/${captured.address}`);await expect(page.getByText(/No trades in this window · last trade 10 h ago/)).toBeVisible();
 await expect(page.locator('.tp-quote[data-tour="fee-lines"]')).toContainText('Terminal fee');await expect(page.locator('.tp-submit')).toBeDisabled();
 await expect(page.locator('.chart-flowkeys input')).toHaveCount(4);for(const box of await page.locator('.chart-flowkeys input').all())await expect(box).toBeDisabled();
 await expect(page.getByText('Wallet labels arrive later',{exact:true})).toBeVisible();await noOverflow(page);
 await page.getByRole('button',{name:'Show full history'}).click();await expect(page.getByText(/No trades in this window/)).toHaveCount(0);await expect(page.locator('.coin-ohlc')).toContainText('O ');await expect(page.getByText('Loading indexed candles…',{exact:true})).toHaveCount(0);
 expect(errors).toEqual([]);
});
test('all indexed reads stay within the API latency budget',async({request})=>{
 const radar=await (await request.get('/v1/radar')).json(),coin=radar.rows[0].address,now=Math.floor(Date.now()/1000);
 for(const route of ['/radar','/pairs?stage=new','/pairs?stage=near_grad','/pairs?stage=migrated','/feed','/feed?kinds=verdict',`/coins/${coin}`,`/coins/${coin}/verdict`,`/coins/${coin}/flow`,`/coins/${coin}/candles?tf=5m&from=${now-21600}&to=${now}`,`/coins/${coin}/markers?from=${now-21600}&to=${now}`,`/scan?q=${identity}`]){
  const start=performance.now(),res=await request.get('/v1'+route);expect(res.ok(),route).toBe(true);await res.body();expect(performance.now()-start,route).toBeLessThan(300);
 }
});
