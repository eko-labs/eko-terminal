import { describe, expect, it, vi } from 'vitest';
import { PairsService } from '../src/read/pairs.js';
import { RadarService } from '../src/read/radar.js';
import { GuardReadStore } from '../src/read/guard-store.js';
import type { ReadStore } from '../src/read/store.js';

// All header contracts are host-refreshed. Even the first/expired request must schedule no SQL.
describe.each(['radar','guard','pairs'] as const)('%s header snapshots', kind => {
  const fixture=()=>{
    const state={clock:Date.parse('2026-10-17T12:00:00Z'),coins:1,fail:false,gate:Promise.resolve()};
    const query=vi.fn(async()=>{
      const coins=state.coins;
      await state.gate;
      if(state.fail)throw new Error('database unavailable');
      return {rows:[{coin:Buffer.alloc(20,1),launches:String(coins),median:null,refused:'0',tier:0,n:String(coins),h:0,coins:String(coins),lower:String(coins),elevated:'0',high:'0',incomplete:'0',no_verdict:'0'}]};
    });
    let refresh!:()=>Promise<void>;
    const store={now:()=>state.clock,sellCheckQuotes:false,currentModels:async()=>{},onSummaryRefresh:(fn:()=>Promise<void>)=>{refresh=fn;},db:{sql:{query}}} as unknown as ReadStore;
    const pairs=kind==='pairs'?new PairsService(store):undefined;
    return {state,query,service:kind==='radar'?new RadarService(store):kind==='guard'?new GuardReadStore(store):{totals:async()=>({coins:(await pairs!.today()).launches})},tick:()=>refresh()};
  };
  it('never queries on first or expired reads and coalesces host refreshes',async()=>{
    const {state,query,service,tick}=fixture();
    await service.totals();expect(query).not.toHaveBeenCalled();
    await tick();expect(await service.totals()).toMatchObject({coins:1});
    const queries=query.mock.calls.length;
    state.clock+=59_999;await tick();expect(query).toHaveBeenCalledTimes(queries);
    state.clock+=1;state.coins=2;
    let release!:()=>void;state.gate=new Promise<void>(resolve=>{release=resolve;});
    const work=tick(),same=tick();
    expect(await service.totals()).toMatchObject({coins:1});
    expect(query).toHaveBeenCalledTimes(queries+1);
    release();await Promise.all([work,same]);
    expect(await service.totals()).toMatchObject({coins:2});
    state.clock+=120_000;
    const before=query.mock.calls.length;
    expect(await service.totals()).toMatchObject({coins:2});expect(query).toHaveBeenCalledTimes(before);
  });
  it('keeps the last counts on failure, retries only on a host tick, and handles backwards clocks',async()=>{
    const {state,query,service,tick}=fixture();
    await tick();state.clock+=60_000;state.fail=true;
    await expect(tick()).rejects.toThrow('database unavailable');
    const before=query.mock.calls.length;
    expect(await service.totals()).toMatchObject({coins:1});expect(query).toHaveBeenCalledTimes(before);
    state.fail=false;state.coins=3;await tick();expect(await service.totals()).toMatchObject({coins:3});
    state.clock-=120_000;state.coins=4;await tick();expect(await service.totals()).toMatchObject({coins:4});
  });
});
