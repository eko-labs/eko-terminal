import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../lib/api';
import { createWatchStore, watchTarget } from './watch';
import { createMockTransport } from '../mocks/transport';
import { createAddress, createAlert, createAlertSettings } from '../mocks/fixtures';
import { AlertSettingsSchema, type WatchBody, type WsClient, type WsServer } from '@eko/shared';
import { Realtime, type ChannelTransport } from '../lib/realtime';
const coin: WatchBody = { kind: 'coin', target: createAddress() };
const wallet: WatchBody = { kind: 'wallet', target: `0x${'2'.repeat(40)}` };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); });
describe('owner watches and alerts', () => {
  it('does no account I/O without a verified owner and validates launch targets', async () => {
    const transport = vi.fn(), store = createWatchStore(createApi('/v1', transport));
    await store.getState().refresh(); await store.getState().resyncAlerts();
    await expect(store.getState().change(coin, false)).rejects.toThrow('Connect');
    expect(transport).not.toHaveBeenCalled();
    expect(() => watchTarget({kind: 'coin', target: '<img>'})).toThrow();
    expect(() => watchTarget({kind: 'crew', target: 'demo-crew'})).toThrow('unavailable');
    expect(watchTarget({kind: 'crew', target: 'demo-crew'}, true)).toEqual({kind: 'crew', target: 'demo-crew'});
  });
  it('adds normalized watches, persists settings and removes through task 114 contracts', async () => {
    const store = createWatchStore(createApi('/v1', createMockTransport())); store.getState().setOwner('demo-account');
    await store.getState().refresh(); expect(store.getState().items).toEqual([]);
    await store.getState().change(coin, false); await store.getState().refresh(); expect(store.getState().items).toEqual([coin]);
    const settings = { ...createAlertSettings(), agentTradeAboveUsd: 250, telegram: true, quietHoursUtc: [22,7] as [number,number] };
    await store.getState().save(settings); await store.getState().refresh(); expect(store.getState().settings).toEqual(settings);
    await store.getState().change(coin, true); await store.getState().refresh(); expect(store.getState().items).toEqual([]);
    expect(AlertSettingsSchema.safeParse({ ...settings, agentTradeAboveUsd: -1 }).success).toBe(false);
  });
  it('removes immediately, then rolls back only its item when deletion fails', async () => {
    let release!: (r: Response) => void;
    const store = createWatchStore(createApi('/v1', async (_url, init) => init.method === 'DELETE' ? new Promise<Response>(resolve => {release = resolve;}) : response(init.method === 'POST' ? JSON.parse(String(init.body)) : {})));
    store.getState().setOwner('demo-account'); store.setState({ items: [coin] });
    const removal = store.getState().change(coin, true); expect(store.getState().items).toEqual([]);
    await store.getState().change(wallet, false); release(response({ error: 'internal_error', message: 'Offline' },500));
    await expect(removal).rejects.toThrow(); expect(store.getState().items).toEqual([wallet,coin]); expect(store.getState().pending).toEqual([]);
  });
  it('ignores old owner fetches and mutation failures after disconnect', async () => {
    let release!: (r: Response) => void;
    const store = createWatchStore(createApi('/v1', async (_url, init) => init.method === 'DELETE' ? new Promise<Response>(r => {release=r;}) : response({})));
    store.getState().setOwner('demo-account'); store.setState({ items: [coin] }); const job = store.getState().change(coin,true);
    store.getState().setOwner('sample-user'); release(response({},500)); await expect(job).rejects.toThrow();
    expect(store.getState()).toMatchObject({ owner: 'sample-user', items: [], error: null, pending: [] });
  });
  it('does not let an overlapping REST snapshot undo a completed removal', async () => {
    let release!: (r: Response) => void;
    const store = createWatchStore(createApi('/v1', async (url, init) => init.method === 'DELETE' ? response({ok:true}) : url.endsWith('/watch') ? new Promise<Response>(r => {release=r;}) : response(createAlertSettings())));
    store.getState().setOwner('demo-account'); store.setState({items:[coin]}); const snapshot=store.getState().refresh();
    await store.getState().change(coin,true); release(response({items:[coin]})); await snapshot; expect(store.getState().items).toEqual([]);
  });
  it('recovers paged history without initial toasts and deduplicates reconnect/live deliveries', async () => {
    const alert = createAlert(), next = {...alert,id:'alert-next'}, notify=vi.fn(); let round=0;
    const store=createWatchStore(createApi('/v1',async url => response(url.endsWith('after=0') ? {rows:[alert],cursor:1,seq:1} : {rows: round ? [next] : [],cursor:null,seq: round ? 2 : 1})),notify);
    store.getState().setOwner('demo-account'); expect(await store.getState().resyncAlerts()).toBe(1); expect(notify).not.toHaveBeenCalled();
    round++; expect(await store.getState().resyncAlerts()).toBe(2); expect(notify).toHaveBeenCalledOnce();
    store.getState().receive([{t:'ev',ch:'alerts',kind:'alert',seq:2,ts:Date.now(),data:next}]); expect(notify).toHaveBeenCalledOnce(); expect(store.getState().alerts).toHaveLength(2);
    store.getState().setOwner(null); expect(store.getState().alerts).toEqual([]);
  });
  it('reports history failure and recovers on retry', async () => {
    let broken=true; const store=createWatchStore(createApi('/v1',async()=> response(broken ? {} : {rows:[],cursor:null,seq:0},broken ? 500 : 200)));
    store.getState().setOwner('demo-account'); await expect(store.getState().resyncAlerts()).rejects.toThrow(); expect(store.getState().alertError).toContain('Retry');
    broken=false; await store.getState().resyncAlerts(); expect(store.getState().alertError).toBeNull();
  });
  it('toasts a typed alert on the next frame within one second and resyncs on reconnect', async () => {
    vi.useFakeTimers();
    let message!: (m: WsServer) => void, state!: (s: 'open') => void;
    const transport: ChannelTransport = {state:'closed',connect:()=>state('open'),close:()=>{},reconnect:()=>state('open'),send:(_m:WsClient)=>{},on:l=>{message=l;return()=>{};},onState:l=>{state=l;return()=>{};}};
    const rt = new Realtime(transport, cb => Number(setTimeout(()=>cb(0),16)), id=>clearTimeout(id));
    const notify=vi.fn(), fetch=vi.fn(async()=>response({rows:[],cursor:null,seq:0})); const store=createWatchStore(createApi('/v1',fetch),notify);
    store.getState().setOwner('demo-account'); await store.getState().resyncAlerts(); rt.setSignedIn(true);
    rt.subscribeBatch('alerts',e=>store.getState().receive(e),()=>store.getState().resyncAlerts()); rt.connect();
    const start=Date.now(); message({t:'ev',ch:'alerts',kind:'alert',seq:1,ts:start,data:createAlert()}); vi.advanceTimersByTime(16);
    expect(notify).toHaveBeenCalledOnce(); expect(Date.now()-start).toBeLessThan(1000);
    transport.reconnect(); await vi.advanceTimersByTimeAsync(1000); await tick(); expect(fetch).toHaveBeenCalledTimes(2); rt.close();
  });
});
