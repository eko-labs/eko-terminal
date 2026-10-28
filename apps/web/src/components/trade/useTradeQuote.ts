import { useEffect, useRef, useState, type RefObject } from 'react';
import { TradeQuoteSchema, type TradeQuoteRequest } from '@eko/shared';
import { fetchParsed } from '../../lib/api';
import { serverNow } from '../../lib/clock';
import { emptyQuote, TradeQuoteSession } from './tradePanelModel';

export function useTradeQuote(input: TradeQuoteRequest, panel: RefObject<HTMLDivElement | null>, enabled: boolean, antiSnipeEndsAt?: number) {
  const [snapshot, setSnapshot] = useState(emptyQuote), [now, setNow] = useState(serverNow);
  const session = useRef<TradeQuoteSession | null>(null);
  const active = useRef(enabled), inView = useRef(typeof IntersectionObserver === 'undefined');
  active.current = enabled;
  useEffect(() => {
    setSnapshot(emptyQuote());
    const current = new TradeQuoteSession(input, (body, signal) => fetchParsed('/trade/quote', TradeQuoteSchema, { body, signal }), setSnapshot, serverNow, antiSnipeEndsAt);
    session.current = current;
    inView.current = typeof IntersectionObserver === 'undefined';
    const visibility = () => current.setVisible(active.current && inView.current && document.visibilityState !== 'hidden');
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      inView.current = entries.some(entry => entry.isIntersecting); visibility();
    });
    if (panel.current) observer?.observe(panel.current);
    document.addEventListener('visibilitychange', visibility);
    visibility();
    const clock = setInterval(() => setNow(serverNow()), 250);
    return () => { current.dispose(); session.current = null; observer?.disconnect(); document.removeEventListener('visibilitychange', visibility); clearInterval(clock); };
  }, [input.coin, input.side, input.amountUsd, input.slippageBps, input.riskMode, input.account, panel]);
  useEffect(() => { session.current?.setAntiSnipeEndsAt(antiSnipeEndsAt); }, [antiSnipeEndsAt]);
  useEffect(() => { session.current?.setVisible(enabled && inView.current && document.visibilityState !== 'hidden'); }, [enabled]);
  return { snapshot, now, acknowledge: () => session.current?.acknowledge(), refresh: () => void session.current?.refresh() };
}
