import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import type { ReceiptBatch } from '@eko/db';
import type { ReceiptChain } from '../src/receipts/worker.js';

const fixture = vi.hoisted(() => ({ key: '' as Hex, chain: undefined as ReceiptChain | undefined,
  closed: vi.fn(), drain: vi.fn(), meterClose: vi.fn(), readContract: vi.fn(), getCode: vi.fn(),
  prepare: vi.fn(), broadcast: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: (...args: Parameters<typeof original.readFile>) =>
    args[0] === 'fixture-key-file' ? Promise.resolve(fixture.key) : original.readFile(...args) };
});
vi.mock('@eko/chain', async () => ({
  withRpcOrigin: (await import('../../../packages/chain/src/rpc/origin.js')).withRpcOrigin,
  loadRegistry: () => ({ requireAddress: () => `0x${'ab'.repeat(20)}` }),
  createMeteredClients: () => ({ paid: { readContract: fixture.readContract, getCode: fixture.getCode,
    sendRawTransaction: fixture.broadcast }, meter: { close: fixture.meterClose } }),
}));
vi.mock('@eko/db', () => ({
  openDb: async () => ({ close: fixture.closed }), migrate: vi.fn(), migrateEngines: vi.fn(),
  launchEmitter: () => ({ emit: vi.fn(), drain: fixture.drain }),
  ReceiptCommitJournal: class {},
}));
vi.mock('viem/actions', () => ({ prepareTransactionRequest: fixture.prepare }));
vi.mock('../src/receipts/worker.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/receipts/worker.js')>();
  return { ...original, ReceiptWorker: class {
    constructor(_journal: unknown, chain: ReceiptChain) { fixture.chain = chain; }
    stop() {}
    async run() {}
  } };
});
let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
  fixture.chain = undefined;
  vi.clearAllMocks();
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.stubEnv('APP_ROLE', 'receipts');
  vi.stubEnv('RPC_HTTP_URL', 'https://rpc.example');
  vi.stubEnv('RECEIPTS_COMMITTER_KEY', generatePrivateKey());
  vi.stubEnv('RECEIPTS_COMMITTER_KEY_FILE', '');
  fixture.getCode.mockResolvedValue('0x1234');
  fixture.prepare.mockResolvedValue({ nonce: 7, gas: 200000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
});
afterEach(() => { process.exitCode = exitCode; vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const batch: ReceiptBatch = { id: `0x${'11'.repeat(32)}`, root: `0x${'22'.repeat(32)}`,
  items: [{ id: 'fixture-item', kind: 'verdict', hash: `0x${'33'.repeat(32)}` }], proofs: [[]],
  through: '2026-10-02T00:05:00.000Z' };
async function start() {
  await import('../src/receipts/cli.js');
  await vi.waitFor(() => expect(fixture.closed).toHaveBeenCalledOnce());
  expect(fixture.chain).toBeDefined();
  return fixture.chain!;
}

describe('receipt role signer (synthetic keys, injected RPC/database, no network)', () => {
  it('rejects missing, ambiguous and malformed secret sources before opening a database', async () => {
    for (const [key, file] of [['', ''], ['invalid', ''], [generatePrivateKey(), 'fixture-key-file']] as const) {
      vi.stubEnv('RECEIPTS_COMMITTER_KEY', key); vi.stubEnv('RECEIPTS_COMMITTER_KEY_FILE', file);
      vi.resetModules();
      const exits = vi.mocked(process.exit).mock.calls.length;
      await import('../src/receipts/cli.js');
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledTimes(exits + 1));
      expect(process.exit).toHaveBeenLastCalledWith(1);
      expect(fixture.closed).not.toHaveBeenCalled(); expect(fixture.chain).toBeUndefined();
      expect(console.error).toHaveBeenLastCalledWith('Receipts halted: check role, committer secret, registry, metered RPC and database.');
      process.exitCode = exitCode;
    }
  });
  it('refuses a rotated/wrong committer before transaction preparation or broadcast', async () => {
    fixture.readContract.mockResolvedValue(privateKeyToAccount(generatePrivateKey()).address);
    const chain = await start();
    await expect(chain.sign(batch)).rejects.toThrow('Committer rotation requires secret reload');
    expect(fixture.prepare).not.toHaveBeenCalled(); expect(fixture.broadcast).not.toHaveBeenCalled();
  });
  it('refuses absent registry code before transaction preparation or broadcast', async () => {
    fixture.readContract.mockResolvedValue(privateKeyToAccount(process.env.RECEIPTS_COMMITTER_KEY as Hex).address);
    const chain = await start();
    for (const code of [undefined, '0x']) {
      fixture.getCode.mockResolvedValue(code);
      await expect(chain.sign(batch)).rejects.toThrow('Receipt registry code unavailable');
    }
    expect(fixture.prepare).not.toHaveBeenCalled(); expect(fixture.broadcast).not.toHaveBeenCalled();
  });
  it('signs only the zero-value registry commit on chain 4663 and reloads rotations for fresh attempts', async () => {
    fixture.key = generatePrivateKey();
    vi.stubEnv('RECEIPTS_COMMITTER_KEY', ''); vi.stubEnv('RECEIPTS_COMMITTER_KEY_FILE', 'fixture-key-file');
    const chain = await start();
    for (let i = 0; i < 2; i++) {
      // Mounted fixture files are re-read for fresh attempts after rotation.
      fixture.key = generatePrivateKey();
      const signer = privateKeyToAccount(fixture.key);
      fixture.readContract.mockResolvedValue(signer.address);
      const attempt = await chain.sign(batch);
      const tx = parseTransaction(attempt.raw_transaction);
      expect(tx).toMatchObject({ chainId: 4663, to: `0x${'ab'.repeat(20)}`, nonce: 7 });
      expect(tx.value ?? 0n).toBe(0n);
      expect(tx.data).toBe((await import('../src/receipts/worker.js')).commitData(batch));
      expect(await recoverTransactionAddress({ serializedTransaction: attempt.raw_transaction as Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction'] })).toBe(signer.address);
      expect(attempt).toMatchObject({ committer: signer.address, nonce: '7', tx_hash: keccak256(attempt.raw_transaction), batch_id: batch.id });
      expect(fixture.prepare).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ value: 0n, to: `0x${'ab'.repeat(20)}` as Address }));
    }
    expect(fixture.broadcast).not.toHaveBeenCalled();
  });
});
