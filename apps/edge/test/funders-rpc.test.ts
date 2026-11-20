import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { RpcFunding } from '../src/funders-rpc.js';
import { FunderTracer } from '../src/funders.js';
import { HistoryStore } from '../src/history.js';
import type { Rpc } from '../src/tracker.js';

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const W = A(0xbeef), FUNDER = A(0xf00d), DISPERSE = A(0xd15e), SENDER = A(0x5e4d);
const HEAD = 1_000_000;

/**
 * A chain where the wallet's balance and nonce follow `history` (block → state from that block on), with `blocks`
 * holding the transactions and call traces of the blocks the test cares about.
 */
function chain(history: [number, { balance: bigint; nonce: number }][], blocks: Record<number, { txs: { hash: string; from: string; to: string | null; value: bigint }[]; traces?: unknown[] }> = {}) {
  const methods: string[] = [];
  const stateAt = (b: number) => { let s = { balance: 0n, nonce: 0 }; for (const [at, v] of history) if (b >= at) s = v; return s; };
  const rpc: Rpc = {
    async request({ method, params }) {
      methods.push(method);
      const b = (i: number) => Number(BigInt(params[i] as string));
      switch (method) {
        case 'eth_blockNumber': return `0x${HEAD.toString(16)}`;
        case 'eth_getBalance': return params[0] === W ? `0x${stateAt(b(1)).balance.toString(16)}` : '0x0';
        case 'eth_getTransactionCount': return params[0] === W ? `0x${stateAt(b(1)).nonce.toString(16)}` : '0x0';
        case 'eth_getBlockByNumber': { const blk = blocks[b(0)] ?? { txs: [] };
          return { timestamp: `0x${(1_700_000_000 + b(0)).toString(16)}`, transactions: blk.txs.map(t => ({ ...t, value: `0x${t.value.toString(16)}` })) }; }
        case 'debug_traceBlockByNumber': return blocks[b(0)]?.traces ?? [];
        default: throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { rpc, methods };
}
const fast = (rpc: Rpc) => new RpcFunding(rpc, { perMin: 1_000_000, sleep: async () => {} });

describe('funders from an archive RPC (chains without an explorer API)', () => {
  it('finds the block the wallet was first paid and the sender of the transaction that paid it', async () => {
    const { rpc, methods } = chain([[612_345, { balance: 5n, nonce: 0 }], [700_000, { balance: 3n, nonce: 1 }]],
      { 612_345: { txs: [{ hash: '0xaa', from: A(1), to: A(2), value: 9n }, { hash: '0xbb', from: FUNDER, to: W, value: 5n }] } });
    expect(await fast(rpc).find(W)).toEqual({ funder: getAddress(FUNDER), fundedTs: 1_700_612_345, fundedBlock: 612_345, tx: '0xbb' });
    expect(methods.length).toBeLessThanOrEqual(2 + 2 * 20 + 1); // head, a binary search over a million blocks, the block
    expect(methods).not.toContain('debug_traceBlockByNumber');
  });

  it('still finds the first funding when the wallet later spent everything (its nonce stays above zero)', async () => {
    const { rpc } = chain([[50, { balance: 1n, nonce: 0 }], [60, { balance: 0n, nonce: 1 }]], { 50: { txs: [{ hash: '0xcc', from: FUNDER, to: W, value: 1n }] } });
    expect((await fast(rpc).find(W))?.fundedBlock).toBe(50);
  });

  it('credits the sender of a transaction that paid the wallet through a contract, skipping calls that failed', async () => {
    const traces = [
      { txHash: '0x01', result: { from: A(7), to: DISPERSE, value: '0x9', calls: [{ from: DISPERSE, to: W, value: '0x9', error: 'reverted' }] } },
      { txHash: '0x02', result: { from: SENDER, to: DISPERSE, value: '0x5', calls: [{ from: DISPERSE, to: A(3), value: '0x1' }, { from: DISPERSE, to: A(4), calls: [{ from: A(4), to: W, value: '0x4' }] }] } },
    ];
    const { rpc } = chain([[900, { balance: 4n, nonce: 0 }]], { 900: { txs: [{ hash: '0x01', from: A(7), to: DISPERSE, value: 9n }, { hash: '0x02', from: SENDER, to: DISPERSE, value: 5n }], traces } });
    expect(await fast(rpc).find(W)).toMatchObject({ funder: getAddress(SENDER), fundedBlock: 900, tx: '0x02' });
  });

  it('credits the contract, not the stranger whose transaction triggered it, when the sender put in less than the wallet got', async () => {
    const PAD = A(0x9ad);
    const traces = [{ txHash: '0x03', result: { from: SENDER, to: PAD, value: '0x0', calls: [{ from: PAD, to: W, value: '0x7' }] } }];
    const { rpc } = chain([[901, { balance: 7n, nonce: 0 }]], { 901: { txs: [{ hash: '0x03', from: SENDER, to: PAD, value: 0n }], traces } });
    expect(await fast(rpc).find(W)).toMatchObject({ funder: getAddress(PAD), tx: '0x03' });
  });

  it('answers null for a wallet nothing ever paid, after one check of the head', async () => {
    const { rpc, methods } = chain([]);
    expect(await fast(rpc).find(W)).toBeNull();
    expect(methods).toEqual(['eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount']);
  });

  it('records a funding with no visible payer as traced with no funder', async () => {
    const { rpc } = chain([[0, { balance: 10n, nonce: 0 }]]);
    expect(await fast(rpc).find(W)).toEqual({ funder: null, fundedTs: 1_700_000_000, fundedBlock: 0, tx: null });
  });

  it('spaces its calls to the per-minute budget', async () => {
    const { rpc } = chain([[612_345, { balance: 5n, nonce: 0 }]], { 612_345: { txs: [{ hash: '0xbb', from: FUNDER, to: W, value: 5n }] } });
    let clock = 0; const waits: number[] = [];
    const funding = new RpcFunding(rpc, { perMin: 120, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
    await funding.find(W);
    expect(clock).toBe((funding.calls - 1) * 500); // 120 a minute: one every 500 ms
    expect(waits.every(ms => ms <= 500)).toBe(true);
  });

  it('throws when the chain cannot be read, so the tracer retries later instead of storing "no funder"', async () => {
    const funding = fast({ request: async () => { throw new Error('Unknown state'); } });
    await expect(funding.find(W)).rejects.toThrow('Unknown state');
    const store = new HistoryStore(':memory:');
    const tracer = new FunderTracer(funding.find, store, { concurrency: 1 });
    await tracer.trace(W);
    expect(store.funder(W)).toBeUndefined();
    expect(tracer.counters).toEqual({ traced: 0, failures: 1 });
    store.close();
  });
});

describe('funder tracer on a slow source', () => {
  it('takes the deployer and the first buyers of each launch, deployer first, and lets every Nth trace serve a lookup', async () => {
    const store = new HistoryStore(':memory:'), order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const tracer = new FunderTracer(async (w) => { order.push(w); await gate; return null; }, store, { concurrency: 1, livePerWant: 3, lookupEvery: 2 });
    tracer.want([A(0x100)]); // occupies the one slot
    tracer.want([A(0xd1), A(0xb1), A(0xb2), A(0xb3), A(0xb4)]);
    tracer.want([A(0xe1), A(0xe2)], 'lookup');
    expect(tracer.pending).toBe(3 + 2); // the deployer and two buyers; the two lookups
    release();
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    expect(order).toEqual([A(0x100), A(0xd1), A(0xe1), A(0xb1), A(0xe2), A(0xb2)]);
    store.close();
  });

  it('keeps lookups behind live work when no share is set', async () => {
    const store = new HistoryStore(':memory:'), order: string[] = [];
    const tracer = new FunderTracer(async (w) => { order.push(w); return null; }, store, { concurrency: 1 });
    tracer.want([A(0x100)]);
    tracer.want([A(0xe1)], 'lookup');
    tracer.want([A(0xd1), A(0xb1)]);
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    expect(order).toEqual([A(0x100), A(0xd1), A(0xb1), A(0xe1)]);
    store.close();
  });
});
