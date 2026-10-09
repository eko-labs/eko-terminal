import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { binary, ScanJobs } from '@eko/db';
import { BagReportSchema, PublicBagReportSchema, type Address, type CoinCard } from '@eko/shared';
import { eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accounts, bagShares } from '../src/db/schema.js';
import { BagsService, roundSharedBalance } from '../src/read/bags.js';
import { createDemoToken } from '../src/http/v1/demo.js';
import { seedReadFixture, sampleAddress } from './read-fixture.js';

const origin = 'https://app.eko.example';
const placeholder = 'test-only-placeholder'.repeat(2);
let built: Awaited<ReturnType<typeof buildApp>>, card: CoinCard;
const balance = vi.fn(async (_input: unknown) => 123456789012345678901234567890n);
const chain = () => built.ctx.dbh.chain;
const client = () => built.ctx.chains.get('robinhood-mainnet');
beforeAll(async () => {
  built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: placeholder,
    DEMO_SECRET: placeholder, LEGACY_API: 'false', PUBLIC_ORIGIN: origin, RUN_WORKER: 'false', MARKET_DATA_SOURCE: 'onchain' }), { startBackground: false });
  card = await seedReadFixture(chain());
  vi.spyOn(client(), 'readContract').mockImplementation(balance as never);
});
afterAll(async () => { vi.restoreAllMocks(); await built.close(); });
async function owner(n: number, kind: 'wallet' | 'guest' = 'wallet') {
  const wallet = sampleAddress(n);
  const [account] = await built.ctx.dbh.db.insert(accounts).values({ kind, ...(kind === 'wallet' ? { walletAddress: wallet } : {}) }).returning();
  const token = await built.ctx.auth.createSession(account!.id);
  return { id: account!.id, wallet, cookie: `eko_sid=${encodeURIComponent(built.app.signCookie(token))}` };
}
async function holding(wallet: Address, token = card.identity.address, decimals: number | null = 18) {
  await chain().sql.query('UPDATE tokens SET decimals=$2 WHERE address=$1', [binary(token), decimals]);
  await chain().sql.query('INSERT INTO balances(token,holder,amount,last_block) VALUES($1,$2,100,$3) ON CONFLICT(token,holder) DO NOTHING', [binary(token), binary(wallet), card.freshness.block]);
}
const get = (wallet: Address, cookie?: string, query = '') => built.app.inject({ url: `/v1/wallets/${wallet}/bags${query}`, headers: cookie ? { cookie } : {} });
const share = (wallet: Address, cookie: string, payload: object, from: string | null = origin) => built.app.inject({ method: 'POST', url: `/v1/wallets/${wallet}/bags/share`, headers: { cookie, ...(from ? { origin: from } : {}) }, payload });
const publicGet = (id: string, cookie?: string) => built.app.inject({ url: `/v1/bags/${id}`, headers: cookie ? { cookie } : {} });
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; messages: unknown[] = [];
  send(value: string) { this.messages.push(JSON.parse(value)); }
  close() { this.emit('close'); }
}

describe('private bags and persisted public snapshots (offline fixtures)', () => {
  it('requires wallet authentication and refuses foreign wallets before any RPC or scans', async () => {
    const a = await owner(10901), b = await owner(10902), guest = await owner(10903, 'guest');
    await holding(a.wallet);
    balance.mockClear();
    const jobs = (await chain().sql.query('SELECT id FROM scan_jobs')).rows.length;
    for (const cookie of [undefined, guest.cookie, 'eko_sid=invalid']) {
      const result = await get(a.wallet, cookie); expect(result.statusCode).toBe(401); expect(result.json().error).toBe('wallet_auth_required');
      expect(result.headers['cache-control']).toBe('private, no-store');
    }
    expect((await get(a.wallet, b.cookie)).statusCode).toBe(403);
    expect((await share(a.wallet, b.cookie, {})).statusCode).toBe(403);
    expect(balance).not.toHaveBeenCalled();
    expect((await chain().sql.query('SELECT id FROM scan_jobs')).rows).toHaveLength(jobs);
    const result = await get(a.wallet.toUpperCase().replace('0X', '0x') as Address, a.cookie);
    expect(result.statusCode).toBe(200); expect(BagReportSchema.parse(result.json()).wallet).toBe(a.wallet);
  });
  it('pins balanceOf reads, omits unknown totals, keeps unavailable exit cost and removes confirmed zero balances', async () => {
    const a = await owner(10904); await holding(a.wallet);
    balance.mockClear();
    await chain().sql.query('DELETE FROM bars_1m WHERE coin=$1', [binary(card.identity.address)]);
    const result = BagReportSchema.parse((await get(a.wallet, a.cookie)).json());
    expect(balance.mock.calls[0]![0]).toMatchObject({ functionName: 'balanceOf', args: [a.wallet], blockNumber: BigInt(result.asOfBlock) });
    expect(result.holdings[0]).toMatchObject({ balance: '123456789012.34567890123456789', balanceStatus: 'observed', status: 'ready', exitCost1kPct: null });
    expect(result.holdings[0].unavailable).toContain('value'); expect(result.summary.valueUsd).toBeUndefined();
    balance.mockRejectedValueOnce(new Error(`rpc diagnostics ${a.wallet}`));
    const failed = await get(a.wallet, a.cookie);
    expect(failed.body).not.toContain('rpc diagnostics');
    expect(failed.json().holdings[0]).toMatchObject({ balance: null, balanceStatus: 'error', error: 'balance_unavailable' });
    expect(failed.json().summary.valueUsd).toBeUndefined();
    const recovered = (await get(a.wallet, a.cookie)).json(); expect(recovered.holdings[0].balanceStatus).toBe('observed');
    balance.mockResolvedValueOnce(0n); expect((await get(a.wallet, a.cookie)).json().holdings).toEqual([]);
    await holding(a.wallet, card.identity.address, null);
    balance.mockClear(); const unknown = (await get(a.wallet, a.cookie)).json();
    expect(balance).not.toHaveBeenCalled(); expect(unknown.holdings[0]).toMatchObject({ balance: null, balanceStatus: 'unavailable' });
    await holding(a.wallet);
  });
  it('queues missing cards with unknown balances, deduplicates, explicitly retries failed scans and progresses after card persistence', async () => {
    const a = await owner(10905), token = sampleAddress(10950);
    await chain().insert('tokens', { address: binary(token), name: '<script>Sample</script>', symbol: 'DEMO', first_block: String(card.freshness.block), block: String(card.freshness.block) });
    await holding(a.wallet, token, null);
    let report = (await get(a.wallet, a.cookie)).json();
    expect(report.holdings[0]).toMatchObject({ status: 'pending', balance: null });
    const jobs = new ScanJobs(chain()), job = (await chain().sql.query<{ id: string }>('SELECT id FROM scan_jobs WHERE coin=$1', [binary(token)])).rows[0]!;
    await get(a.wallet, a.cookie);
    expect((await chain().sql.query('SELECT id FROM scan_jobs WHERE coin=$1', [binary(token)])).rows).toHaveLength(1);
    await chain().sql.query("UPDATE scan_jobs SET phase='waiting',last_error='retry_limit',attempts=3 WHERE id=$1", [job.id]);
    report = (await get(a.wallet, a.cookie)).json(); expect(report.holdings[0]).toMatchObject({ status: 'error', error: 'scan_failed' });
    expect((await jobs.get(job.id))?.phase).toBe('waiting');
    report = (await get(a.wallet, a.cookie, '?retry=true')).json(); expect(report.holdings[0].status).toBe('pending');
    expect(await jobs.get(job.id)).toMatchObject({ phase: 'queued', attempts: 0, last_error: null });
    const copy = structuredClone(card); copy.identity.address = token; copy.verdict.coin = token;
    copy.meta!.tradeability = { asOfBlock: copy.freshness.block, confidence: 1 }; copy.tradeability.exitCostPct.usd1k = 12.5;
    await chain().sql.query('INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) VALUES($1,$2,$3,$1,$4)', [job.id, binary(token), card.freshness.block, copy]);
    await chain().sql.query('INSERT INTO coin_card_latest(coin,card_id,as_of_block,data) VALUES($1,$2,$3,$4)', [binary(token), job.id, card.freshness.block, copy]);
    report = (await get(a.wallet, a.cookie)).json(); expect(report.holdings[0]).toMatchObject({ status: 'ready', exitCost1kPct: 12.5 });
    expect(report.holdings[0].coin.name.flags).toBeDefined();
  });
  it('bounds scan admissions and pages indexed candidates without interpreting observed transfer deltas as balances', async () => {
    const a = await owner(10906);
    for (let i = 0; i < 101; i++) {
      const token = sampleAddress(11000 + i);
      await chain().insert('tokens', { address: binary(token), name: 'Sample', symbol: 'PAGE', first_block: String(card.freshness.block), block: String(card.freshness.block) });
      await holding(a.wallet, token, null);
    }
    const first = (await get(a.wallet, a.cookie)).json(); expect(first.holdings).toHaveLength(100); expect(first.cursor).toBe(sampleAddress(11099));
    expect(first.holdings.every((r: { balance: string | null }) => r.balance === null)).toBe(true);
    expect((await chain().sql.query('SELECT id FROM scan_jobs WHERE coin>=$1 AND coin<=$2', [binary(sampleAddress(11000)), binary(sampleAddress(11100))])).rows).toHaveLength(10);
    await get(a.wallet, a.cookie);
    expect((await chain().sql.query('SELECT id FROM scan_jobs WHERE coin>=$1 AND coin<=$2', [binary(sampleAddress(11000)), binary(sampleAddress(11100))])).rows).toHaveLength(20);
    const next = (await get(a.wallet, a.cookie, `?cursor=${first.cursor}`)).json(); expect(next.holdings).toHaveLength(1); expect(next.cursor).toBeNull();
  });
  it('retains row errors when the queue is full or a stored card is malformed', async () => {
    const a = await owner(10913), token = sampleAddress(10951);
    await chain().insert('tokens', { address: binary(token), name: 'Sample', symbol: 'QUEUE', first_block: String(card.freshness.block), block: String(card.freshness.block) });
    await holding(a.wallet, token);
    const service = new BagsService(built.ctx.reads.store, built.ctx.dbh.db, client());
    const capacity = vi.spyOn(service.jobs, 'ensure').mockRejectedValue(new (await import('@eko/db')).ScanQueueFull());
    let report = await service.report(a.wallet);
    expect(report.holdings[0]).toMatchObject({ status: 'error', error: 'scan_queue_full', exitCost1kPct: null });
    capacity.mockRestore();
    const lookup = vi.spyOn(built.ctx.reads.store, 'card').mockRejectedValueOnce(new Error('private diagnostic'));
    report = await service.report(a.wallet);
    expect(report.holdings[0]).toMatchObject({ status: 'error', error: 'card_unavailable' });
    expect(JSON.stringify(report)).not.toContain('private diagnostic'); lookup.mockRestore();
    expect((await get(a.wallet, a.cookie)).json().holdings[0].status).toBe('pending');
  });
  it('blocks demo shares, validates opt-ins, and requires the exact write origin', async () => {
    const a = await owner(10907), demo = createDemoToken([], placeholder);
    expect((await get(a.wallet, `eko_demo=${demo}`)).statusCode).toBe(401);
    expect((await get(a.wallet, `${a.cookie}; eko_demo=${demo}`)).statusCode).toBe(200);
    const demoShare = await share(a.wallet, `${a.cookie}; eko_demo=${demo}`, {});
    expect(demoShare.statusCode).toBe(403);
    expect(demoShare.headers['cache-control']).toBe('private, no-store');
    expect((await get(a.wallet, `${a.cookie}; eko_demo=${demo}`, '?retry=true')).statusCode).toBe(403);
    for (const from of [null, 'https://foreign.example', `${origin}/path`]) expect((await share(a.wallet, a.cookie, {}, from)).statusCode).toBe(403);
    for (const payload of [{ includeWallet: 'true' }, { includeValues: 1 }, { wallet: a.wallet }]) expect((await share(a.wallet, a.cookie, payload)).statusCode).toBe(422);
    expect((await get(a.wallet, a.cookie, '?retry=invalid')).statusCode).toBe(422);
  });
  it('persists each opt-in independently, rounds balances, and serves identical snapshots across anonymous/foreign/owner sessions', async () => {
    const a = await owner(10908), b = await owner(10909); await holding(a.wallet);
    await chain().sql.query('INSERT INTO bars_1m(coin,minute,open,high,low,close,volume_usd,trades,first_block,last_block) VALUES($1,$2,2,2,2,2,1,1,$3,$3)', [binary(card.identity.address), new Date(), card.freshness.block]);
    const ids: string[] = [];
    for (const includeValues of [false, true]) for (const includeWallet of [false, true]) {
      const created = await share(a.wallet, a.cookie, { includeValues, includeWallet }); expect(created.statusCode).toBe(201);
      const { id, shareUrl } = created.json(); ids.push(id); expect(shareUrl).toBe(`/bags/r/${id}`);
      const responses = await Promise.all([undefined, a.cookie, b.cookie].map(cookie => publicGet(id, cookie)));
      expect(new Set(responses.map(r => r.body)).size).toBe(1);
      for (const response of responses) {
        expect(response.headers['cache-control']).toBe('private, no-store'); expect(response.headers['set-cookie']).toBeUndefined();
        const report = PublicBagReportSchema.parse(response.json());
        expect(report.wallet).toBe(includeWallet ? a.wallet : undefined);
        expect(response.body.includes(a.wallet)).toBe(includeWallet);
        expect(report.holdings[0].balance).toBe('120000000000');
        expect(report.holdings[0].valueUsd !== undefined).toBe(includeValues);
        expect(report.summary.valueUsd !== undefined).toBe(includeValues);
        expect(report.holdings[0].coin.priceUsd !== undefined).toBe(includeValues);
        if (!includeValues) expect(response.body).not.toMatch(/"(?:valueUsd|priceUsd|liquidityUsd|marketCapUsd)"/);
        expect(response.body).not.toContain('123456789012.34567890123456789');
      }
      const [stored] = await built.ctx.dbh.db.select().from(bagShares).where(eq(bagShares.id, id));
      expect(stored!.snapshot).toEqual(responses[0]!.json());
    }
    const before = (await publicGet(ids[0]!)).body;
    balance.mockResolvedValueOnce(1n); await get(a.wallet, a.cookie);
    await chain().sql.query('UPDATE balances SET amount=0 WHERE holder=$1', [binary(a.wallet)]);
    const restartedService = new BagsService(built.ctx.reads.store, built.ctx.dbh.db, client());
    expect(await restartedService.publicReport(ids[0]!)).toEqual(JSON.parse(before));
    expect((await publicGet(ids[0]!)).body).toBe(before);
    expect(new Set(ids).size).toBe(4);
    expect((await publicGet(randomUUID())).statusCode).toBe(404);
  });
  it('does not publish private holdings on user or public channels', async () => {
    const a = await owner(10910), b = await owner(10911); await holding(a.wallet);
    const sockets = [a, b].map(account => {
      const socket = new Socket(); built.ctx.hub.addV1(socket as unknown as WebSocket, account.id);
      socket.emit('message', JSON.stringify({ op: 'sub', ch: ['agents', 'orders', 'alerts', 'radar', 'bags'] })); socket.messages = [];
      return socket;
    });
    const publish = vi.spyOn(built.ctx.hub, 'publish'), privatePublish = vi.spyOn(built.ctx.hub, 'toAccount');
    await get(a.wallet, a.cookie); await share(a.wallet, a.cookie, {});
    // Background public market updates (coin/flow ticks, radar rows and new-pairs columns, from the live read feed) may
    // fire during the window, for example when the 2-hour-old fixture coin crosses an age boundary; nothing about this
    // owner's bags may reach any channel, public or private (the wallet check below covers every publish).
    const isPublicMarketTick = ([channel, type]: unknown[]) =>
      (/^(coin|flow):0x[0-9a-f]{40}$/.test(String(channel)) && ['tick', 'flow'].includes(String(type)))
      || (channel === 'radar' && ['rerank', 'row_upsert', 'row_remove'].includes(String(type)))
      || (channel === 'pairs' && ['pair_upsert', 'pair_remove'].includes(String(type)));
    expect(publish.mock.calls.filter(call => !isPublicMarketTick(call))).toEqual([]);
    for (const call of publish.mock.calls) expect(JSON.stringify(call).toLowerCase()).not.toContain(a.wallet.toLowerCase());
    expect(privatePublish).not.toHaveBeenCalled();
    // The same public market updates may reach sockets subscribed to radar; nothing else may, and none may carry the wallet.
    const received = sockets.flatMap(s => s.messages) as { ch?: unknown; kind?: unknown }[];
    expect(received.filter(m => !isPublicMarketTick([m.ch, m.kind]))).toEqual([]);
    for (const message of received) expect(JSON.stringify(message).toLowerCase()).not.toContain(a.wallet.toLowerCase());
    for (const socket of sockets) socket.close(); publish.mockRestore(); privatePublish.mockRestore();
  });
  it('limits each owner route and keeps refusal responses uncached', async () => {
    const a = await owner(10914);
    for (let i = 0; i < 30; i++) expect((await get(a.wallet, a.cookie)).statusCode).toBe(200);
    const refused = await get(a.wallet, a.cookie);
    expect(refused.statusCode).toBe(429); expect(refused.json().error).toBe('rate_limited');
    expect(refused.headers['cache-control']).toBe('private, no-store');
  });
  it('reuses a proven maintained balance at the requested block with identical output and zero RPC calls',async()=>{
    const a=await owner(10919);await holding(a.wallet);balance.mockClear();
    const before=(await get(a.wallet,a.cookie)).json();expect(balance).toHaveBeenCalledTimes(1);
    const pin=(await chain().sql.query<{number:string;hash:Uint8Array}>('SELECT number,hash FROM chain_blocks ORDER BY number DESC LIMIT 1')).rows[0];
    await chain().sql.query('UPDATE balances SET amount=$3 WHERE token=$1 AND holder=$2',[binary(card.identity.address),binary(a.wallet),'123456789012345678901234567890']);
    await chain().sql.query('INSERT INTO token_balance_origins VALUES($1,$2,$3)',[binary(card.identity.address),pin.number,pin.hash]);
    await chain().sql.query("INSERT INTO ingest_cursors VALUES('head_logs',$1,NULL) ON CONFLICT(stream) DO UPDATE SET block=excluded.block",[pin.number]);
    try {
      balance.mockClear();const after=(await get(a.wallet,a.cookie)).json();expect(after.holdings[0].balance).toBe(before.holdings[0].balance);
      expect(after.holdings[0].balanceStatus).toBe('observed');expect(balance).not.toHaveBeenCalled();
    } finally {await chain().sql.query('DELETE FROM token_balance_origins WHERE token=$1',[binary(card.identity.address)]);}
  });
  it('invalidates balances when the indexed block hash changes during acquisition', async () => {
    const a = await owner(10912); await holding(a.wallet);
    const pin = (await chain().sql.query<{ hash: Uint8Array; number: string }>('SELECT number,hash FROM chain_blocks ORDER BY number DESC LIMIT 1')).rows[0]!;
    balance.mockImplementationOnce(async () => {
      await chain().sql.query('UPDATE chain_blocks SET hash=$2 WHERE number=$1', [pin.number, binary(`0x${'9'.repeat(64)}`)]); return 100n;
    });
    try {
      const result = (await get(a.wallet, a.cookie)).json(); expect(result.holdings[0]).toMatchObject({ balance: null, balanceStatus: 'unavailable' });
      expect(result.holdings[0].valueUsd).toBeUndefined(); expect(result.summary.valueUsd).toBeUndefined();
    } finally { await chain().sql.query('UPDATE chain_blocks SET hash=$2 WHERE number=$1', [pin.number, pin.hash]); }
  });
});
describe('two significant figure decimal balances', () => {
  it.each([['0', '0'], ['1.2', '1.2'], ['123456789012345678901234567890', '120000000000000000000000000000'],
    ['99.99', '100'], ['0.000000123456', '0.00000012'], ['0.009999', '0.01'], ['1.2500', '1.3'], ['10.04', '10']])('%s -> %s', (input, output) => expect(roundSharedBalance(input)).toBe(output));
});
