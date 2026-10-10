import { z } from 'zod';

const hops = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// TODO(spec): BACKEND §9.4/§20 do not define ingress topology; default to the socket peer.
export const TrustProxyHopsSchema = z.string().regex(/^\d+$/).default('0').transform(Number).pipe(hops);

/** Trust exactly this many hops from the socket outward. Deployment must prevent shorter ingress paths. */
export function proxyTrust(hopCount: number): false | ((address: string, hop: number) => boolean) {
  const count = hops.parse(hopCount);
  return count === 0 ? false : (_address, hop) => hop < count;
}
