export type Provider = 'paid' | 'public';
export type RpcRequest = { method: string; params?: readonly unknown[] };
export type RouteContext = 'default' | 'backfill' | 'archive' | 'public' | 'head' | 'head_timestamp' | 'parent' | 'enrich' | 'fork';
/** A conservative public capability list; unknown methods never spend via fallback. */
export const publicMethods = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getBlockReceipts', 'eth_getLogs', 'eth_call', 'eth_getCode', 'eth_getStorageAt',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_estimateGas',
  'eth_subscribe', 'eth_unsubscribe',
]);
export const rpcRoutes = [
  { name: 'on-demand sender enrichment', provider: 'public', matches: (_r: RpcRequest, c: RouteContext) => c === 'enrich' },
  { name: 'public-only network', provider: 'public', matches: (_r: RpcRequest, c: RouteContext) => c === 'public' },
  { name: 'live head, logs and receipts', provider: 'public', matches: (r: RpcRequest, c: RouteContext) => c === 'head' && ['eth_blockNumber', 'eth_getLogs', 'eth_getBlockReceipts'].includes(r.method) },
  { name: 'head timestamp recovery', provider: 'public', matches: (r: RpcRequest, c: RouteContext) => c === 'head_timestamp' && r.method === 'eth_getBlockByNumber' },
  // Reorg-window parent links: public first, paid only when public fails (no spill while public is merely busy).
  { name: 'parent headers', provider: 'public', matches: (r: RpcRequest, c: RouteContext) => c === 'parent' && r.method === 'eth_getBlockByNumber' },
  { name: 'historical logs', provider: 'public', matches: (r: RpcRequest, c: RouteContext) => c === 'backfill' && r.method === 'eth_getLogs' },
  { name: 'archive and traces', provider: 'paid', matches: (r: RpcRequest, c: RouteContext) => archiveOnly(r, c) },
  { name: 'head blocks, receipts, newHeads', provider: 'paid', matches: (r: RpcRequest) => ['eth_getBlockByNumber', 'eth_getBlockReceipts', 'eth_subscribe'].includes(r.method) },
  { name: 'other reads', provider: 'paid', matches: () => true },
] as const;
const stateIndex: Record<string, number> = { eth_call: 1, eth_getCode: 1, eth_getStorageAt: 2, eth_getBalance: 1, eth_getTransactionCount: 1 };
export function archiveOnly(request: RpcRequest, context: RouteContext = 'default'): boolean {
  if (context === 'fork' || /^(debug_|trace_)/.test(request.method)) return true;
  const i = stateIndex[request.method];
  if (i === undefined) return false;
  const block = request.params?.[i];
  // TODO(spec): Define a verified freshness cutoff for explicit block selectors.
  // Until then, pinned state may be outside the public RPC's short retention and requires paid archive.
  return context !== 'enrich' && (context === 'archive' || (block != null && !['latest', 'pending', 'safe', 'finalized'].includes(String(block))));
}
export const routeRequest = (r: RpcRequest, c: RouteContext = 'default'): Provider => rpcRoutes.find(route => route.matches(r, c))!.provider;
export const supportsPublic = (r: RpcRequest, c: RouteContext = 'default') => !archiveOnly(r, c) && publicMethods.has(r.method);
