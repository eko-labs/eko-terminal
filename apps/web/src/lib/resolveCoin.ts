import { VerdictSchema, type Verdict } from '@eko/shared';
import { fetchParsed } from './api';

/**
 * A pasted address opens its page at once (RESOLVE_MS 0: speed first), but the search boxes start asking for the coin's
 * verdict as they navigate (components/shell/Shell.tsx ScanBox, Simple's CoinSearch). The answer is kept for the coin
 * page (useCoin takes it once), so the page shows it as soon as it lands and does not ask again; one older than 15 s
 * is asked for afresh. The coin page shows its own LED loading state meanwhile.
 */
export const RESOLVE_MS = 0;
const primed = new Map<string, { at: number; job: Promise<Verdict> }>();
export function primeCoin(address: string): Promise<Verdict> {
  const job = fetchParsed(`/coins/${encodeURIComponent(address)}/verdict`, VerdictSchema);
  job.catch(() => undefined);
  primed.set(address.toLowerCase(), { at: Date.now(), job });
  return job;
}
export function takePrimed(address: string): Promise<Verdict> | undefined {
  const key = address.toLowerCase(), hit = primed.get(key);
  primed.delete(key);
  return hit && Date.now() - hit.at < 15_000 ? hit.job : undefined;
}
export async function resolveAddress(address: string, ms = RESOLVE_MS): Promise<void> {
  await Promise.race([primeCoin(address).then(() => undefined, () => undefined), new Promise<void>((done) => setTimeout(done, ms))]);
}
export const checkingLabel = (address: string) => `Checking ${address.slice(0, 6)}…`;
