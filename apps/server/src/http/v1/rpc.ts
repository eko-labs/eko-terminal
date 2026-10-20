import { withRpcOrigin } from '@eko/chain';
import type { FastifyInstance } from 'fastify';
import type { PublicClient } from 'viem';
import { z } from 'zod';
import { addressKey } from '../address-limit.js';

export const RPC_BODY_LIMIT = 16 * 1024;
export const READ_RPC_METHODS = [
  'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_feeHistory',
  'eth_call', 'eth_getBalance', 'eth_getCode', 'eth_estimateGas', 'eth_gasPrice',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt',
] as const;

const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/).max(66);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const data = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(8194);
const latest = z.literal('latest');
// TODO(spec): CA-25 omits numeric resource bounds. Use 16 KiB bodies, 4 KiB
// calldata, 5M call/estimate gas, and at most 1024 fee-history blocks/100 percentiles.
const gas = quantity.refine(value => BigInt(value) > 0n && BigInt(value) <= 5_000_000n);
const transaction = z.object({
  from: address.optional(), to: address, data: data.optional(), input: data.optional(),
  value: quantity.optional(), gas: gas.default('0x4c4b40'), gasPrice: quantity.optional(),
  maxFeePerGas: quantity.optional(), maxPriorityFeePerGas: quantity.optional(),
  nonce: quantity.optional(), type: z.enum(['0x0', '0x1', '0x2']).optional(),
  accessList: z.array(z.object({ address, storageKeys: z.array(hash).max(64) }).strict()).max(64).optional(),
}).strict().refine(tx => !(tx.data !== undefined && tx.input !== undefined));
const envelope = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.number().int().safe(), z.string().min(1).max(128)]),
  method: z.string().max(64), params: z.array(z.unknown()).max(3).default([]),
}).strict();
const params = {
  eth_chainId: z.tuple([]), eth_blockNumber: z.tuple([]), eth_gasPrice: z.tuple([]),
  eth_getBlockByNumber: z.tuple([latest, z.boolean()]),
  eth_feeHistory: z.tuple([
    quantity.refine(value => BigInt(value) > 0n && BigInt(value) <= 1024n), latest,
    z.array(z.number().finite().min(0).max(100)).max(100).refine(values => values.every((v, i) => i === 0 || v >= values[i - 1]!)),
  ]),
  eth_getBalance: z.tuple([address, latest]), eth_getCode: z.tuple([address, latest]),
  eth_getTransactionByHash: z.tuple([hash]), eth_getTransactionReceipt: z.tuple([hash]),
  eth_call: z.union([
    z.tuple([transaction, latest]),
    z.tuple([transaction, latest, z.record(z.string(), z.unknown())]),
  ]).transform(values => values.slice(0, 2)),
  eth_estimateGas: z.union([z.tuple([transaction]), z.tuple([transaction, latest])]),
} satisfies Record<(typeof READ_RPC_METHODS)[number], z.ZodType>;

const error = (id: string | number | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Accept only method/validated params; HTTP headers, cookies and provider errors never cross this boundary.
 * @remarks
 * Register public bounded read-only chain-4663 RPC POST with an explicit method/parameter
 * allowlist, one request at a time and per-IP rate limits. No wallet authentication.
 * Invalid/oversized/rate-limited requests reject; provider failure returns fixed 503 text. Caller
 * headers/cookies and state overrides are not forwarded.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function rpcRoutes(app: FastifyInstance, client: PublicClient) {
  if (client.chain?.id !== 4663) throw new Error('Read RPC requires chain 4663');
  app.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.status(429).send(error(null, -32005, 'Rate limit exceeded'));
    return reply.status(status === 413 ? 413 : 400).send(error(null, -32600, 'Invalid request'));
  });
  app.post('/rpc', {
    bodyLimit: RPC_BODY_LIMIT,
    config: { rateLimitKeyKind: 'address', rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: req => addressKey(req.ip) } },
  }, async (req, reply) => {
    // TODO(spec): CA-25 does not specify batching or notifications. Reject both;
    // a request always admits at most one metered call and receives one response.
    const parsed = envelope.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(error(null, -32600, 'Invalid request'));
    const { id, method } = parsed.data;
    if (!Object.hasOwn(params, method)) return reply.status(400).send(error(id, -32601, 'Method not allowed'));
    const methodName = method as keyof typeof params;
    const validated = params[methodName].safeParse(parsed.data.params);
    if (!validated.success) return reply.status(400).send(error(id, -32602, 'Invalid params'));
    try {
      const result = await withRpcOrigin('server.rpc.rawL81',()=>client.request({ method: methodName, params: validated.data } as never, { dedupe: false }));
      if (methodName === 'eth_chainId' && result !== '0x1237') throw new Error('Unexpected chain');
      return { jsonrpc: '2.0', id, result };
    } catch {
      // Fixed error text: provider messages/causes can contain URLs, credentials and calldata.
      return reply.status(503).send(error(id, -32000, 'Read RPC unavailable'));
    }
  });
}
