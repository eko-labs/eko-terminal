import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { TradeOrder, TradeQuote, TradeQuoteRequest } from '@eko/shared';
import { panelBlock, type PanelGate } from './tradePanelModel';

/** 078 installs a wallet flow here; this panel never calls legacy execution endpoints. */
export interface TradeHandoff {
  quote: TradeQuote;
  input: TradeQuoteRequest;
  acknowledged: string[];
  requestedAt?: number;
}
export interface TradeAdapter {
  wallet: { address: string; chainId?: number } | null;
  execute(handoff: TradeHandoff): Promise<TradeOrder>;
  feedback?: { message: string; order?: TradeOrder };
  identity?: string;
}
export class TradeLock {
  busy = false;
  private listeners = new Set<() => void>();
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.busy;
  async run(gate: PanelGate, execute: TradeAdapter['execute']): Promise<TradeOrder | null> {
    if (this.busy || panelBlock(gate) || !gate.snapshot.quote) return null;
    const q = gate.snapshot.quote, codes = [...new Set(q.guard.checks.filter(c => c.status === 'warn').map(c => c.code))];
    if (codes.some(code => !gate.snapshot.acknowledged.includes(code))) return null;
    this.busy = true; this.listeners.forEach(fn => fn());
    try { return await execute({ quote: q, input: gate.input, acknowledged: codes, requestedAt: gate.snapshot.requestedAt }); }
    finally { this.busy = false; this.listeners.forEach(fn => fn()); }
  }
}
const sharedLock = new TradeLock();
const TradeContext = createContext<{ adapter: TradeAdapter | null; lock: TradeLock }>({ adapter: null, lock: sharedLock });
export function TradeProvider({ adapter, children }: { adapter: TradeAdapter | null; children: ReactNode }) {
  const lock = useMemo(() => new TradeLock(), []);
  return <TradeContext.Provider value={{ adapter, lock }}>{children}</TradeContext.Provider>;
}
export function useTradeExecution() {
  const context = useContext(TradeContext);
  const busy = useSyncExternalStore(context.lock.subscribe, context.lock.snapshot, context.lock.snapshot);
  return { ...context, busy };
}
