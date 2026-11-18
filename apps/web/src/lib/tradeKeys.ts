/**
 * Trade helpers with no wallet dependency, so pages that only build trade state (the radar, new pairs) do not load the
 * wallet code (wagmi, viem) that lib/trade.ts pulls in.
 */
export function newIdempotencyKey() {
  return `ik_${crypto.randomUUID()}`;
}

/** The user declined in their wallet (EIP-1193 4001 or a wallet's own wording), however deep the cause chain goes. */
export function isUserRejection(err: unknown): boolean {
  const e = err as { name?: string; code?: number; shortMessage?: string; message?: string; cause?: unknown };
  if (e?.name === 'UserRejectedRequestError' || e?.code === 4001) return true;
  if (/user (rejected|denied)|rejected the request/i.test(e?.shortMessage ?? e?.message ?? '')) return true;
  return e?.cause ? isUserRejection(e.cause) : false;
}
