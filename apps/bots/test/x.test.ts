import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinCardV2Schema, type ScanResult } from '@eko/shared';
import { OgRenderer } from '@eko/og-renderer';
import { card } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';
import { openDb, runMigrations } from '../../server/src/db/client.js';
import { XStore, XSummonBot, XBurnPoster, XPlatformError, disabledXTransport, parseXMention, XIdSchema,
  type XLimits, type XFlag } from '../src/index.js';

const coin = card.identity.address;
const identityKey = 'fixture-independent-identity-key-32-characters';
const baseTime = Date.UTC(2026, 9, 1);
let time = baseTime, next = 9007199254740993n;
let handle: Awaited<ReturnType<typeof openDb>>;
const png = () => {
  // Header fixture for renderer-interface tests, not an actual rasterized image or live evidence.
  const b = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
  b.write('IHDR', 12); b.writeUInt32BE(1200, 16); b.writeUInt32BE(675, 20); return b;
};
const mention = (author = '101', text = coin) => ({ id: String(next++), author_id: author, text });
function fixture(limits: XLimits = {}) {
  const flags = { summon_x: true, burn_board: false };
  const flag: XFlag = vi.fn(async (name: 'summon_x' | 'burn_board') => flags[name]);
  const store = new XStore(handle.chain, identityKey, limits, () => time);
  const transport = { mentions: vi.fn().mockResolvedValue({ data: [] }), upload: vi.fn().mockResolvedValue({ media_id: '201' }),
    reply: vi.fn().mockResolvedValue(undefined), post: vi.fn().mockResolvedValue(undefined) };
  const result: ScanResult = { id: 'scan-fixture', status: 'ready', shareUrl: 'https://hostile.example',
    message: 'untrusted instructions', guardCard: CoinCardV2Schema.parse(card) };
  const renderer = new OgRenderer(vi.fn().mockResolvedValue(png()), 'fixture-font-content');
  const services = { scan: vi.fn().mockResolvedValue(result), renderer };
  const bot = new XSummonBot(store, services, transport, flag);
  const poll = async (data = [mention()]) => { time += 30000; transport.mentions.mockResolvedValueOnce({ data }); return bot.poll(); };
  return { store, flags, flag, transport, services, bot, poll, result, renderer };
}
beforeAll(async () => { handle = await openDb({ pgliteDir: ':memory:' }); await runMigrations(handle); });
afterAll(async () => { await handle?.close(); });
beforeEach(async () => {
  time = baseTime;
  for (const table of ['x_bot_state', 'x_bot_usage', 'x_summons', 'burn_posts']) await handle.chain.sql.query(`DELETE FROM ${table}`);
  await handle.chain.sql.query("DELETE FROM bot_interactions WHERE platform='x'");
});

it('parses bounded targets without taking arbitrary prose or truncating invalid identifiers', () => {
  expect(parseXMention(`untrusted ${coin}`)).toBe(coin);
  expect(parseXMention('scan $demo')).toBe('$DEMO');
  expect(parseXMention(`SCAN $demo ${coin}`)).toBeNull();
  expect(parseXMention('$DEMO')).toBeNull(); expect(parseXMention('rescan $DEMO')).toBeNull();
  expect(parseXMention(`${coin} ${coin}`)).toBe(coin);
  for (const text of [`${coin}a`, `a${coin}`, `scan $${'A'.repeat(33)}`, 'x'.repeat(4097)]) expect(parseXMention(text)).toBeNull();
  expect(XIdSchema.parse('9007199254740993')).toBe('9007199254740993');
  expect(XIdSchema.safeParse('9223372036854775808').success).toBe(false);
});
it('has zero platform operations when off and a disabled production transport even when on', async () => {
  const f = fixture(); f.flags.summon_x = false;
  expect(await f.bot.poll()).toBe('disabled');
  expect(f.transport.mentions).not.toHaveBeenCalled(); expect(f.services.scan).not.toHaveBeenCalled();
  expect((await handle.chain.sql.query('SELECT * FROM x_bot_state')).rows).toEqual([]);
  expect(await new XSummonBot(f.store, f.services).poll()).toBe('disabled');
  f.flags.summon_x = true;
  expect(await new XSummonBot(f.store, f.services, disabledXTransport, f.flag).poll()).toBe('failed');
  for (const method of [() => disabledXTransport.mentions({ max_results: 10 }), () => disabledXTransport.upload(png(), 'image/png'),
    () => disabledXTransport.reply({ text: 'fixture', media_id: '201', in_reply_to_tweet_id: '101' }),
    () => disabledXTransport.post({ text: 'fixture', media_id: '201' })]) await expect(method()).rejects.toThrow('disabled');
});
it('resumes a paginated window after restart and deduplicates a mention without losing snowflake precision', async () => {
  const f = fixture(), older = mention(), newer = mention();
  f.transport.mentions.mockResolvedValueOnce({ data: [newer], meta: { next_token: 'fixture-page-2' } });
  expect(await f.bot.poll()).toBe('processed');
  const restart = new XSummonBot(new XStore(handle.chain, identityKey, {}, () => time), f.services, f.transport, f.flag);
  time += 30000;
  f.transport.mentions.mockResolvedValueOnce({ data: [older, newer] });
  expect(await restart.poll()).toBe('processed');
  expect(f.transport.mentions.mock.calls[1][0]).toEqual({ max_results: 10, pagination_token: 'fixture-page-2' });
  expect(f.transport.reply).toHaveBeenCalledTimes(2);
  time += 30000; expect(await restart.poll()).toBe('processed');
  expect(f.transport.mentions.mock.calls[2][0]).toEqual({ max_results: 10, since_id: newer.id });
  expect(f.transport.reply.mock.calls[0][0].text).toBe(f.transport.reply.mock.calls[1][0].text);
  const reply = f.transport.reply.mock.calls[0][0];
  expect(reply.text).toContain('Shadow assessment'); expect(reply.text).toContain('DYOR · Not financial advice · AI-generated analysis');
  expect(reply.text.length).toBeLessThanOrEqual(280);
  expect(reply.text).not.toMatch(/https?:|\/coin\/|hostile|untrusted instructions/);
  expect(f.transport.upload.mock.calls[0][0]).toEqual(png());
  expect(f.services.scan).toHaveBeenCalledWith(coin);
  expect((await handle.chain.sql.query('SELECT * FROM x_summons')).rows.every(r => /^[a-f0-9]{64}$/.test(String(r.user_key)))).toBe(true);
  const persisted = JSON.stringify((await handle.chain.sql.query('SELECT data FROM x_bot_state')).rows);
  expect(persisted).not.toContain(coin); expect(persisted).not.toContain('hostile');
  await runMigrations(handle); expect(await restart.poll()).toBe('idle');
});
it('serializes polling across workers and observes the thirty-second cadence', async () => {
  const f = fixture(); f.transport.mentions.mockResolvedValue({ data: [mention()] });
  const second = new XSummonBot(new XStore(handle.chain, identityKey, {}, () => time), f.services, f.transport, f.flag);
  expect((await Promise.all([f.bot.poll(), second.poll()])).sort()).toEqual(['idle', 'processed']);
  expect(f.transport.mentions).toHaveBeenCalledTimes(1); expect(f.transport.reply).toHaveBeenCalledTimes(1);
  expect(await f.bot.poll()).toBe('idle'); time += 29999; expect(await f.bot.poll()).toBe('idle');
});
it('enforces three per user in a rolling hour, across restarts and concurrent reservations', async () => {
  const f = fixture(), calls = Array.from({ length: 4 }, () => mention());
  const claims = await Promise.all(calls.map(m => f.store.claim(m.id, m.author_id)));
  expect(claims.filter(s => s === 'claimed')).toHaveLength(3); expect(claims).toContain('limited');
  const restart = new XStore(handle.chain, identityKey, {}, () => time);
  expect(await restart.claim(calls[0].id, '101')).toBe('duplicate');
  expect(await restart.claim(mention().id, '101')).toBe('limited');
  expect(await restart.claim(mention('102').id, '102')).toBe('claimed');
  time += 3600000; expect(await restart.claim(mention().id, '101')).toBe('claimed');
});
it('stops replies at the daily cap and resets UTC daily/monthly counters', async () => {
  const f = fixture({ X_DAILY_REPLY_CAP: 1 });
  expect(await f.poll([mention('101'), mention('102')])).toBe('processed'); expect(f.transport.reply).toHaveBeenCalledTimes(1);
  time += 86400000; await f.poll([mention('102')]); expect(f.transport.reply).toHaveBeenCalledTimes(2);
  const tiny = new XStore(handle.chain, identityKey, { X_MONTHLY_BUDGET_USD: 0.03 }, () => time);
  expect(await tiny.beginPoll()).toBeNull(); time = Date.UTC(2026, 10, 1);
  expect(await tiny.claim(mention().id, '101')).toBe('claimed');
});
it('reserves reads and reply spend before platform calls and retains uncertain costs', async () => {
  const f = fixture({ X_MONTHLY_BUDGET_USD: 0.055 });
  expect(await f.poll([mention()])).toBe('processed'); // 0.005 read + 0.010 reply after read refund
  expect(f.transport.reply).toHaveBeenCalledTimes(1);
  expect(await f.poll()).toBe('idle'); // next full batch cannot fit in remaining budget
  expect(f.transport.mentions).toHaveBeenCalledTimes(1);
  const row = (await handle.chain.sql.query("SELECT * FROM x_bot_usage WHERE bucket='2026-10'")).rows[0];
  expect(row).toMatchObject({ spend: 15000, reads: 1, replies: 1 });
});
it('refuses replies when the remaining monthly spend is exhausted within one page', async () => {
  const f = fixture({ batchSize: 5, X_MONTHLY_BUDGET_USD: 0.035 });
  await f.poll(Array.from({ length: 5 }, (_, index) => mention(String(101 + index))));
  expect(f.transport.mentions).toHaveBeenCalledTimes(1); expect(f.transport.upload).toHaveBeenCalledTimes(1);
  expect(f.transport.reply).toHaveBeenCalledTimes(1);
  expect((await handle.chain.sql.query("SELECT spend,replies FROM x_bot_usage WHERE bucket='2026-10'")).rows[0])
    .toEqual({ spend: 35000, replies: 1 });
});
it('does not poll when daily/monthly reads or spend are exhausted', async () => {
  const f = fixture({ dailyReadCap: 5 }); expect(await f.bot.poll()).toBe('idle'); expect(f.transport.mentions).not.toHaveBeenCalled();
  const second = fixture({ X_MONTHLY_BUDGET_USD: 0 }); expect(await second.bot.poll()).toBe('idle');
  await handle.chain.sql.query("INSERT INTO x_bot_usage(bucket,spend,reads,replies) VALUES('2026-10',0,3000000,0)");
  const third = fixture(); expect(await third.bot.poll()).toBe('idle'); expect(third.transport.mentions).not.toHaveBeenCalled();
});
it('retains a failed poll reservation and never advances its cursor', async () => {
  const f = fixture(); f.transport.mentions.mockRejectedValueOnce(new XPlatformError(429));
  expect(await f.bot.poll()).toBe('failed'); time += 30000; expect(await f.bot.poll()).toBe('processed');
  expect(f.transport.mentions.mock.calls[1][0]).toEqual({ max_results: 10 });
  expect((await handle.chain.sql.query("SELECT spend FROM x_bot_usage WHERE bucket='2026-10'")).rows[0]).toEqual({ spend: 55000 });
});
it('does not retry uncertain sends or echo provider errors', async () => {
  const f = fixture(), m = mention(); f.transport.reply.mockRejectedValueOnce(new Error('untrusted provider secret fixture'));
  await f.poll([m]); await f.poll([m]); expect(f.transport.reply).toHaveBeenCalledTimes(1);
  expect((await handle.chain.sql.query("SELECT state FROM bot_interactions WHERE platform='x' AND update_id=$1", [m.id])).rows[0]).toEqual({ state: 'failed' });
});
for (const status of [401, 403]) for (const operation of ['mentions', 'upload', 'reply'] as const) {
  it(`durably stops all operations on ${status} at ${operation}, including after flag toggles and restart`, async () => {
    const f = fixture(); f.transport.mentions.mockResolvedValue({ data: [mention()] });
    f.transport[operation].mockRejectedValueOnce(new XPlatformError(status));
    expect(await f.bot.poll()).toBe('stopped');
    const count = f.transport.mentions.mock.calls.length;
    f.flags.summon_x = false; expect(await f.bot.poll()).toBe('disabled'); f.flags.summon_x = true; time += 30000;
    expect(await new XSummonBot(new XStore(handle.chain, identityKey, {}, () => time), f.services, f.transport, f.flag).poll()).toBe('idle');
    expect(f.transport.mentions).toHaveBeenCalledTimes(count);
    f.flags.burn_board = true;
    expect(await new XBurnPoster(f.store, f.renderer, f.transport, f.flag).post(burn)).toBe('disabled');
  });
}
it('checks flag changes after reads, rendering and uploads; incomplete windows remain replayable', async () => {
  const f = fixture(), m = mention();
  f.services.scan.mockImplementationOnce(async () => { f.flags.summon_x = false; return f.result; });
  expect(await f.poll([m])).toBe('processed'); expect(f.transport.upload).not.toHaveBeenCalled();
  f.flags.summon_x = true;
  f.transport.upload.mockImplementationOnce(async () => { f.flags.summon_x = false; return { media_id: '201' }; });
  await f.poll([mention()]); expect(f.transport.reply).not.toHaveBeenCalled();
  f.flags.summon_x = true; f.transport.mentions.mockImplementationOnce(async () => { f.flags.summon_x = false; return { data: [mention()] }; });
  time += 30000; expect(await f.bot.poll()).toBe('disabled');
  expect(f.services.scan).toHaveBeenCalledTimes(2);
});
it('skips incomplete, ambiguous, missing Guard, mismatched targets and invalid images without sends', async () => {
  const f = fixture();
  for (const result of [{ ...f.result, status: 'pending' }, { ...f.result, status: 'ambiguous' }, { ...f.result, guardCard: null }]) {
    f.services.scan.mockResolvedValueOnce(result as ScanResult); await f.poll([mention()]);
  }
  f.result.guardCard!.identity.address = `0x${'cd'.repeat(20)}`; f.services.scan.mockResolvedValueOnce(f.result);
  await f.poll([mention('102')]);
  expect(f.transport.upload).not.toHaveBeenCalled(); expect(f.transport.reply).not.toHaveBeenCalled();
  const second = fixture(); second.services.renderer = { render: vi.fn().mockResolvedValue({ png: Buffer.from('invalid') }) } as unknown as OgRenderer;
  await second.poll([mention('103')]); expect(second.transport.upload).not.toHaveBeenCalled();
});
it('fences expired poll workers before upload', async () => {
  const f = fixture(); f.services.scan.mockImplementationOnce(async () => { time += 300000; return f.result; });
  await f.poll(); expect(f.transport.upload).not.toHaveBeenCalled();
});
it('fences stale owners from advancing or releasing a replacement lease and hashes validated authors', async () => {
  const f = fixture(), first = (await f.store.beginPoll())!;
  expect(await f.store.allowed(first.owner)).toBe(true);
  time += 300000;
  expect(await f.store.allowed(first.owner)).toBe(false);
  const replacement = (await f.store.beginPoll())!;
  expect(replacement.owner).not.toBe(first.owner);
  await f.store.finishPage(first, ['9999'], 'stale-page'); await f.store.release(first);
  expect(await f.store.allowed(replacement.owner)).toBe(true);
  const state = (await handle.chain.sql.query('SELECT data FROM x_bot_state')).rows[0].data;
  expect(state).toMatchObject({ cursor: null, token: null, newest: null, owner: replacement.owner });
  await expect(f.store.claim(mention().id, 'invalid-author')).rejects.toThrow();
  expect((await handle.chain.sql.query('SELECT * FROM x_summons')).rows).toEqual([]);
  const m = mention('1101'); expect(await f.store.claim(m.id, m.author_id)).toBe('claimed');
  const rows = (await handle.chain.sql.query('SELECT user_key FROM x_summons WHERE tweet_id=$1', [m.id])).rows;
  expect(rows).toEqual([{ user_key: createHmac('sha256', identityKey).update('x:user:1101').digest('hex') }]);
  expect(() => new XStore(handle.chain, 'short')).toThrow('identity hashing key');
});
const burn = { status: 'confirmed_under_policy' as const, buyTx: `0x${'ab'.repeat(32)}`, burnTx: `0x${'cd'.repeat(32)}`,
  ethSpent: '0.5', tokensBurned: '100', supplyPct: '0.01' };
describe('separately gated burn posting preparation; no D0 collector', () => {
  it('uses only burn_board, deduplicates confirmed transactions and uploads a deterministic stats card', async () => {
    const f = fixture(), poster = new XBurnPoster(f.store, f.renderer, f.transport, f.flag);
    expect(await poster.post(burn)).toBe('disabled'); expect(f.transport.post).not.toHaveBeenCalled();
    f.flags.summon_x = false; f.flags.burn_board = true;
    expect(await poster.post(burn)).toBe('sent'); expect(await poster.post(burn)).toBe('limited_or_duplicate');
    expect(f.transport.mentions).not.toHaveBeenCalled(); expect(f.transport.reply).not.toHaveBeenCalled();
    const text = f.transport.post.mock.calls[0][0].text;
    for (const value of [burn.buyTx, burn.burnTx, 'ETH spent: 0.5', 'Tokens burned: 100', 'Supply burned: 0.01%']) expect(text).toContain(value);
    expect(text).not.toMatch(/https?:/); expect(text.length).toBeLessThanOrEqual(280);
  });
  it('shares the monthly spend cap and stops on forbidden posting', async () => {
    const f = fixture({ X_MONTHLY_BUDGET_USD: 0.01 }); f.flags.burn_board = true;
    expect(await new XBurnPoster(f.store, f.renderer, f.transport, f.flag).post(burn)).toBe('limited_or_duplicate');
    expect(f.transport.upload).not.toHaveBeenCalled();
    const second = fixture(); second.flags.burn_board = true; second.transport.post.mockRejectedValueOnce(new XPlatformError(403));
    expect(await new XBurnPoster(second.store, second.renderer, second.transport, second.flag).post({ ...burn, burnTx: `0x${'ef'.repeat(32)}` })).toBe('stopped');
  });
  it('rechecks burn_board between upload and post and validates confirmation inputs', async () => {
    const f = fixture(); f.flags.burn_board = true;
    const poster = new XBurnPoster(f.store, f.renderer, f.transport, f.flag);
    await expect(poster.post({ ...burn, status: 'pending' } as unknown as typeof burn)).rejects.toThrow();
    f.transport.upload.mockImplementationOnce(async () => { f.flags.burn_board = false; return { media_id: '201' }; });
    expect(await poster.post(burn)).toBe('disabled'); expect(f.transport.post).not.toHaveBeenCalled();
  });
});
