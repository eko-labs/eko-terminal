import { AsyncLocalStorage } from 'node:async_hooks';
export type RpcWork = 'routine' | 'first_rating' | 'crash';
const scope = new AsyncLocalStorage<{ origin: string; work: RpcWork }>();
export const rpcScope = () => scope.getStore();
/** Caller-owned labels contain only static code-path names, never request data. */
export function withRpcOrigin<T>(origin: string, run: () => T, work: RpcWork = scope.getStore()?.work ?? 'routine'): T {
  if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(origin)) throw new Error('Invalid RPC origin');
  return scope.run({ origin, work }, run);
}
/** Preserve all viem methods and optional batch readers while labelling their async work. */
export function rpcOriginClient<T extends object>(client: T, origin: string): T {
  return new Proxy(client, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? (...args: unknown[]) => {
      const input=args[0] as {functionName?:unknown} | undefined;
      const getter=key==='readContract' && typeof input?.functionName==='string' && /^[a-zA-Z0-9_]+$/.test(input.functionName) ? `.${input.functionName}` : '';
      return withRpcOrigin(`${scope.getStore()?.origin ?? origin}.${String(key)}${getter}`, () => value.apply(target, args));
    } : value;
  } });
}
