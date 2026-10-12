import { provisionHistory } from '../../../packages/db/test/helpers/historical-db.js';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, toHex, type Hex } from 'viem';
import { binary, hex, migrate, type ChainDb } from '@eko/db';
import { RpcMeter, createMeteredPublicClient } from '@eko/chain';
import { robinhood } from 'viem/chains';
import { openDb, runMigrations, type DbHandle } from '../src/db/client.js';
import { LaunchMonitor } from '../src/obs/launch.js';
import { SecurityCollectors, authorityAbi, type SecurityBindings, type SecurityRpc } from '../src/obs/security-collectors.js';
import { parseSecurityCollectors } from '../src/obs/security-config.js';
import { securityBudgetOpen, workerSecurityCollectors } from '../src/obs/security-worker.js';
import { loadConfig } from '../src/config.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const bindings: SecurityBindings = { registry: addr(1), burn: addr(2), published: [addr(2), addr(3)], weth: addr(4), usdg: addr(5) };
const dead = `0x${'0'.repeat(36)}dead`;
let dbh: DbHandle, db: ChainDb, now: number, monitor: LaunchMonitor;
let blocks: Map<number, { number: Hex; hash: Hex; timestamp: Hex }>, latest: number;
let logs: unknown[], receipts: Map<string, unknown>, committer: Hex, balance: bigint;
let unavailable: ReturnType<typeof vi.fn<(collector: string) => void>>;
let unknownTokenObservation: ReturnType<typeof vi.fn<() => void>>;
let request: ReturnType<typeof vi.fn<(method: string, params: any[]) => Promise<unknown>>>;
beforeAll(async () => { dbh = await openDb({ pgliteDir: ':memory:' }); db = dbh.chain; await runMigrations(dbh); await migrate(db); });
afterAll(async () => { await dbh.close(); });
beforeEach(async () => {
  for (const table of ['security_collector_events', 'security_collector_checkpoints', 'launch_measurements', 'eth_usd_reference_sources', 'swaps', 'pools', 'token_transfers', 'tokens', 'ingest_cursors', 'chain_blocks']) await db.sql.query(`DELETE FROM ${table}`);
  now = Date.UTC(2026, 9, 3); monitor = new LaunchMonitor(db.sql, () => now);
  latest = 10; blocks = new Map(Array.from({ length: 11 }, (_, n) => [n, { number: toHex(n), hash: hash(n + 100), timestamp: toHex(now / 1000 - 10 + n) }]));
  logs = []; receipts = new Map(); committer = addr(9); balance = 5_000_000_000_000_000n; unavailable = vi.fn(); unknownTokenObservation = vi.fn();
  request = vi.fn(async (method: string, params: any[]) => {
    if (method === 'eth_chainId') return toHex(4663);
    if (method === 'eth_getBlockByNumber') return blocks.get(params[0] === 'latest' ? latest : Number(BigInt(params[0]))) ?? null;
    if (method === 'eth_getLogs') return logs;
    if (method === 'eth_getTransactionReceipt') return receipts.get(params[0]) ?? null;
    if (method === 'eth_call') return `0x${'0'.repeat(24)}${committer.slice(2)}`;
    if (method === 'eth_getBalance') return toHex(balance);
    throw new Error('Unexpected fixture RPC');
  });
});
const collector = (input: object, rpc: SecurityRpc = { request }, budget = () => true) => new SecurityCollectors(db, rpc, parseSecurityCollectors(JSON.stringify(input)), bindings, input => monitor.record(input), unavailable, budget, unknownTokenObservation);
const event = (eventName: 'OwnershipTransferStarted' | 'OwnershipTransferred' | 'CommitterChanged', n = 9, logIndex = 0, address = bindings.registry) => ({
  address, blockNumber: toHex(n), blockHash: blocks.get(n)!.hash, transactionHash: hash(n + 200), logIndex: toHex(logIndex), data: '0x',
  topics: encodeEventTopics({ abi: authorityAbi, eventName, args: eventName === 'CommitterChanged' ? { previous: addr(8), next: addr(9) } : { previousOwner: addr(8), newOwner: addr(9) } }),
});
const snapshot = () => monitor.snapshot();
async function indexed(n = latest) {
  const b = blocks.get(n)!;
  await provisionHistory(db,new Date(Number(BigInt(b.timestamp))*1000));
  await db.ensurePartitions(new Date(Number(BigInt(b.timestamp))*1000));
  await db.sql.query('INSERT INTO chain_blocks(number,block,hash,parent_hash,ts) VALUES($1,$1,$2,$3,$4) ON CONFLICT(number) DO UPDATE SET hash=excluded.hash,ts=excluded.ts', [n, binary(b.hash), binary(hash(99 + n)), new Date(Number(BigInt(b.timestamp)) * 1000)]);
  await db.setCursor('head', BigInt(n), b.hash);
}
const walletConfig = (intents: object[] = []) => ({ wallets: { startBlock: 0, burnToken: addr(6), assets: [{ token: addr(6), decimals: 18, maxOutflowRaw: '100' }, { token: addr(7), decimals: 6, maxOutflowRaw: '100' }], intents } });
async function transfer({ token = addr(6), from = bindings.burn, to = addr(8), amount = '101', n = 10, index = 0, tx = hash(400) } = {}) {
  await indexed(n);
  await db.sql.query('INSERT INTO tokens(address,decimals,first_block,block) VALUES($1,$2,0,0) ON CONFLICT(address) DO NOTHING', [binary(token), token === addr(7) ? 6 : 18]);
  await db.sql.query('INSERT INTO token_transfers(ts,block,tx_hash,log_index,token,from_address,to_address,amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [new Date(Number(BigInt(blocks.get(n)!.timestamp)) * 1000), n, binary(tx), index, binary(token), binary(from), binary(to), amount]);
  const log = { address: token, blockNumber: toHex(n), blockHash: blocks.get(n)!.hash, transactionHash: tx, logIndex: toHex(index),
    topics: encodeEventTopics({ abi: parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']), eventName: 'Transfer', args: { from, to: to as Hex } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(amount)]) };
  const existing = receipts.get(tx) as { logs: unknown[] } | undefined;
  receipts.set(tx, { status: '0x1', transactionHash: tx, blockHash: log.blockHash, blockNumber: toHex(n), logs: [...(existing?.logs ?? []), log] });
}
async function unknownTransfers(count: number, n: number) {
  await indexed(n);
  // Arbitrary-token observations need neither wallet authorization nor valid
  // metadata/receipts. Distinct transactions also exercise the receipt-count cap.
  await db.sql.query(`INSERT INTO token_transfers(ts,block,tx_hash,log_index,token,from_address,to_address,amount)
    SELECT $1,$2::bigint,decode(lpad(to_hex($2::bigint * 10000 + i),64,'0'),'hex'),i,$3,
      CASE WHEN i % 2 = 0 THEN $4::bytea ELSE $5::bytea END,$6,1
    FROM generate_series(0,$7::integer - 1) AS i`,
  [new Date(Number(BigInt(blocks.get(n)!.timestamp)) * 1000), n, binary(addr(44)), binary(bindings.burn), binary(addr(3)), binary(addr(8)), count]);
}

describe('registry authority collection', () => {
  it('accepts only exact events from accepted registry, persists cursor and last source timestamps across restart', async () => {
    logs = [event('OwnershipTransferStarted', 9, 0), event('OwnershipTransferred', 9, 1), event('CommitterChanged', 10, 2), event('CommitterChanged', 10, 3, addr(44))];
    await collector({ registry: { startBlock: 0 } }).poll();
    const first = await snapshot();
    expect(first.registry_ownership_started_timestamp_s?.value).toBe(Number(BigInt(blocks.get(9)!.timestamp)));
    expect(first.registry_ownership_transferred_timestamp_s?.value).toBe(first.registry_ownership_started_timestamp_s?.value);
    expect(first.registry_committer_changed_timestamp_s?.value).toBe(now / 1000);
    const points = (await db.sql.query<{ block: string; log_index: number }>('SELECT block,log_index FROM security_collector_checkpoints')).rows;
    expect(points).toEqual([{ block: 10, log_index: 2 }]);
    request.mockClear(); now += 60_000;
    await collector({ registry: { startBlock: 0 } }).poll();
    expect(request.mock.calls.some(([method]) => method === 'eth_getLogs')).toBe(false);
    expect((await snapshot()).registry_committer_changed_timestamp_s?.value).toBe(first.registry_committer_changed_timestamp_s?.value);
    expect(JSON.stringify(await monitor.prometheus(false))).not.toContain(bindings.registry);
  });
  it('records zero only on completed scans; provider failure leaves last samples to expire', async () => {
    const c = collector({ registry: { startBlock: 0 } }); await c.poll();
    expect((await snapshot()).registry_committer_changed_timestamp_s?.value).toBe(0);
    request.mockRejectedValue(new Error('fixture provider credential must stay private'));
    now += 300001; await c.poll();
    expect((await snapshot()).registry_committer_changed_timestamp_s?.state).toBe('unavailable');
    expect(unavailable.mock.calls).toEqual([['registry']]);
  });
  it('does not write measurements before the configured start or during incomplete catchup', async () => {
    await collector({ registry: { startBlock: 11 } }).poll(); expect(await snapshot()).toEqual({});
    latest = 600; blocks.set(499, { number: toHex(499), hash: hash(599), timestamp: toHex(now / 1000) });
    blocks.set(600, { number: toHex(600), hash: hash(700), timestamp: toHex(now / 1000) });
    await collector({ registry: { startBlock: 0 } }).poll(); expect(await snapshot()).toEqual({});
    expect((await db.sql.query('SELECT block FROM security_collector_checkpoints')).rows).toHaveLength(1);
  });
  it('rolls back orphaned evidence and rebuilds canonical observations after a deep reorg', async () => {
    logs = [event('CommitterChanged')]; const c = collector({ registry: { startBlock: 0 } }); await c.poll();
    blocks.set(10, { ...blocks.get(10)!, hash: hash(999) }); logs = [];
    await c.poll();
    expect((await snapshot()).registry_committer_changed_timestamp_s?.value).toBe(0);
    expect((await db.sql.query('SELECT * FROM security_collector_events')).rows).toHaveLength(0);
  });
  it.each(['removed', 'hash', 'malformed'])('rejects %s authority logs without advancing the cursor', async failure => {
    const log = event('CommitterChanged');
    logs = [{ ...log, ...(failure === 'removed' ? { removed: true } : failure === 'hash' ? { blockHash: hash(999) } : { topics: log.topics.slice(0, 1) }) }];
    await collector({ registry: { startBlock: 0 } }).poll();
    expect(await snapshot()).toEqual({}); expect((await db.sql.query('SELECT * FROM security_collector_checkpoints')).rows).toEqual([]);
  });
});

describe('published and burn wallet receipt reconciliation', () => {
  it.each([1, 1001])('rescore proof: %i attacker-token events cannot block configured alarms or cursor advancement, including after restart', async count => {
    await unknownTransfers(count, 10);
    await transfer({ index: count });
    await collector(walletConfig()).poll();
    expect((await snapshot()).burn_unexpected_outflow?.value).toBe(1);
    expect((await snapshot()).published_wallet_unexpected_outflow?.value).toBe(1);
    expect((await db.sql.query('SELECT block,log_index FROM security_collector_checkpoints ORDER BY block')).rows).toEqual([{ block: 10, log_index: count }]);
    expect((await db.sql.query('SELECT evidence FROM security_collector_events')).rows).toEqual([
      { evidence: { token: addr(6), amount: '101', published: true, burn: true, approved: false, wrong: false } },
    ]);
    expect(request.mock.calls.filter(([method]) => method === 'eth_getTransactionReceipt')).toEqual([['eth_getTransactionReceipt', [hash(400)]]]);
    expect(unknownTokenObservation).toHaveBeenCalledTimes(1);
    expect(unavailable).not.toHaveBeenCalled();

    request.mockClear(); now += 60_000;
    const restarted = collector(walletConfig());
    await restarted.poll();
    expect((await snapshot()).burn_unexpected_outflow?.value).toBe(1);
    expect(request.mock.calls.some(([method]) => method === 'eth_getTransactionReceipt')).toBe(false);
    expect((await db.sql.query('SELECT block FROM security_collector_checkpoints')).rows).toEqual([{ block: 10 }]);

    latest = 11;
    blocks.set(11, { number: toHex(11), hash: hash(111), timestamp: toHex(now / 1000) });
    await unknownTransfers(count, 11);
    await transfer({ n: 11, index: count, tx: hash(401) });
    await restarted.poll();
    expect((await snapshot()).burn_unexpected_outflow?.value).toBe(2);
    expect((await snapshot()).published_wallet_unexpected_outflow?.value).toBe(1);
    expect((await db.sql.query('SELECT block,log_index FROM security_collector_checkpoints ORDER BY block')).rows).toEqual([
      { block: 10, log_index: count }, { block: 11, log_index: count },
    ]);
    expect((await db.sql.query('SELECT * FROM security_collector_events')).rows).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === 'eth_getTransactionReceipt')).toEqual([['eth_getTransactionReceipt', [hash(401)]]]);
    expect(unknownTokenObservation).toHaveBeenCalledTimes(3);
    expect(unavailable).not.toHaveBeenCalled();
  });
  it('quarantines an unconfigured former asset as a diagnostic instead of failing wallet monitoring', async () => {
    await transfer();
    const config = walletConfig(); config.wallets.assets.shift();
    await collector(config).poll();
    expect((await snapshot()).burn_unexpected_outflow?.value).toBe(0);
    expect(unknownTokenObservation).toHaveBeenCalledOnce();
    expect(unavailable).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([method]) => method === 'eth_getTransactionReceipt')).toBe(false);
    expect((await db.sql.query('SELECT block FROM security_collector_checkpoints')).rows).toEqual([{ block: 10 }]);
    expect((await db.sql.query('SELECT * FROM security_collector_events')).rows).toEqual([]);
  });
  it.each(['query', 'callback'])('isolates diagnostic %s failures from configured alerts and checkpoints', async failure => {
    await unknownTransfers(1, 10); await transfer({ index: 1 });
    const query = db.sql.query.bind(db.sql);
    const spy = vi.spyOn(db.sql, 'query');
    spy.mockImplementation((sql, params) => {
      if (failure === 'query' && sql.includes('AND NOT (t.token=ANY')) return Promise.reject(new Error('Fixture diagnostic failure'));
      return query(sql, params);
    });
    if (failure === 'callback') unknownTokenObservation.mockImplementation(() => { throw new Error('Fixture diagnostic failure'); });
    try {
      await collector(walletConfig()).poll();
      expect((await snapshot()).burn_unexpected_outflow?.value).toBe(1);
      expect((await snapshot()).published_wallet_unexpected_outflow?.value).toBe(1);
      expect((await db.sql.query('SELECT block FROM security_collector_checkpoints')).rows).toEqual([{ block: 10 }]);
      expect(unavailable.mock.calls).toEqual([['wallet_diagnostics']]);
    } finally { spy.mockRestore(); }
  });
  it('uses exact raw aggregate thresholds and reports unexpected burns and wrong-token burns', async () => {
    await transfer({ from: addr(3), amount: '60', tx: hash(401) });
    await transfer({ from: addr(3), amount: '60', index: 1, tx: hash(402) });
    await transfer({ token: addr(7), to: dead as Hex, index: 2 });
    const c = collector(walletConfig()); await c.poll();
    const s = await snapshot();
    expect(s.published_wallet_unexpected_outflow?.value).toBe(2);
    expect(s.burn_unexpected_outflow?.value).toBe(1); expect(s.burn_wrong_token?.value).toBe(1);
    request.mockClear(); await collector(walletConfig()).poll();
    expect(request.mock.calls.some(([method]) => method === 'eth_getTransactionReceipt')).toBe(false);
  });
  it('requires recorded ritual/bridge intent and enforces its aggregate amount bound', async () => {
    await transfer({ amount: '60' }); await transfer({ amount: '60', index: 1 });
    const intent = { txHash: hash(400), token: addr(6), to: addr(8), maxAmountRaw: '100', purpose: 'bridge' };
    await collector(walletConfig([intent])).poll(); expect((await snapshot()).burn_unexpected_outflow?.value).toBe(2);
    await collector(walletConfig([{ ...intent, maxAmountRaw: '120' }])).poll();
    expect((await snapshot()).burn_unexpected_outflow?.value).toBe(0);
    expect((await snapshot()).published_wallet_unexpected_outflow?.value).toBe(0);
  });
  it.each(['missing receipt', 'orphaned receipt', 'wrong amount', 'malformed log', 'missing decimals', 'conflicting decimals', 'orphaned indexed block'])('stops on %s without a clean zero, including after restart', async failure => {
    await transfer();
    const receipt: any = receipts.get(hash(400));
    if (failure === 'missing receipt') receipts.clear();
    if (failure === 'orphaned receipt') receipt.blockHash = hash(999);
    if (failure === 'wrong amount') receipt.logs[0].data = toHex(1, { size: 32 });
    if (failure === 'malformed log') receipt.logs[0].topics = receipt.logs[0].topics.slice(0, 1);
    if (failure === 'missing decimals') await db.sql.query('UPDATE tokens SET decimals=NULL');
    if (failure === 'conflicting decimals') await db.sql.query('UPDATE tokens SET decimals=6');
    if (failure === 'orphaned indexed block') await db.sql.query('UPDATE chain_blocks SET hash=$1', [binary(hash(999))]);
    await unknownTransfers(1, 9);
    await db.setCursor('head', 10n, blocks.get(10)!.hash);
    for (let attempt = 0; attempt < 2; attempt++) {
      await collector(walletConfig()).poll();
      expect(await snapshot()).toEqual({}); expect(unavailable).toHaveBeenCalledWith('wallets');
      expect((await db.sql.query('SELECT * FROM security_collector_checkpoints')).rows).toEqual([]);
      expect((await db.sql.query('SELECT * FROM security_collector_events')).rows).toEqual([]);
    }
  });
  it('removes orphaned outflows on reorg and retains positive anomalies for the alert window', async () => {
    await transfer(); const c = collector(walletConfig()); await c.poll(); now += 60_000; await c.poll();
    expect((await snapshot()).burn_unexpected_outflow?.value).toBe(1);
    blocks.set(10, { ...blocks.get(10)!, hash: hash(999) }); await indexed(); await db.sql.query('DELETE FROM token_transfers');
    await c.poll(); expect((await snapshot()).burn_unexpected_outflow?.value).toBe(0);
  });
});

async function referencePool(verified: boolean, pool = addr(20), n = 10, fee = 500) {
  await indexed(n); await indexed(1); await db.setCursor('head', BigInt(latest), blocks.get(latest)!.hash);
  await db.sql.query(`INSERT INTO pools(id,venue,currency0,currency1,fee,tick_spacing,created_block,block,creation_verified)
    VALUES($1,'uniswap_v3',$2,$3,$5,10,1,1,$4)`, [binary(pool), binary(bindings.weth), binary(bindings.usdg), verified, fee]);
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,side,amount_coin,amount_quote,price_quote)
    VALUES($1,$2,$3,0,'uniswap_v3',$4,$5,$6,$7,$7,$7,1,1,1,2000)`, [new Date(Number(BigInt(blocks.get(n)!.timestamp)) * 1000), n, binary(hash(n + 500)), binary(pool), binary(bindings.weth), binary(bindings.usdg), binary(addr(8))]);
}
describe('trusted reference timestamp and current committer gas', () => {
  it('binds freshness to the selected tier despite newer canonical secondary swaps, including restart', async () => {
    await referencePool(true, addr(20), 9, 3000); await referencePool(true, addr(21), 10, 500);
    await db.sql.query("INSERT INTO eth_usd_reference_sources(block,pool_id,venue,fee) VALUES(9,$1,'uniswap_v3',3000)", [binary(addr(20))]);
    for (let i = 0; i < 2; i++) {
      await collector({ reference: true }).poll();
      expect((await snapshot()).reference_price_timestamp_s?.value).toBe(Number(BigInt(blocks.get(9)!.timestamp)));
    }
    await db.sql.query('UPDATE eth_usd_reference_sources SET fee=500'); now += 300001;
    await collector({ reference: true }).poll();
    expect(unavailable).toHaveBeenCalledWith('reference');
    expect((await snapshot()).reference_price_timestamp_s?.state).toBe('unavailable');
  });

  it('ignores provisional pools and missing references, then uses source block time across restart', async () => {
    await db.sql.query("INSERT INTO eth_usd_reference_sources(block,pool_id,venue,fee) VALUES(1,$1,'uniswap_v3',500)", [binary(addr(20))]);
    await referencePool(false); await collector({ reference: true }).poll(); expect(await snapshot()).toEqual({});
    await db.sql.query('UPDATE pools SET creation_verified=true'); now += 600000;
    await collector({ reference: true }).poll();
    expect((await snapshot()).reference_price_timestamp_s?.value).toBe(Number(BigInt(blocks.get(10)!.timestamp)));
    expect(request).not.toHaveBeenCalled();
    await db.sql.query('DELETE FROM swaps'); now += 300001; await collector({ reference: true }).poll();
    expect((await snapshot()).reference_price_timestamp_s?.state).toBe('unavailable');
  });
  it('reads chain, registry committer and actual balance at the same canonical block each poll, following rotation', async () => {
    const c = collector({ gas: true }); await c.poll();
    expect((await snapshot()).receipt_committer_balance_eth?.value).toBe(.005);
    expect(request.mock.calls.find(([m]) => m === 'eth_call')?.[1][0].to).toBe(bindings.registry);
    expect(request.mock.calls.find(([m]) => m === 'eth_getBalance')?.[1]).toEqual([committer, { blockHash: blocks.get(latest)!.hash, requireCanonical: true }]);
    committer = addr(11); balance = 0n; request.mockClear(); await c.poll();
    expect(request.mock.calls.find(([m]) => m === 'eth_getBalance')?.[1][0]).toBe(addr(11));
    expect((await snapshot()).receipt_committer_balance_eth?.value).toBe(0);
    expect(await monitor.prometheus(false)).not.toContain(committer);
  });
  it.each(['wrong chain', 'zero committer', 'balance failure', 'reorg'])('does not refresh gas observations on %s', async failure => {
    const c = collector({ gas: true }); await c.poll(); now += 300001;
    const normal = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (failure === 'wrong chain' && method === 'eth_chainId') return '0x1';
      if (failure === 'zero committer' && method === 'eth_call') return `0x${'0'.repeat(64)}`;
      if (failure === 'balance failure' && method === 'eth_getBalance') throw new Error('fixture failure');
      if (failure === 'reorg' && method === 'eth_getBalance') blocks.set(10, { ...blocks.get(10)!, hash: hash(888) });
      return normal(method, params);
    });
    await c.poll(); expect((await snapshot()).receipt_committer_balance_eth?.state).toBe('unavailable');
  });
});

describe('configuration, worker lease boundary and RPC metering', () => {
  it('disables all collectors by default and rejects configuration without recorded thresholds', async () => {
    await collector({}).poll(); expect(request).not.toHaveBeenCalled(); expect(await snapshot()).toEqual({});
    expect(() => parseSecurityCollectors('{"wallets":{"startBlock":0,"assets":[]}}')).toThrow('Invalid SECURITY_COLLECTORS');
    expect(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'fixture-secret' }).SECURITY_COLLECTORS).toEqual({ reference: false, gas: false });
    expect(() => workerSecurityCollectors({ cfg: { APP_ROLE: 'api' } } as never)).toThrow('worker role');
  });
  it.each(['RPC_SESSION_BUDGET', 'RPC_PAID_DAILY_BUDGET'])('zero %s spends nothing and leaves observations unavailable', async name => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const meter = new RpcMeter({ RPC_HTTP_URL: 'https://rpc.eko.example', [name]: '0' }, { store: dbh.rpcUsage, onSessionBudget: () => {} });
    const client = createMeteredPublicClient(meter, robinhood);
    try {
      const c = collector({ gas: true, registry: { startBlock: 0 } }, { request: (method, params) => client.request({ method, params } as never) }, () => securityBudgetOpen(meter));
      await c.poll(); expect(fetch).not.toHaveBeenCalled(); expect(await snapshot()).toEqual({});
      expect(unavailable.mock.calls).toEqual([['registry'], ['gas']]);
    } finally { await meter.close(); vi.unstubAllGlobals(); }
  });
  it('closed worker budget prevents even local reference refresh and any RPC attempt', async () => {
    await referencePool(true);
    await collector({ reference: true, gas: true }, { request }, () => false).poll();
    expect(request).not.toHaveBeenCalled(); expect(await snapshot()).toEqual({}); expect(unavailable.mock.calls).toEqual([['reference'], ['gas']]);
  });
});
