import { isAddress } from 'viem';
import { z } from 'zod';
import type { ScanResult } from '@eko/shared';
import { fetchParsed } from '../../lib/api';
import { ScanResultSchema } from '@eko/shared';

export const validScanQuery = (query: string) => isAddress(query.trim()) || /^\$[A-Za-z0-9_]{1,20}$/.test(query.trim());
// TODO(spec): CA-15 has no nullable/unavailable counter wire schema yet. Accept
// explicit null/absent values, and never turn missing observation into zero.
export const ScanCountersSchema = z.object({ counters: z.object({
  refused: z.number().int().nonnegative().nullable().optional(),
  missed: z.number().int().nonnegative().nullable().optional(),
  since: z.string().datetime().nullable().optional(),
}).nullable().optional() });
export type ScanCounters = z.infer<typeof ScanCountersSchema>['counters'];
export const scanMetric = (indexed: boolean) => indexed ? 'ui.scan_to_verdict_ms.indexed' : 'ui.scan_to_verdict_ms.pending';
export const SCAN_TARGETS = { indexedP50Ms: 3000, newPairP95Ms: 5000 } as const;
export function shareLinks(id: string, origin: string) {
  const url = new URL(`/scan/${encodeURIComponent(id)}`, origin).href;
  return { url, x: `https://twitter.com/intent/tweet?text=${encodeURIComponent('EKO buyer-risk assessment')}&url=${encodeURIComponent(url)}`,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent('EKO buyer-risk assessment')}` };
}
export type ScanView = { result: ScanResult | null; error: boolean; timedOut: boolean; receivedAt: number };
export type ScanRead = (id: string, signal: AbortSignal) => Promise<ScanResult>;
const read: ScanRead = (id, signal) => fetchParsed(`/scan/${encodeURIComponent(id)}`, ScanResultSchema, { signal });
/** Bounded persisted reads. Cleanup aborts both the request and scheduled work. */
export function pollScan(id: string, emit: (view: ScanView) => void, initial: ScanResult | null = null, request: ScanRead = read) {
  const ac = new AbortController(), start = Date.now();
  let view: ScanView = { result: initial, error: false, timedOut: false, receivedAt: start };
  let timer: ReturnType<typeof setTimeout> | undefined, errors = 0;
  const deadline = setTimeout(() => {
    ac.abort(); clearTimeout(timer); view = { ...view, timedOut: true }; emit(view);
  }, 10000);
  const run = async () => {
    try {
      const incoming = await request(id, ac.signal);
      if (ac.signal.aborted) return;
      if (incoming.id !== id) throw new Error('Scan id mismatch');
      // A degraded refresh cannot erase evidence that was already persisted.
      const retain = view.result?.status === 'ready' && (incoming.status !== 'ready' || (!incoming.card && !incoming.guardCard));
      view = { result: retain ? view.result : incoming, error: !!retain, timedOut: false, receivedAt: retain ? view.receivedAt : Date.now() };
      emit(view); errors = 0;
      if (incoming.status !== 'pending') { clearTimeout(deadline); return; }
    } catch {
      if (ac.signal.aborted) return;
      errors++; view = { ...view, error: true }; emit(view);
    }
    const remaining = 10000 - (Date.now() - start);
    if (remaining > 0) timer = setTimeout(() => void run(), Math.min(700 * 2 ** Math.min(errors, 2), remaining));
  };
  void run();
  return () => { ac.abort(); clearTimeout(timer); clearTimeout(deadline); };
}

let submitted: { id: string; result: ScanResult; start: number; indexed: boolean } | null = null;
export async function submitScan(query: string, signal: AbortSignal, request = fetchParsed) {
  if (!validScanQuery(query)) throw new Error('Invalid scan input');
  const start = performance.now();
  const result = await request('/scan', ScanResultSchema, { method: 'POST', body: { query: query.trim() }, signal });
  if (!signal.aborted) submitted = { id: result.id, result, start, indexed: result.status === 'ready' };
  return result;
}
export function submissionFor(id: string) { return submitted?.id === id ? submitted : null; }
export function takeScanTiming(id: string, result: ScanResult) {
  if (submitted?.id !== id || result.status !== 'ready' || (!result.card && !result.guardCard)) return null;
  // A persisted identity/partial card is not a completed verdict latency sample.
  if (result.guardCard?.verdict?.mode === 'active' ? !result.guardCard.verdict.completeness.buyCriticalComplete : !result.card || result.card.verdict.level === 'pending') return null;
  const sample = { metric: scanMetric(submitted.indexed), value: performance.now() - submitted.start };
  submitted = null;
  return sample;
}
