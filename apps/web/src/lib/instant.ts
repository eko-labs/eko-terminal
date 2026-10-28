import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection } from 'wagmi';
import { getConnection } from 'wagmi/actions';
import { getMarket, type Balance, type Order, type OrderStatus } from '@eko/shared';
import { useApp } from '../store/app';
import { api } from './api';
import { runLive, type InstantPhase, type InstantRequest, type InstantResult, type LiveEnv } from './instantFlow';
import { approveToken, ensureChain, newIdempotencyKey, signAndSubmit, siweSignIn } from './trade';
import { wagmiConfig } from './wallet';

/**
 * One-tap trading: Buy/Sell a preset USD amount immediately, in the current mode.
 *  live  — the tap goes straight to the user's wallet (network switch and sign-in if needed, an
 *          exact approval if needed, then the swap); 'submitted' until the reconciler confirms it.
 *
 * The hook never toasts: `run` resolves with a short, human `message` and the UI shows it.
 * Paper resolves with the fill. Live resolves at 'submitted' ("Submitted — waiting for
 * confirmation") so the UI isn't blocked; `phase` and `last` then follow the order stream to
 * 'confirmed' (with the fill message) or 'failed'. Failures before submission resolve directly.
 *
 * Phases: paper quoting → filled | failed. Live [signing (network / sign-in)] → quoting →
 * [approving → quoting] → signing → submitted → confirmed | failed. Cancelling in the wallet or a
 * trade that still needs confirming (code 'confirm_required') ends in 'idle'. The phase stays on
 * its end state until the next run. Double taps: while a run is pending (until filled, or
 * submitted on Live) another `run` resolves `{ ok: false, code: 'busy' }`; each tap gets its
 * own idempotency key.
 */
export type { InstantPhase, InstantRequest, InstantResult, InstantSide } from './instantFlow';

export interface Holding {
  /** Base-asset quantity held in the current mode. */
  qty: number;
  /** Its value at the current bid, USD. */
  usd: number;
}

const SETTLED = new Set<OrderStatus>(['confirmed', 'failed', 'rejected', 'expired', 'cancelled']);
/** Codes where nothing happened and nothing went wrong. */
const QUIET = new Set(['user_rejected', 'confirm_required']);
const stage = (s: OrderStatus) => (s === 'awaiting_signature' ? 0 : s === 'submitted' ? 1 : 2);

/** Store an order unless the stream has already delivered a later state of it. */
function upsertLatest(o: Order) {
  const st = useApp.getState();
  const cur = st.orders.find((x) => x.id === o.id);
  if (!cur || stage(cur.status) <= stage(o.status)) st.upsertOrder(o);
}

/** Resolves when the order stream (WebSocket, or the refetch after a reconnect) shows the order settled. */
function settled(orderId: string): Promise<Order> {
  return new Promise((resolve) => {
    const check = (s: ReturnType<typeof useApp.getState>) => {
      const o = s.orders.find((x) => x.id === orderId);
      if (!o || !SETTLED.has(o.status)) return;
      unsubscribe();
      resolve(o);
    };
    const unsubscribe = useApp.subscribe(check);
    check(useApp.getState());
  });
}

function liveEnv(mode: LiveEnv['mode'], market: string, onPhase: LiveEnv['onPhase']): LiveEnv {
  const st = useApp.getState();
  const conn = getConnection(wagmiConfig);
  const t = st.tickers[market];
  return {
    mode,
    route: st.config?.markets.find((m) => m.id === market)?.routes[mode] ?? null,
    liveEnabled: !!st.config?.liveTradingEnabled,
    wallet: conn.address ? { address: conn.address, chainId: conn.chainId } : null,
    verifiedWallet: st.account?.kind === 'wallet' ? st.account.walletAddress : null,
    bid: t ? (t.bid ?? t.price) : null,
    slippageBps: st.preferences.defaultSlippageBps,
    confirmLargeTradeUsd: st.preferences.confirmLargeTradeUsd,
    api,
    ensureChain,
    signIn: async (chainId) => {
      await siweSignIn(chainId);
      await useApp.getState().refreshSession();
    },
    approve: approveToken,
    signAndSubmit,
    settled,
    onPhase,
    onOrder: upsertLatest,
  };
}

export function useInstantTrade(): {
  run(req: InstantRequest): Promise<InstantResult>;
  phase: InstantPhase;
  pending: boolean;
  last: InstantResult | null;
} {
  const [phase, setPhase] = useState<InstantPhase>('idle');
  const [pending, setPending] = useState(false);
  const [last, setLast] = useState<InstantResult | null>(null);
  /** Double-tap guard: one run at a time, from the tap until submitted. */
  const locked = useRef(false);
  /** The latest run owns `phase` and `last`; an earlier live run still settling only resolves its promise. */
  const latest = useRef<object | null>(null);

  const run = useCallback((req: InstantRequest): Promise<InstantResult> => {
    if (locked.current) return Promise.resolve({ ok: false, code: 'busy', message: 'One moment — your last trade is still going through' });
    const me = {};
    latest.current = me;
    locked.current = true;
    setPending(true);
    setPhase('quoting');
    const own = () => latest.current === me;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      locked.current = false;
      setPending(false);
    };
    const { mode } = useApp.getState();
    if (mode === 'paper') {
      release();
      setPhase('idle');
      return Promise.resolve({ ok: false, code: 'paper_removed', message: 'Paper trading is not available in the terminal' });
    }
    const key = newIdempotencyKey();
    return new Promise<InstantResult>((resolve) => {
      let answered = false;
      const answer = (r: InstantResult) => {
        if (answered) return;
        answered = true;
        resolve(r);
      };
      const flow = runLive(
        req,
        key,
        liveEnv(mode, req.market, (p, interim) => {
          if (own()) setPhase(p);
          if (!interim) return;
          // Submitted: answer the tap now; phase and `last` follow the order to confirmed/failed.
          if (own()) setLast(interim);
          release();
          answer(interim);
        }),
      );
      void flow.then((r) => {
        if (own()) {
          setPhase(r.ok ? 'confirmed' : QUIET.has(r.code) ? 'idle' : 'failed');
          setLast(r);
        }
        release();
        answer(r);
      });
    });
  }, []);

  return { run, phase, pending, last };
}

/**
 * What the user holds of this market's base asset in the current mode, valued at the bid (null
 * while loading). Paper: the paper balance. Live: the connected wallet's balance on the market's
 * route (0 without a wallet or route; live sells keep GAS_RESERVE_ETH of it). Refreshed whenever
 * `portfolioRev` changes.
 */
export function useHolding(market: string): Holding | null {
  const mode = useApp((s) => s.mode);
  const rev = useApp((s) => s.portfolioRev);
  const config = useApp((s) => s.config);
  const bid = useApp((s) => {
    const t = s.tickers[market];
    return t ? (t.bid ?? t.price) : null;
  });
  const address = useConnection().address;
  const symbol = mode === 'paper' ? (getMarket(market)?.base ?? null) : (config?.markets.find((m) => m.id === market)?.routes[mode]?.base.symbol ?? null);
  const key = `${mode}|${market}|${mode === 'paper' ? '' : (address ?? '')}`;
  const [held, setHeld] = useState<{ key: string; qty: number } | null>(null);

  useEffect(() => {
    let off = false;
    const done = (qty: number) => !off && setHeld({ key, qty });
    if (mode === 'paper') {
      api<{ balances: Balance[] }>('/api/portfolio?mode=paper')
        .then((r) => done(r.balances.find((b) => b.asset === symbol)?.amount ?? 0))
        .catch(() => undefined);
    } else if (!symbol || !address) {
      done(0);
    } else {
      api<{ balances: { symbol: string; amount: number }[] }>(`/api/chain/balances?mode=${mode}&address=${address}`)
        .then((r) => done(r.balances.find((b) => b.symbol === symbol)?.amount ?? 0))
        .catch(() => undefined);
    }
    return () => {
      off = true;
    };
  }, [key, rev, mode, symbol, address]);

  if (!held || held.key !== key || bid === null) return null;
  return { qty: held.qty, usd: held.qty * bid };
}
