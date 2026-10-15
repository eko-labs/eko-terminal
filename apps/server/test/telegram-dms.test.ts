import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DYOR, NON_AFFILIATION, type Alert, type AlertSettings } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accounts } from '../src/db/schema.js';
import { TelegramLinkService, TELEGRAM_LINK_TTL_MS } from '../src/telegram/link.js';
import { TelegramDeliveryWorker, telegramAlertText } from '../src/telegram/delivery.js';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/service.js';
import { createDemoToken } from '../src/http/v1/demo.js';
import { telegramRoutes } from '../src/http/v1/telegram.js';

const origin = 'https://app.eko.example', placeholder = 'fixture-telegram-placeholder'.repeat(2);
const coin = `0x${'a1'.repeat(20)}` as const;
let built: Awaited<ReturnType<typeof buildApp>>, serial = 1, sender = 7000;
const db = () => built.ctx.dbh.chain;
beforeAll(async () => {
  built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', LEGACY_API: 'false',
    PUBLIC_ORIGIN: origin, TELEGRAM_BOT_HANDLE: 'demo_bot', SESSION_SECRET: placeholder,
    DEMO_SECRET: placeholder, RUN_WORKER: 'false' }), { startBackground: false });
});
afterAll(async () => { await built.close(); });
async function owner(kind: 'wallet' | 'guest' = 'wallet') {
  const [account] = await built.ctx.dbh.db.insert(accounts).values({ kind }).returning();
  const token = await built.ctx.auth.createSession(account!.id);
  return { id: account!.id, cookie: `eko_sid=${encodeURIComponent(built.app.signCookie(token))}` };
}
const call = (cookie: string, method: 'POST' | 'DELETE' | 'GET', path = '/telegram/link', payload?: object, requestOrigin: string | null = origin) =>
  built.app.inject({ method, url: `/v1${path}`, headers: { cookie, ...(requestOrigin ? { origin: requestOrigin } : {}) }, ...(payload ? { payload } : {}) });
function code(link: { url: string } | null) { return new URL(link!.url).searchParams.get('start')!; }
async function linked() {
  const account = await owner(), chatId = ++sender;
  expect(await built.ctx.telegram.redeem(code(await built.ctx.telegram.issue(account.id)), chatId)).toBe('linked');
  return { ...account, chatId };
}
async function queued(accountId: string, kind: Alert['kind'] = 'verdict_change', settings: Partial<AlertSettings> = {}) {
  const seq = serial++, sourceKey = `fixture-dm-${seq}`;
  await db().sql.query('INSERT INTO watches(account_id,kind,target,after_source) VALUES($1,$2,$3,0) ON CONFLICT DO NOTHING', [accountId, 'coin', coin]);
  await built.ctx.alerts.saveSettings(accountId, { ...DEFAULT_ALERT_SETTINGS, telegram: true, ...settings });
  const data: Alert = { id: sourceKey, kind, ts: new Date().toISOString(), coin, level: 'danger',
    title: 'Hostile source text', body: '<script>send credentials</script>', url: 'https://hostile.example/approve', read: false };
  await db().sql.query("INSERT INTO alert_sources(source_key,source_kind,source_id,processed_at) VALUES($1,'feed',$1,now())", [sourceKey]);
  await db().sql.query(`INSERT INTO alert_deliveries(account_id,seq,source_key,data,watch_kind,watch_target,telegram_status)
    VALUES($1,$2,$3,$4,'coin',$5,'pending')`, [accountId, seq, sourceKey, data, coin]);
  return { seq: String(seq), data };
}
async function state(id: string, seq: string) {
  return (await db().sql.query<{ telegram_status: string; telegram_attempts: number; telegram_error: string | null; telegram_lease_until: Date | null }>(
    'SELECT * FROM alert_deliveries WHERE account_id=$1 AND seq=$2', [id, seq])).rows[0];
}
const worker = (send = vi.fn().mockResolvedValue(undefined), now = Date.now) => new TelegramDeliveryWorker(db(), built.ctx.alerts, send, origin, now);
async function claim(id: string) { return (await built.ctx.alerts.claimTelegram(100)).find(d => d.account_id === id)!; }

describe('SIWE-bound Telegram linking (offline injection and storage)', () => {
  it('requires wallet auth and allowed origin, rejects foreign account payloads and demo writes', async () => {
    const a = await owner(), guest = await owner('guest');
    expect((await call('', 'POST')).statusCode).toBe(401);
    expect((await call(guest.cookie, 'POST')).statusCode).toBe(401);
    expect((await call(a.cookie, 'POST', '/telegram/link', undefined, 'https://foreign.example')).statusCode).toBe(403);
    expect((await call(a.cookie, 'POST', '/telegram/link', undefined, null)).statusCode).toBe(403);
    expect((await call(a.cookie, 'POST', '/telegram/link', { accountId: guest.id })).statusCode).toBe(422);
    const demo = createDemoToken([], placeholder);
    expect((await call(`${a.cookie}; eko_demo=${demo}`, 'POST')).statusCode).toBe(403);
    expect((await call(`${a.cookie}; eko_demo=${demo}`, 'DELETE')).statusCode).toBe(403);
    expect((await call(guest.cookie, 'DELETE')).statusCode).toBe(401);
  });
  it('issues opaque expiring codes, persists only their hashes and reports links in /me', async () => {
    const a = await owner(), response = await call(a.cookie, 'POST');
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
    const result = response.json(); expect(Object.keys(result).sort()).toEqual(['expiresAt', 'url']);
    const token = code(result); expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.url).toBe(`https://t.me/demo_bot?start=${token}`);
    const persisted = (await db().sql.query('SELECT * FROM telegram_link_codes WHERE account_id=$1', [a.id])).rows;
    expect(persisted[0].code_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(persisted)).not.toContain(token);
    expect(Date.parse(result.expiresAt) - Date.now()).toBeGreaterThan(TELEGRAM_LINK_TTL_MS - 10000);
    expect(await built.ctx.telegram.redeem(token, ++sender)).toBe('linked');
    expect((await call(a.cookie, 'GET', '/me')).json().account.linked).toEqual(['telegram']);
  });
  it('rejects expired, malformed, foreign and reused codes, and invalidates prior codes on reissue', async () => {
    let time = Date.now(); const service = new TelegramLinkService(db(), 'demo_bot', () => time), a = await owner();
    const expired = code(await service.issue(a.id)); time += TELEGRAM_LINK_TTL_MS;
    expect(await service.redeem(expired, ++sender)).toBe('invalid_code');
    for (const invalid of ['foreign-code', 'A'.repeat(43), `${expired}x`]) expect(await service.redeem(invalid, sender)).toBe('invalid_code');
    const old = code(await service.issue(a.id)), current = code(await service.issue(a.id));
    expect(await service.redeem(old, sender)).toBe('invalid_code');
    expect(await service.redeem(current, 1.5)).toBe('invalid_code');
    expect((await Promise.all([service.redeem(current, sender), service.redeem(current, sender)])).sort()).toEqual(['invalid_code', 'linked']);
    expect(await service.redeem(current, ++sender)).toBe('invalid_code');
  });
  it('enforces external identity uniqueness without stealing a foreign account link', async () => {
    const a = await linked(), b = await owner(); const token = code(await built.ctx.telegram.issue(b.id));
    expect(await built.ctx.telegram.redeem(token, a.chatId)).toBe('identity_conflict');
    expect((await call(a.cookie, 'GET', '/me')).json().account.linked).toEqual(['telegram']);
    expect((await call(b.cookie, 'GET', '/me')).json().account.linked).toEqual([]);
    await expect(db().sql.query("INSERT INTO linked_identities(account_id,provider,external_id) VALUES($1,'telegram',$2)", [b.id, String(a.chatId)])).rejects.toThrow();
    expect(await built.ctx.telegram.redeem(token, ++sender)).toBe('linked');
  });
  it('relinks an account and cancels pending/claimed notices rather than forwarding them', async () => {
    const a = await linked(), queuedRow = await queued(a.id), lease = await claim(a.id), send = vi.fn();
    const token = code(await built.ctx.telegram.issue(a.id));
    expect(await built.ctx.telegram.redeem(token, ++sender)).toBe('linked');
    expect((await state(a.id, queuedRow.seq)).telegram_status).toBe('disabled');
    expect(await worker(send).dispatch(lease)).toBe('stale'); expect(send).not.toHaveBeenCalled();
    expect((await db().sql.query("SELECT external_id FROM linked_identities WHERE account_id=$1", [a.id])).rows[0].external_id).toBe(String(sender));
    const b = await owner(); expect(await built.ctx.telegram.redeem(code(await built.ctx.telegram.issue(b.id)), a.chatId)).toBe('linked');
  });
  it('unlinks only the owner, revokes issued codes, cancels claims and advances the cursor', async () => {
    const a = await linked(), b = await linked(), queuedRow = await queued(a.id), lease = await claim(a.id);
    const token = code(await built.ctx.telegram.issue(a.id)), send = vi.fn();
    expect((await call(a.cookie, 'DELETE')).statusCode).toBe(200);
    expect((await call(a.cookie, 'DELETE')).statusCode).toBe(200);
    expect((await call(a.cookie, 'GET', '/me')).json().account.linked).toEqual([]);
    expect((await call(b.cookie, 'GET', '/me')).json().account.linked).toEqual(['telegram']);
    expect(await built.ctx.telegram.redeem(token, ++sender)).toBe('invalid_code');
    expect(await worker(send).dispatch(lease)).toBe('stale'); expect(send).not.toHaveBeenCalled();
    expect((await state(a.id, queuedRow.seq)).telegram_lease_until).toBeNull();
    expect(String((await db().sql.query('SELECT seq FROM alert_consumer_cursors WHERE account_id=$1', [a.id])).rows[0].seq)).toBe(queuedRow.seq);
  });
  it('leaves linking unavailable without deployment bot configuration', async () => {
    const a = await owner(); expect(await new TelegramLinkService(db(), undefined).issue(a.id)).toBeNull();
  });
  it('returns a private not-found response when the authenticated link route is unconfigured', async () => {
    const a = await owner(), app = Fastify(), telegram = new TelegramLinkService(db(), undefined);
    await app.register(cookie, { secret: placeholder });
    await telegramRoutes(app, { auth: built.ctx.auth, telegram });
    try {
      const response = await app.inject({ method: 'POST', url: '/telegram/link', headers: { cookie: a.cookie, origin }, payload: {} });
      expect(response.statusCode).toBe(404); expect(response.json().error).toBe('not_found');
      expect(response.headers['cache-control']).toBe('private, no-store'); expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect((await db().sql.query('SELECT * FROM telegram_link_codes WHERE account_id=$1', [a.id])).rows).toEqual([]);
    } finally { await app.close(); }
  });
  it('refuses invalid bot configuration and non-wallet issuance without storing a bearer', async () => {
    for (const handle of ['', 'bad/name', 'a'.repeat(33)]) {
      expect(() => new TelegramLinkService(db(), handle)).toThrow('Invalid Telegram bot configuration');
    }
    const guest = await owner('guest');
    await expect(built.ctx.telegram.issue(guest.id)).rejects.toThrow('Wallet account required');
    expect((await db().sql.query('SELECT * FROM telegram_link_codes WHERE account_id=$1', [guest.id])).rows).toEqual([]);
  });
  it('keeps a current identity and its pending notice when redeeming a fresh code for the same sender', async () => {
    const a = await linked(), row = await queued(a.id), lease = await claim(a.id);
    const token = code(await built.ctx.telegram.issue(a.id));
    expect(await built.ctx.telegram.redeem(token, a.chatId)).toBe('linked');
    expect(await built.ctx.telegram.redeem(token, a.chatId)).toBe('invalid_code');
    expect((await state(a.id, row.seq)).telegram_status).toBe('pending');
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await worker(send).dispatch(lease)).toBe('sent');
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: a.chatId }));
  });
});

describe('durable owner DM delivery with mocked sends', () => {
  it('consumes queued records through the worker and does not resend on subsequent runs', async () => {
    const a = await linked(); await queued(a.id);
    const send = vi.fn().mockResolvedValue(undefined), consumer = worker(send);
    expect(await consumer.runOnce()).toBe(1); expect(await consumer.runOnce()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0].chatId).toBe(a.chatId);
  });
  it('deduplicates concurrent dispatch and restart, ignores source prose/URLs and retains disclosures', async () => {
    const a = await linked(), queuedRow = await queued(a.id), lease = await claim(a.id), send = vi.fn().mockResolvedValue(undefined);
    expect((await Promise.all([worker(send).dispatch(lease), worker(send).dispatch(lease)])).sort()).toEqual(['sent', 'stale']);
    expect(await worker(send).dispatch(lease)).toBe('stale'); expect(send).toHaveBeenCalledTimes(1);
    const notice = send.mock.calls[0][0]; expect(notice.chatId).toBe(a.chatId);
    expect(notice.deliveryKey).toBe(createHash('sha256').update(`telegram:${a.id}:${queuedRow.seq}`).digest('hex'));
    expect(JSON.stringify(notice)).not.toContain(a.id);
    expect(notice.text).toContain(`${origin}/coin/${coin}`); expect(notice.text).toContain(DYOR); expect(notice.text).toContain(NON_AFFILIATION);
    expect(notice.text).not.toMatch(/Hostile|script|credentials|hostile\.example|approve/);
    expect(Object.keys(notice).sort()).toEqual(['chatId', 'deliveryKey', 'text']);
    expect((await state(a.id, queuedRow.seq)).telegram_status).toBe('sent');
  });
  it('retries fixed errors with backoff and rejects a stale attempt after lease recovery', async () => {
    const a = await linked(), queuedRow = await queued(a.id), old = await claim(a.id);
    const send = vi.fn().mockRejectedValueOnce(new Error('https://provider.example/private-token')).mockResolvedValue(undefined);
    expect(await worker(send).dispatch(old)).toBe('retry');
    const failed = await state(a.id, queuedRow.seq); expect(failed.telegram_error).toBe('delivery_failed'); expect(failed.telegram_attempts).toBe(1);
    expect((await built.ctx.alerts.claimTelegram(100)).some(d => d.account_id === a.id)).toBe(false);
    await db().sql.query("UPDATE alert_deliveries SET telegram_next_at=now()-interval '1 second' WHERE account_id=$1", [a.id]);
    const recovered = await claim(a.id); expect(recovered.telegram_attempts).toBe(2);
    expect(await worker(send).dispatch(old)).toBe('stale'); expect(await worker(send).dispatch(recovered)).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
    expect((await state(a.id, queuedRow.seq)).telegram_error).toBeNull();
  });
  it('reclaims an expired lease without sending through the stale claim', async () => {
    const a = await linked(); await queued(a.id); const old = await claim(a.id), send = vi.fn().mockResolvedValue(undefined);
    await db().sql.query("UPDATE alert_deliveries SET telegram_lease_until=now()-interval '1 second' WHERE account_id=$1", [a.id]);
    const fresh = await claim(a.id);
    expect(await worker(send).dispatch(old)).toBe('stale'); expect(await worker(send).dispatch(fresh)).toBe('sent'); expect(send).toHaveBeenCalledTimes(1);
  });
  it('rechecks removed watches and withdrawn settings after claims', async () => {
    for (const change of ['watch', 'telegram', 'kinds', 'level'] as const) {
      const a = await linked(), row = await queued(a.id), lease = await claim(a.id), send = vi.fn();
      if (change === 'watch') await built.ctx.alerts.remove(a.id, { kind: 'coin', target: coin });
      else if (change === 'level') await db().sql.query("UPDATE alert_deliveries SET data=jsonb_set(data,'{level}','\"info\"') WHERE account_id=$1", [a.id]);
      if (change !== 'watch') await built.ctx.alerts.saveSettings(a.id, { ...DEFAULT_ALERT_SETTINGS, telegram: change !== 'telegram',
        kinds: change === 'kinds' ? [] : ['verdict_change'], minLevel: 'danger' });
      expect(await worker(send).dispatch(lease)).toBe(change === 'watch' ? 'stale' : 'disabled');
      expect(send).not.toHaveBeenCalled(); expect((await state(a.id, row.seq)).telegram_status).toBe('disabled');
    }
  });
  it('defers quiet hours changed after claim and resumes using the same notice', async () => {
    const a = await linked(), row = await queued(a.id), lease = await claim(a.id), send = vi.fn().mockResolvedValue(undefined);
    await built.ctx.alerts.saveSettings(a.id, { ...DEFAULT_ALERT_SETTINGS, telegram: true, quietHoursUtc: [22, 7] });
    expect(await worker(send, () => Date.UTC(2026, 9, 3, 23)).dispatch(lease)).toBe('retry'); expect(send).not.toHaveBeenCalled();
    expect((await state(a.id, row.seq)).telegram_status).toBe('pending');
    await built.ctx.alerts.saveSettings(a.id, { ...DEFAULT_ALERT_SETTINGS, telegram: true });
    await db().sql.query("UPDATE alert_deliveries SET telegram_next_at=now()-interval '1 second' WHERE account_id=$1", [a.id]);
    expect(await worker(send).dispatch(await claim(a.id))).toBe('sent');
  });
  it('cancels notices without linked identities and keeps approval/order notifications dark', async () => {
    const a = await owner(), row = await queued(a.id), send = vi.fn();
    expect(await worker(send).dispatch(await claim(a.id))).toBe('disabled');
    expect((await state(a.id, row.seq)).telegram_status).toBe('disabled');
    for (const kind of ['approval', 'order'] as const) {
      const b = await linked(); await queued(b.id, kind, { kinds: [kind] });
      expect(await worker(send).dispatch(await claim(b.id))).toBe('disabled');
    }
    expect(send).not.toHaveBeenCalled();
  });
  it('uses a fixed web fallback for wallet notices and rejects untrusted origins', () => {
    const alert: Alert = { id: 'fixture', kind: 'agent_trade', ts: new Date().toISOString(), title: 'source', body: 'source', read: false };
    expect(telegramAlertText(alert, origin)).toContain(`${origin}/watch`);
    expect(() => telegramAlertText(alert, 'https://user:password@example.test')).toThrow();
    expect(telegramAlertText({ ...alert, kind: 'approval' }, origin)).toBeNull();
  });
  it('refuses corrupt linked sender identities without sending or redirecting notices', async () => {
    for (const identity of ['0', '-5', '1.5', '9007199254740992']) {
      const a = await linked(), row = await queued(a.id), lease = await claim(a.id), send = vi.fn();
      await db().sql.query("UPDATE linked_identities SET external_id=$2 WHERE account_id=$1 AND provider='telegram'", [a.id, identity]);
      expect(await worker(send).dispatch(lease)).toBe('disabled');
      expect(send).not.toHaveBeenCalled();
      expect((await state(a.id, row.seq)).telegram_status).toBe('disabled');
    }
  });
  it('rechecks the agent-trade threshold after claiming and sends only qualifying owner notices', async () => {
    const a = await linked(), row = await queued(a.id, 'agent_trade', { agentTradeAboveUsd: 10 });
    await db().sql.query("UPDATE alert_deliveries SET data=jsonb_set(data,'{sizeUsd}','100') WHERE account_id=$1", [a.id]);
    const lease = await claim(a.id), send = vi.fn().mockResolvedValue(undefined);
    await built.ctx.alerts.saveSettings(a.id, { ...DEFAULT_ALERT_SETTINGS, telegram: true, agentTradeAboveUsd: 100 });
    expect(await worker(send).dispatch(lease)).toBe('disabled');
    expect(send).not.toHaveBeenCalled(); expect((await state(a.id, row.seq)).telegram_status).toBe('disabled');
    const b = await linked(); await queued(b.id, 'agent_trade', { agentTradeAboveUsd: 10 });
    await db().sql.query("UPDATE alert_deliveries SET data=jsonb_set(data,'{sizeUsd}','100') WHERE account_id=$1", [b.id]);
    expect(await worker(send).dispatch(await claim(b.id))).toBe('sent');
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: b.chatId }));
  });
});
