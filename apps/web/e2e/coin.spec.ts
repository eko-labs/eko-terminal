import { expect, type Page } from '@playwright/test';
import { test } from './helpers';
test.use({ demo: true });
const address='0xe9082becaa27f99717e78cf80c3dfb1fdbc6f2b1';
type CoreProbe={xForTime(t:number):number|null;scale:number;view:{s:number;e:number};data:{ts:number}[]};
async function lockError(page:Page){return page.locator('.coin-chart').evaluate(el=>{
 // xForTime is relative to the drawing surface, which sits inside the chart's 1px border.
 const core=(el as HTMLElement&{__ekoChartCore:CoreProbe}).__ekoChartCore,box=(el.querySelector('canvas')??el).getBoundingClientRect();
 const errors=Array.from(el.querySelectorAll<HTMLButtonElement>('.fmark:not([hidden])')).map(m=>{const r=m.getBoundingClientRect(),x=core.xForTime(Number(m.dataset.anchor));return x===null?Infinity:Math.abs(r.left+r.width/2-box.left-x);});return {count:errors.length,max:Math.max(0,...errors)};
});}
async function ready(page:Page){await page.goto(`/coin/${address}`);await expect(page.getByRole('heading',{name:'$GHOST',exact:true})).toBeVisible();await expect(page.locator('.fmark:not([hidden])').first()).toBeAttached();await expect.poll(async()=>(await lockError(page)).count).toBeGreaterThan(5);await page.waitForTimeout(1200);}
test('prototype layout, tabs and no horizontal page overflow',async({page},info)=>{
 await ready(page);const phone=page.viewportSize()!.width<700;
 await expect(page.getByRole('tab',{name:phone?'Card':'Overview',exact:true})).toBeVisible();
 await expect(page.locator('.coin-id .sub')).toContainText('Pons');
 await expect(page.locator('.coin-id .sub')).toContainText('Migrated');
 await expect(page.locator('.coin-id .sub')).toContainText('8h 12m old');
 await expect(page.locator('.coin-price b')).toHaveText(/^\$0\.\d{5}$/);
 await expect(page.locator('.coin-chart > .coin-timeframes')).toHaveCount(0);
 const toolbar=page.locator('.chart-top'),timeframes=toolbar.getByRole('group',{name:'Timeframe',exact:true});
 await expect(timeframes.getByRole('button',{name:'5m',exact:true})).toBeVisible();
 const more=toolbar.locator('.coin-tf-more summary');
 if(await more.isVisible()){
   await more.click();
   for(const tf of ['1s','15s','1m','1h','4h','1d'])await expect(toolbar.locator('.coin-tf-menu').getByRole('button',{name:tf,exact:true})).toBeVisible();
   await toolbar.locator('.coin-tf-menu').getByRole('button',{name:'1h',exact:true}).click();
   await expect(page.locator('.coin-chart')).toHaveAttribute('data-timeframe','1h');
   await expect(toolbar.locator('.coin-tf-more')).not.toHaveAttribute('open','');
 }
 // The prototype 30m option is derived from supported 15m REST bars.
 if(phone){await more.click();await toolbar.locator('.coin-tf-menu').getByRole('button',{name:'30m',exact:true}).click();}
 else await timeframes.getByRole('button',{name:'30m',exact:true}).click();
 await expect(page.locator('.coin-chart')).toHaveAttribute('data-timeframe','30m');
 await timeframes.getByRole('button',{name:'5m',exact:true}).click();
 await expect.poll(async()=>(await lockError(page)).count).toBeGreaterThan(5);
 if(page.viewportSize()!.width===1512){
   const ohlc=page.locator('.coin-ohlc');await expect(ohlc).toBeVisible();
   await expect(ohlc).toHaveText(/^O \$0\.\d{5} H \$0\.\d{5} L \$0\.\d{5} C \$0\.\d{5}$/);
   const read=await ohlc.boundingBox(),controls=await toolbar.locator('.chart-ctl').boundingBox();
   expect(read!.x+read!.width).toBeLessThanOrEqual(controls!.x);
 }
 if(phone){
   const pill=await toolbar.getByRole('button',{name:'Open verdict evidence'}).boundingBox(),frames=await timeframes.boundingBox();
   expect(Math.abs(pill!.y+pill!.height/2-frames!.y-frames!.height/2)).toBeLessThan(1);
   await expect(toolbar.getByRole('group',{name:'Chart type',exact:true})).toBeHidden();
   await expect(page.locator('.coin-chart-phone-options').getByRole('group',{name:'Chart type',exact:true})).toBeVisible();
 }
 const labels=page.locator('#coin-evidence .coin-section-head h3');
 await expect(labels).toHaveCSS('text-transform','uppercase');
 await expect(page.locator('.coin-aside .coin-section-head h3')).toHaveCSS('text-transform','uppercase');

 if(!phone){await page.getByRole('tab',{name:'Signal',exact:true}).click();const panel=page.getByRole('tabpanel').filter({visible:true});await expect(panel.getByRole('heading',{name:'Signal · five readings Beta'})).toBeVisible();await expect(panel.getByRole('columnheader',{name:'Reading',exact:true})).toBeVisible();expect(await panel.innerText()).not.toMatch(/agent/i);await page.getByRole('tab',{name:'Overview',exact:true}).click();}
 await page.getByRole('button',{name:'Open verdict evidence'}).click();await expect(page.locator('#coin-evidence details').first()).toHaveAttribute('open','');
 expect(await page.evaluate(()=>({document:document.documentElement.scrollWidth<=innerWidth,main:document.querySelector('.shell-main')!.scrollWidth<=document.querySelector('.shell-main')!.clientWidth}))).toEqual({document:true,main:true});
 if(phone){expect(await page.locator('.coin-chart').evaluate(el=>el.getBoundingClientRect().height)).toBeCloseTo(page.viewportSize()!.height*.45,0);await expect(page.locator('.coin-sheet').getByRole('button',{name:'Buy',exact:true})).toBeVisible();await expect(page.locator('.coin-sheet').getByRole('button',{name:'Sell',exact:true})).toBeVisible();await page.getByRole('button',{name:'Expand',exact:true}).click();await page.locator('.coin-sheet .panel-body').first().evaluate(el=>el.scrollTop=el.scrollHeight);await expect(page.locator('.coin-sheet').getByRole('button',{name:'Buy',exact:true})).toBeInViewport();await expect(page.locator('.coin-sheet').getByRole('button',{name:'Sell',exact:true})).toBeInViewport();}
 await page.locator('.shell-main').evaluate(el=>el.scrollTop=0);await page.screenshot({path:info.outputPath('coin.png'),fullPage:true});
});
test('markers remain locked to xForTime through three zooms and pan',async({page})=>{
 await ready(page);await expect.poll(async()=>(await lockError(page)).max).toBeLessThan(.75);
 const chart=page.locator('.coin-chart'),box=await chart.boundingBox();if(!box)throw new Error('Missing chart');
 for(const delta of [-130,-130,200]){await page.mouse.move(box.x+box.width*.5,box.y+box.height*.6);await page.mouse.wheel(0,delta);await expect.poll(async()=>(await lockError(page)).max).toBeLessThan(.75);expect((await lockError(page)).count).toBeGreaterThan(0);}
 const y=box.y+box.height-60,x=box.x+box.width*.4;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+55,y,{steps:10});await page.mouse.up();await expect.poll(async()=>(await lockError(page)).max).toBeLessThan(.75);
});
test('price-scale wheel stretches vertically, keyboard scope and marker focus',async({page})=>{
 await ready(page);const chart=page.locator('.coin-chart');const before=await chart.evaluate(el=>{const c=(el as HTMLElement&{__ekoChartCore:CoreProbe}).__ekoChartCore;return {scale:c.scale,view:{...c.view}};});
 const scale=await page.locator('.cc-scale').boundingBox();if(!scale)throw new Error('Missing scale');await page.mouse.move(scale.x+scale.width/2,scale.y+scale.height/2);await page.mouse.wheel(0,180);
 await expect.poll(()=>chart.getAttribute('data-scale')).not.toBe(String(before.scale));expect(await chart.evaluate(el=>(el as HTMLElement&{__ekoChartCore:CoreProbe}).__ekoChartCore.view)).toEqual(before.view);await expect.poll(async()=>(await lockError(page)).max).toBeLessThan(.75);
 await page.locator('.cc-surface').focus();await page.keyboard.press('0');await page.keyboard.press('1');await expect(chart).toHaveAttribute('data-timeframe','1s');await page.keyboard.press('4');await expect(page.locator('.chart-top').getByRole('group',{name:'Timeframe',exact:true}).getByRole('button',{name:'5m',exact:true})).toHaveAttribute('aria-pressed','true');await expect.poll(async()=>(await lockError(page)).count).toBeGreaterThan(0);
 await page.getByRole('button',{name:'Watch',exact:true}).focus();await page.keyboard.press('2');await expect(page.locator('.chart-top').getByRole('group',{name:'Timeframe',exact:true}).getByRole('button',{name:'5m',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.locator('.cc-surface').focus();const count=await page.locator('.fmark:not([hidden])').count();for(let i=0;i<count;i++){await page.keyboard.press('Tab');await expect(page.locator('.fmark:focus')).toHaveCount(1);await expect(page.locator('.coin-tip')).toBeVisible();expect(await page.locator('.fmark:focus').getAttribute('aria-label')).toMatch(/(buy|sell), \$[\d,.]+, \d\d:\d\d:\d\d, wallet 0x/);}
});
test('unknown coin offers Scan',async({page})=>{await page.goto('/coin/0x1111111111111111111111111111111111111111');await expect(page.getByRole('heading',{name:'Not indexed yet'})).toBeVisible();await expect(page.locator('#main').getByRole('button',{name:'Scan',exact:true})).toBeVisible();});
