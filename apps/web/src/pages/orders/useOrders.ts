import { useCallback, useEffect, useRef, useState } from 'react';
import { CoinCardSchema, type TradeOrder, type Untrusted } from '@eko/shared';
import { ApiError, fetchParsed, isRateLimited } from '../../lib/api';
import { guardedOrderHistory } from '../../lib/guardedTradeClient';
import { knownCoinIdentity, rememberCoinIdentity } from '../../lib/coinIdentity';
import { hasOpenOrders, OPEN_ORDER_REFRESH_MS } from './ordersModel';

export type OrdersState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'signed_out' }
  | { kind: 'ready'; rows: TradeOrder[]; refreshing: boolean };

/**
 * Loads the orders and reports each state. While any order is `submitted` it loads again after `delay`, and stops once
 * none is. A 401 means the session ended (signed out); a rate limit keeps the last list. Only the latest load reports.
 */
export function watchOrders(load: () => Promise<{ rows: TradeOrder[] }>, emit: (state: OrdersState) => void, delay = OPEN_ORDER_REFRESH_MS) {
  let last: OrdersState = { kind: 'loading' }, seq = 0, stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const set = (state: OrdersState) => { last = state; emit(state); };
  const run = async () => {
    clearTimeout(timer); timer = undefined;
    const mine = ++seq;
    set(last.kind === 'ready' ? { ...last, refreshing: true } : { kind: 'loading' });
    try {
      const { rows } = await load();
      if (stopped || mine !== seq) return;
      set({ kind: 'ready', rows, refreshing: false });
    } catch (e) {
      if (stopped || mine !== seq) return;
      if (e instanceof ApiError && e.status === 401) set({ kind: 'signed_out' });
      else if (isRateLimited(e) && last.kind === 'ready') set({ ...last, refreshing: false });
      else set({ kind: 'error', message: (e as Error).message });
    }
    if (last.kind === 'ready' && hasOpenOrders(last.rows)) timer = setTimeout(() => void run(), delay);
  };
  void run();
  return { refresh: () => { if (!stopped) void run(); }, stop: () => { stopped = true; clearTimeout(timer); } };
}

/** The signed-in account's orders (watchOrders), loaded again from scratch when the account changes. */
export function useOrders(owner: string | null, load: typeof guardedOrderHistory = guardedOrderHistory) {
  const [state, setState] = useState<OrdersState>({ kind: 'loading' });
  const watcher = useRef<ReturnType<typeof watchOrders> | null>(null);
  useEffect(() => {
    if (!owner) return;
    const w = watchOrders(load, setState); watcher.current = w;
    return () => { w.stop(); if (watcher.current === w) watcher.current = null; };
  }, [owner, load]);
  return { state, retry: useCallback(() => watcher.current?.refresh(), []) };
}

export type CoinName = { symbol: Untrusted; name: Untrusted };
/** At most this many coins are looked up per visit; the rest show their address. */
const MAX_LOOKUPS = 40, PARALLEL = 3;

/** Symbol and name for each coin in the list: from coins already seen this session, else from the coin's card. */
export function useCoinNames(addresses: readonly string[]) {
  const [names, setNames] = useState<Record<string, CoinName>>({});
  const asked = useRef(new Set<string>());
  const key = [...new Set(addresses.map(a => a.toLowerCase()))].join(',');
  useEffect(() => {
    const known: Record<string, CoinName> = {}, todo: string[] = [];
    for (const address of key ? key.split(',') : []) {
      const hit = knownCoinIdentity(address);
      if (hit) known[address] = { symbol: hit.symbol, name: hit.name };
      else if (!asked.current.has(address) && asked.current.size < MAX_LOOKUPS) { asked.current.add(address); todo.push(address); }
    }
    if (Object.keys(known).length) setNames(n => ({ ...n, ...known }));
    if (!todo.length) return;
    const ac = new AbortController(), batch = [...todo], done = new Set<string>();
    const worker = async () => {
      for (let address = todo.shift(); address && !ac.signal.aborted; address = todo.shift()) {
        try {
          const card = await fetchParsed(`/coins/${encodeURIComponent(address)}`, CoinCardSchema, { signal: ac.signal });
          rememberCoinIdentity(card.identity); done.add(address);
          setNames(n => ({ ...n, [address!]: { symbol: card.identity.symbol, name: card.identity.name } }));
        } catch { /* The row keeps the coin's address. */ }
      }
    };
    void Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
    // Coins not looked up (aborted, or failed) may be asked for again on the next list.
    return () => { ac.abort(); for (const address of batch) if (!done.has(address)) asked.current.delete(address); };
  }, [key]);
  return names;
}
