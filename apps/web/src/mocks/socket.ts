import type { WsClient, WsServer } from '@eko/shared';
import type { ChannelTransport } from '../lib/realtime';
import type { WsState } from '../lib/ws';
import { createWsEventMap } from './fixtures';
import { createRadarRows } from './demo/radar';
import { MOCK_HEAD_BLOCK } from './head';
import { coinTick, recordCoinTick, coinMarkers, COIN_EPOCH } from './demo/coin';
import { createRadarCard } from './demo/radar';
import { onMissionEvent } from './demo/mission';
import { advancePairs, advanceFeed } from './demo/market';

export class MockChannelSocket implements ChannelTransport {
  state: WsState = 'closed';
  private listeners = new Set<(m: WsServer) => void>();
  private states = new Set<(s: WsState) => void>();
  private radarTimer?: ReturnType<typeof setInterval>;
  private marketTimers = new Map<string, ReturnType<typeof setInterval>>();
  private step = 0;
  private coinTimer?: ReturnType<typeof setInterval>;
  private coinStep = 0;
  private radarSubscribed = false;
  private seq = new Map<string, number>();
  private channels = new Set<string>();
  private off?: () => void;
  private emit(m: WsServer) { this.listeners.forEach((l) => l(m)); }
  connect() {
    this.off?.();
    this.off = onMissionEvent((e) => {
      if (!this.channels.has(e.ch)) return;
      const seq = (this.seq.get(e.ch) ?? 0) + 1; this.seq.set(e.ch, seq);
      this.emit({ t: 'ev', ...e, seq, ts: Date.now() } as WsServer);
    });
    this.state = 'open'; this.states.forEach((l) => l('open'));
    this.emit({ t: 'hello', serverTime: Date.now(), session: 'anon', delayedSec: 0 });
  }
  private stopRadar() { this.radarSubscribed = false; if (this.radarTimer) clearInterval(this.radarTimer); this.radarTimer = undefined; }
  close() { this.off?.(); this.off = undefined; this.stopRadar(); if (this.coinTimer) clearInterval(this.coinTimer); this.coinTimer = undefined; this.marketTimers.forEach(clearInterval); this.marketTimers.clear(); this.channels.clear(); this.state = 'closed'; this.states.forEach((l) => l('closed')); }
  reconnect() { this.close(); this.connect(); }
  send(m: WsClient) {
    if (m.op === 'ping') { this.emit({ t: 'pong', serverTime: Date.now() }); return; }
    if (m.op === 'unsub') { m.ch.forEach((ch) => { this.channels.delete(ch); const timer = this.marketTimers.get(ch); if (timer) clearInterval(timer); this.marketTimers.delete(ch); }); if (m.ch.includes('radar')) this.stopRadar(); return; }
    const map = createWsEventMap();
    map.feed.item.block = MOCK_HEAD_BLOCK;
    for (const ch of m.ch) {
      this.channels.add(ch);
      const seq = this.seq.get(ch) ?? 0;
      this.emit({ t: 'ack', ch, seq });
      if (ch === 'pairs' || ch === 'feed') {
        if (!this.marketTimers.has(ch)) this.marketTimers.set(ch, setInterval(() => {
          if (!this.channels.has(ch)) return;
          if (ch === 'pairs') for (const data of advancePairs()) {
            const next = (this.seq.get(ch) ?? 0) + 1; this.seq.set(ch, next);
            this.emit({ t: 'ev', ch, seq: next, ts: Date.now(), kind: 'pair_upsert', data });
          } else {
            const next = (this.seq.get(ch) ?? 0) + 1; this.seq.set(ch, next);
            this.emit({ t: 'ev', ch, seq: next, ts: Date.now(), kind: 'item', data: advanceFeed() });
          }
        }, ch === 'feed' ? 2000 : 4000));
        continue;
      }
      if (ch === 'radar') {
        this.radarSubscribed = true;
        if (!this.radarTimer) this.radarTimer = setInterval(() => {
          if (!this.radarSubscribed) return;
          const rows = createRadarRows(), row = rows[Math.floor(Math.random() * rows.length)];
          this.step++;
          row.change1hPct = +(row.change1hPct + (this.step % 2 ? .4 : -.3)).toFixed(1);
          const next = (this.seq.get(ch) ?? 0) + 1; this.seq.set(ch, next);
          this.emit({ t: 'ev', ch, seq: next, ts: Date.now(), kind: 'row_upsert', data: row });
        }, 2600);
        continue;
      }
      if(ch.startsWith('coin:')||ch.startsWith('flow:')){
        const address=ch.slice(5),card=createRadarCard(address);
        if(!card)continue;
        if(ch.startsWith('coin:')){for(const [kind,data] of Object.entries({verdict:card.verdict,card})){const next=(this.seq.get(ch)??0)+1;this.seq.set(ch,next);this.emit({t:'ev',ch,seq:next,ts:Date.now(),kind,data} as WsServer);}}
        if(!this.coinTimer)this.coinTimer=setInterval(()=>{
          this.coinStep++;
          for(const channel of this.channels){if(!channel.startsWith('coin:')&&!channel.startsWith('flow:'))continue;const address=channel.slice(5),tick=coinTick(address,this.coinStep,Math.floor(Date.now()/1000));if(!tick)continue;const next=(this.seq.get(channel)??0)+1;this.seq.set(channel,next);
          if(channel.startsWith('coin:'))recordCoinTick(address,tick);const data=channel.startsWith('coin:')?tick:{...coinMarkers(address,COIN_EPOCH-72*300,COIN_EPOCH)[this.coinStep%12],ts:tick.ts};this.emit({t:'ev',ch:channel,seq:next,ts:Date.now(),kind:channel.startsWith('coin:')?'tick':'marker',data} as WsServer);}
        },2000);
        continue;
      }
      if (ch === 'agents' || ch === 'approvals') continue;
      const kind = ch.split(':')[0] as keyof typeof map;
      const events = map[kind];
      if (!events) continue;
      for (const [eventKind, data] of Object.entries(events)) {
        const next = (this.seq.get(ch) ?? 0) + 1; this.seq.set(ch, next);
        this.emit({ t: 'ev', ch, seq: next, ts: Date.now(), kind: eventKind, data } as WsServer);
      }
    }
  }
  on(l: (m: WsServer) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  onState(l: (s: WsState) => void) { this.states.add(l); return () => { this.states.delete(l); }; }
}
