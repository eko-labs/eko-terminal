import { useEffect, useRef, useState } from 'react';
import { NegotiatedCoinCardSchema, NegotiatedGuardVerdictSchema, type CoinCardV2, type GuardAssessmentV2, type Address } from '@eko/shared';
import { fetchParsed, isRateLimited, MOCKS } from '../../lib/api';
import { useRealtime } from '../../lib/RealtimeContext';

/** A missing refresh result cannot erase a persisted snapshot. */
export function retainPersisted<T>(previous: T | null, incoming: T | null): T | null {
  return incoming ?? previous;
}
export function retainGuardCard(previous: CoinCardV2 | null, incoming: CoinCardV2 | null) {
  return previous?.verdict && incoming?.verdict === null ? previous : retainPersisted(previous, incoming);
}

export function useGuardCoin(address: string) {
  const rt = useRealtime(), persisted = useRef(false);
  const [card, setCard] = useState<CoinCardV2 | null>(null);
  const [assessment, setAssessment] = useState<GuardAssessmentV2 | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [failed, setFailed] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (MOCKS) { setStatus('unavailable'); return; }
    const ac = new AbortController();
    const base = `/v2/coins/${encodeURIComponent(address)}`;
    let generation = 0;
    let flight: Promise<void> | undefined;
    const load = async () => {
      const gen = ++generation;
      let missingRefresh = false;
      const current = () => !ac.signal.aborted && gen === generation;
      const verdict = fetchParsed(`${base}/verdict`, NegotiatedGuardVerdictSchema, { signal: ac.signal }).then(result => {
        if (!current() || result.version !== 2) return;
        if (result.verdict) persisted.current = true;
        else if (persisted.current) missingRefresh = true;
        setAssessment(old => retainPersisted(old, result.verdict)); setStatus('ready');
      });
      const card = fetchParsed(base, NegotiatedCoinCardSchema, { signal: ac.signal }).then(result => {
        if (!current() || result.version !== 2) return;
        if (result.card?.verdict) persisted.current = true;
        else if (persisted.current) missingRefresh = true;
        setCard(old => retainGuardCard(old, result.card));
      });
      const results = await Promise.allSettled([verdict, card]);
      if (!current()) return;
      setFailed(missingRefresh || results.some(r => r.status === 'rejected' && !isRateLimited(r.reason)));
      if (results[0].status === 'rejected' && !isRateLimited(results[0].reason)) setStatus('unavailable');
    };
    const refresh = () => flight ?? (flight = load().finally(() => { flight = undefined; }));
    void refresh();
    // V2 is explicitly negotiated over REST. Legacy WS notifications only trigger
    // a captured-source refresh; they never reinterpret a V1 payload as V2.
    const off = rt?.subscribe<'coin'>(`coin:${address as Address}`, event => {
      if (event.kind !== 'tick') void refresh();
    }, () => { void refresh(); });
    return () => { ac.abort(); off?.(); };
  }, [address, rt, retry]);
  return { card, assessment, status, failed, retry: () => setRetry(n => n + 1) };
}
