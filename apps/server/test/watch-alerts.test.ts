import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binary } from '@eko/db';
import { AlertSchema, AlertSettingsSchema, WatchBodySchema, WsServerSchema, type AlertSettings, type Verdict } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accounts } from '../src/db/schema.js';
import { DEFAULT_ALERT_SETTINGS, WatchAlertsService, quiet } from '../src/alerts/service.js';
import { createDemoToken } from '../src/http/v1/demo.js';
import { Hub } from '../src/ws/hub.js';
import { metrics } from '../src/obs/metrics.js';

const origin = 'https://app.eko.example', placeholder = 'fixture-watch-placeholder'.repeat(2);
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
let built: Awaited<ReturnType<typeof buildApp>>, counter = 90000;
beforeAll(async () => {
  built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', LEGACY_API: 'false',
    PUBLIC_ORIGIN: origin, SESSION_SECRET: placeholder, DEMO_SECRET: placeholder, RUN_WORKER: 'false' }), { startBackground: false });
});
afterAll(async () => { await built.close(); });
async function owner() {
  const [account] = await built.ctx.dbh.db.insert(accounts).values({ kind: 'wallet' }).returning();
  const token = await built.ctx.auth.createSession(account!.id);
  return { id: account!.id, cookie: `eko_sid=${encodeURIComponent(built.app.signCookie(token))}` };
}
const call = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object) =>
  built.app.inject({ method, url: `/v1${path}`, headers: { cookie, origin }, ...(payload === undefined ? {} : { payload }) });
async function coin() {
  const n = ++counter, target = address(n);
  await built.ctx.dbh.chain.insert('tokens', { address: binary(target), first_block: '1', block: '1', symbol: 'FIX' });
  return target;
}
async function block(confirmed = true) {
  const n = ++counter;
  if (confirmed) await built.ctx.dbh.chain.insert('chain_blocks', { number: String(n), block: String(n),
    hash: binary(`0x${n.toString(16).padStart(64, '0')}`), parent_hash: binary(`0x${(n - 1).toString(16).padStart(64, '0')}`), ts: new Date() });
  return n;
}
async function verdict(target: `0x${string}`, level: Verdict['level'] = 'danger', confirmed = true) {
  const n = await block(confirmed), id = `fixture-verdict-${n}`;
  const data: Verdict = { coin: target, level, reasons: ['Fixture measurement'], playbooks: [],
    receipt: { id: `fixture-receipt-${n}`, hash: `0x${'01'.repeat(32)}`, status: 'pending' }, schemaVersion: '1', asOfBlock: n };
  await built.ctx.dbh.chain.tx(async tx => {
    await tx.sql.query('INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES($1,$2,$3,$4,$5,$6)', [id, binary(target), n, 'fixture', id, data]);
    await tx.sql.query('INSERT INTO verdict_events(id,verdict_id,kind,block,data) VALUES($1,$2,$3,$4,$5)', [`${id}:created`, id, 'created', n, {}]);
  });
  return { n, id, data };
}
async function trade(target: `0x${string}`, wallet: `0x${string}`, sizeUsd: number | undefined, label = 'declared_agent', confirmed = true) {
  const n = await block(confirmed), id = `fixture-flow-${n}`;
  // Task 102 producer seam: these are offline measured-feed fixtures, not live flow evidence.
  await built.ctx.dbh.chain.sql.query('INSERT INTO read_feed(id,coin,block,kind,data) VALUES($1,$2,$3,$4,$5)',
    [id, binary(target), n, 'agent_trade', { wallet, label, sizeUsd, side: 'buy' }]);
  return id;
}
async function watch(account: Awaited<ReturnType<typeof owner>>, target: string, kind = 'coin') {
  const response = await call(account.cookie, 'POST', '/watch', { kind, target });
  expect(response.statusCode).toBe(200);
}
async function settings(account: Awaited<ReturnType<typeof owner>>, changes: Partial<AlertSettings>) {
  const data = { ...DEFAULT_ALERT_SETTINGS, ...changes };
  expect((await call(account.cookie, 'PUT', '/alerts/settings', data)).statusCode).toBe(200);
}
async function history(account: Awaited<ReturnType<typeof owner>>) {
  return (await call(account.cookie, 'GET', '/alerts')).json<{ rows: import('@eko/shared').Alert[]; seq: number; cursor: number | null }>();
}
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; messages: unknown[] = []; eventAt = 0;
  send(raw: string) { const message = WsServerSchema.parse(JSON.parse(raw)); this.messages.push(message); if (message.t === 'ev') this.eventAt = performance.now(); }
  close() { this.emit('close'); }
  subscribe() { this.emit('message', JSON.stringify({ op: 'sub', ch: ['alerts'] })); }
  events() { return this.messages.filter((m: any) => m.t === 'ev') as import('@eko/shared').WsEvent<'alerts'>[]; }
}
async function socket(account?: string, hub = built.ctx.hub, service = built.ctx.alerts) {
  const s = new Socket();
  hub.addV1(s as unknown as WebSocket, account, account ? () => service.latestSeq(account) : undefined);
  s.subscribe();
  await new Promise<void>(resolve => setImmediate(resolve));
  await service.drain();
  return s;
}

describe('watches and settings (offline migrated database)', () => {
  it('requires a wallet session, scopes account switches, and rejects bad origins and demo writes', async () => {
    const a = await owner(), b = await owner(), target = await coin();
    const guest = await built.ctx.auth.createGuest(), guestCookie = `eko_sid=${encodeURIComponent(built.app.signCookie(guest.token))}`;
    for (const cookie of ['', guestCookie, 'eko_sid=invalid']) {
      for (const path of ['/watch','/alerts/settings','/alerts']) expect((await call(cookie, 'GET', path)).statusCode).toBe(401);
      expect((await call(cookie, 'POST', '/watch', { kind: 'coin', target })).statusCode).toBe(401);
    }
    await watch(a, target);
    await watch(a, target.toUpperCase().replace('0X', '0x'));
    expect((await call(a.cookie, 'GET', '/watch')).json().items).toEqual([WatchBodySchema.parse({ kind: 'coin', target })]);
    expect((await call(b.cookie, 'GET', '/watch')).json().items).toEqual([]);
    await call(b.cookie, 'DELETE', '/watch', { kind: 'coin', target });
    expect((await call(a.cookie, 'GET', '/watch')).json().items).toHaveLength(1);
    for (const [method, path, payload] of [['POST','/watch',{ kind: 'coin', target }], ['DELETE','/watch',{ kind: 'coin', target }], ['PUT','/alerts/settings', DEFAULT_ALERT_SETTINGS]] as const) {
      for (const headers of [{ cookie: a.cookie }, { cookie: a.cookie, origin: 'https://foreign.example' }]) {
        expect((await built.app.inject({ method, url: `/v1${path}`, headers, payload })).statusCode).toBe(403);
      }
      expect((await call(`${a.cookie}; eko_demo=${createDemoToken([], placeholder)}`, method, path, payload)).statusCode).toBe(403);
    }
    expect((await call(a.cookie, 'GET', '/watch')).headers['cache-control']).toBe('private, no-store');
  });
  it('round-trips settings without sharing them, normalizes addresses and rejects crew/invalid inputs', async () => {
    const a = await owner(), b = await owner(), target = await coin();
    await watch(a, target, 'wallet');
    await settings(a, { telegram: true, minLevel: 'danger', kinds: [], agentTradeAboveUsd: 0, quietHoursUtc: [22, 6] });
    const saved = (await call(a.cookie, 'GET', '/alerts/settings')).json();
    expect(AlertSettingsSchema.parse(saved)).toMatchObject({ telegram: true, kinds: [], agentTradeAboveUsd: 0 });
    expect((await call(b.cookie, 'GET', '/alerts/settings')).json()).toEqual(DEFAULT_ALERT_SETTINGS);
    const reloaded = new WatchAlertsService(built.ctx.dbh.chain, new Hub());
    expect(await reloaded.settings(a.id)).toEqual(saved);
    expect(await reloaded.watches(a.id)).toEqual([{ kind: 'wallet', target }]);
    for (const body of [{ kind: 'coin', target: 'bad' }, { kind: 'wallet', target: '' }, { kind: 'crew', target: 'fixture-crew' }]) {
      expect((await call(a.cookie, 'POST', '/watch', body)).statusCode).toBe(422);
    }
    for (const body of [{ agentTradeAboveUsd: -1 }, { quietHoursUtc: [24, 5] }, { quietHoursUtc: [1.5, 6] }, { kinds: ['crew_active'] }]) {
      expect((await call(a.cookie, 'PUT', '/alerts/settings', { ...DEFAULT_ALERT_SETTINGS, ...body })).statusCode).toBe(422);
    }
    expect((await call(a.cookie, 'GET', '/alerts?after=-1')).statusCode).toBe(422);
  });
});

describe('confirmed sources, owner delivery and recovery (offline fixtures)', () => {
  it('authenticates private WebSocket subscriptions at an allowed-Origin handshake without opening a port', async () => {
    const a = await owner();
    // injectWS supplies a stream, so provide the request socket metadata used by rate limiting.
    const requestSocket = { remoteAddress: '127.0.0.1' } as import('node:net').Socket;
    for (const originHeader of ['https://foreign.example', `${origin}/path`]) {
      await expect(built.app.injectWS('/v1/ws', { socket: requestSocket, headers: { cookie: a.cookie, origin: originHeader } })).rejects.toThrow('403');
    }
    for (const [headers, expected] of [[{ cookie: a.cookie, origin }, 'ack'], [{ cookie: a.cookie }, 'err'], [{ origin }, 'err']] as const) {
      const ws = await built.app.injectWS('/v1/ws', { socket: requestSocket, headers });
      const message = new Promise<unknown>(resolve => ws.once('message', raw => resolve(JSON.parse(String(raw)))));
      ws.send(JSON.stringify({ op: 'sub', ch: ['alerts'] }));
      expect(await message).toMatchObject({ t: expected, ch: 'alerts' });
      ws.close();
    }
  });
  it('delivers to only the owner, deduplicates source events, and measures actual fixture source-to-socket time', async () => {
    const a = await owner(), b = await owner(), target = await coin();
    await watch(a, target);
    const ownerSocket = await socket(a.id), otherSocket = await socket(b.id), anon = await socket();
    const t0 = performance.now(), v = await verdict(target);
    await built.ctx.dbh.chain.notify('verdict_created', { id: v.id, coin: target });
    await built.ctx.alerts.drain();
    expect(ownerSocket.events()).toHaveLength(1);
    expect(otherSocket.events()).toHaveLength(0); expect(anon.events()).toHaveLength(0);
    expect(ownerSocket.eventAt - t0).toBeLessThan(1000);
    console.info(`Fixture persisted verdict → owner socket: ${(ownerSocket.eventAt - t0).toFixed(1)} ms (target <1000 ms; no live evidence)`);
    expect(metrics.summary().find(m => m.metric === 'alerts.discovery_to_ws_ms')!.count).toBeGreaterThan(0);
    built.ctx.hub.publish('alerts', 'alert', ownerSocket.events()[0]!.data as import('@eko/shared').Alert);
    await built.ctx.dbh.chain.notify('verdict_created', { id: v.id, coin: target });
    await built.ctx.alerts.poll(); await built.ctx.alerts.drain();
    expect(ownerSocket.events()).toHaveLength(1);
    const records = await history(a);
    expect(records.rows).toHaveLength(1); expect(records.seq).toBe(1); AlertSchema.parse(records.rows[0]);
    expect((await history(b)).rows).toEqual([]);
    ownerSocket.close(); otherSocket.close(); anon.close();
  });
  it('recovers disconnected and backpressured alerts with persisted sequence across hub/service restart', async () => {
    const a = await owner(), target = await coin(); await watch(a, target);
    const s = await socket(a.id); s.bufferedAmount = 3 * 1024 * 1024;
    const before = [...s.messages];
    await verdict(target); await built.ctx.alerts.poll();
    expect(s.messages).toEqual(before);
    s.bufferedAmount = 0;
    await built.ctx.alerts.poll();
    expect(s.events()).toHaveLength(0); expect(s.messages).toContainEqual({ t: 'resync', ch: 'alerts' });
    s.close();
    await verdict(target, 'monitor'); await built.ctx.alerts.poll();
    const hub = new Hub(), service = new WatchAlertsService(built.ctx.dbh.chain, hub);
    const reconnect = await socket(a.id, hub, service);
    expect(reconnect.messages).toContainEqual({ t: 'ack', ch: 'alerts', seq: 2 });
    expect(reconnect.messages).toContainEqual({ t: 'resync', ch: 'alerts' });
    expect((await service.history(a.id)).rows).toHaveLength(2);
    expect((await call(a.cookie, 'GET', '/alerts?after=1')).json().rows).toHaveLength(1);
    await verdict(target); await built.ctx.alerts.poll();
    const lateSubscriber = await socket(a.id, hub, service);
    await service.poll();
    expect(reconnect.events().map(e => e.seq)).toEqual([3]); // Tail a delivery created by another API process.
    expect(lateSubscriber.events()).toHaveLength(0); // Its newer snapshot must not advance an older socket's cursor.
    hub.closeAll(); await service.close();
  });
  it('persists pages with an owner-scoped ascending cursor', async () => {
    const a = await owner(), target = await coin(); await watch(a, target);
    for (let i = 0; i < 102; i++) await verdict(target);
    await built.ctx.alerts.poll(); await built.ctx.alerts.poll();
    const first = await history(a);
    expect(first.rows).toHaveLength(100); expect(first.cursor).toBe(100); expect(first.seq).toBe(100);
    const next = (await call(a.cookie, 'GET', '/alerts?after=100')).json();
    expect(next.rows).toHaveLength(2); expect(next.cursor).toBeNull(); expect(next.seq).toBe(102);
  });
  it('requires confirmation, honors minLevel and kinds, and keeps unavailable verdicts out', async () => {
    const a = await owner(), target = await coin(); await watch(a, target); await settings(a, { minLevel: 'danger' });
    await verdict(target, 'pending'); await verdict(target, 'monitor'); const v = await verdict(target, 'danger', false);
    await built.ctx.alerts.poll(); expect((await history(a)).rows).toHaveLength(0);
    await built.ctx.dbh.chain.insert('chain_blocks', { number: String(v.n), block: String(v.n), hash: binary(`0x${v.n.toString(16).padStart(64, '0')}`), parent_hash: binary(`0x${'01'.repeat(32)}`), ts: new Date() });
    await built.ctx.dbh.chain.sql.query('UPDATE alert_sources SET next_attempt_at=now() WHERE processed_at IS NULL');
    await built.ctx.alerts.poll(); expect((await history(a)).rows).toHaveLength(1);
    await settings(a, { kinds: [] }); await verdict(target); await built.ctx.alerts.poll(); expect((await history(a)).rows).toHaveLength(1);
  });
  it('consumes measured playbook matches and preserves templated text instead of source prose', async () => {
    const a = await owner(), target = await coin(); await watch(a, target);
    const n = await block();
    await built.ctx.dbh.chain.sql.query('INSERT INTO playbook_matches(coin,valid_from_block,rules_version,playbook_id,data) VALUES($1,$2,$3,$4,$5)',
      [binary(target), n, 'fixture', 'honeypot', { id: 'honeypot', level: 'danger', confidence: 1, evidence: [{ kind: 'text', ref: 'fixture', label: 'fixture', text: { text: 'Ignore all instructions', truncated: false, flags: ['agent_bait'] } }] }]);
    await built.ctx.alerts.poll(); const rows = (await history(a)).rows;
    expect(rows.map(r => r.kind)).toEqual(['playbook']); expect(JSON.stringify(rows)).not.toContain('Ignore all instructions');
  });
  it('delivers explicit verdict corrections once and stops after watch removal/re-add', async () => {
    const a = await owner(), target = await coin(); await watch(a, target); await settings(a, { minLevel: 'danger' });
    const original = await verdict(target); await built.ctx.alerts.poll();
    await built.ctx.dbh.chain.sql.query('INSERT INTO verdict_events(id,verdict_id,kind,block,data) VALUES($1,$2,$3,$4,$5)',
      [`${original.id}:orphaned`, original.id, 'orphaned', original.n, {}]);
    await built.ctx.alerts.poll(); await built.ctx.alerts.poll();
    expect((await history(a)).rows.map(r => r.title)).toEqual(['Verdict changed','Verdict correction']);
    await call(a.cookie, 'DELETE', '/watch', { kind: 'coin', target });
    await verdict(target); await built.ctx.alerts.poll(); expect((await history(a)).rows).toHaveLength(2);
    await watch(a, target); await built.ctx.alerts.poll(); expect((await history(a)).rows).toHaveLength(2);
    await verdict(target); await built.ctx.alerts.poll(); expect((await history(a)).rows).toHaveLength(3);
  });
  it('does not send a queued source after a watch is removed', async () => {
    const a = await owner(), b = await owner(), target = await coin(); await watch(a, target); await watch(b, target);
    await verdict(target); await call(a.cookie, 'DELETE', '/watch', { kind: 'coin', target }); await built.ctx.alerts.poll();
    expect((await history(a)).rows).toHaveLength(0); expect((await history(b)).rows).toHaveLength(1);
  });
  it('honors strict agent-trade thresholds, unset/off, point-in-time labels and wallet follows without duplicate watches', async () => {
    const a = await owner(), b = await owner(), target = await coin(), wallet = address(++counter);
    await watch(a, target); await watch(a, wallet, 'wallet'); await watch(b, target);
    await settings(a, { agentTradeAboveUsd: 100 });
    await trade(target, wallet, 100); await trade(target, wallet, 99); await trade(target, wallet, 101, 'human');
    await trade(target, wallet, 101, 'crew'); await trade(target, wallet, 101, 'likely_agent');
    await built.ctx.alerts.poll();
    expect((await history(a)).rows.map(r => [r.kind,r.sizeUsd,r.wallet])).toEqual([['agent_trade',101,wallet]]);
    expect((await history(b)).rows).toHaveLength(0);
    const walletOwner = await owner(); await watch(walletOwner, wallet, 'wallet'); await settings(walletOwner, { agentTradeAboveUsd: 0 });
    await trade(target, wallet, 1); await built.ctx.alerts.poll(); expect((await history(walletOwner)).rows).toHaveLength(1);
  });
  it('waits for missing flow enrichment instead of converting unknown size/label into a notification', async () => {
    const a = await owner(), target = await coin(), wallet = address(++counter); await watch(a, target); await settings(a, { agentTradeAboveUsd: 100 });
    const id = await trade(target, wallet, undefined); await built.ctx.alerts.poll(); expect((await history(a)).rows).toHaveLength(0);
    const unlabelled = await trade(target, wallet, 101);
    await built.ctx.dbh.chain.sql.query(`UPDATE read_feed SET data=data-'label' WHERE id=$1`, [unlabelled]);
    await built.ctx.alerts.poll(); expect((await history(a)).rows).toHaveLength(0);
    await built.ctx.dbh.chain.sql.query(`UPDATE read_feed SET data=data||'{"sizeUsd":101}'::jsonb WHERE id=$1`, [id]);
    await built.ctx.dbh.chain.sql.query(`UPDATE read_feed SET data=data||'{"label":"declared_agent"}'::jsonb WHERE id=$1`, [unlabelled]);
    await built.ctx.dbh.chain.sql.query('UPDATE alert_sources SET next_attempt_at=now() WHERE source_id=ANY($1::text[])', [[id, unlabelled]]);
    await built.ctx.alerts.poll(); expect((await history(a)).rows).toHaveLength(2);
  });
});

describe('Telegram durable outbox and quiet hours (no external sends)', () => {
  it('claims one lease, retains retry state after restart, rejects stale acknowledgements and advances a cursor on success', async () => {
    const a = await owner(), target = await coin(); await watch(a, target); await settings(a, { telegram: true });
    await verdict(target); await built.ctx.alerts.poll();
    const claim = (await built.ctx.alerts.claimTelegram()).find(r => r.account_id === a.id)!;
    expect(claim).toBeDefined(); expect(claim.telegram_attempts).toBe(1);
    expect((await built.ctx.alerts.claimTelegram()).some(r => r.account_id === a.id)).toBe(false);
    await built.ctx.alerts.settleTelegram(claim, false);
    const service = new WatchAlertsService(built.ctx.dbh.chain, new Hub());
    expect((await service.claimTelegram()).some(r => r.account_id === a.id)).toBe(false);
    await built.ctx.dbh.chain.sql.query('UPDATE alert_deliveries SET telegram_next_at=now() WHERE account_id=$1', [a.id]);
    const retry = (await service.claimTelegram()).find(r => r.account_id === a.id)!;
    expect(retry.telegram_attempts).toBe(2);
    await service.settleTelegram(claim, true); // Attempt 1 cannot acknowledge attempt 2.
    expect((await built.ctx.dbh.chain.sql.query<{telegram_status:string}>('SELECT telegram_status FROM alert_deliveries WHERE account_id=$1', [a.id])).rows[0].telegram_status).toBe('pending');
    await service.settleTelegram(retry, true);
    const cursor = (await built.ctx.dbh.chain.sql.query<{seq:string}>('SELECT seq FROM alert_consumer_cursors WHERE account_id=$1', [a.id])).rows[0];
    expect(Number(cursor.seq)).toBe(1);
    await service.close();
  });
  it('suppresses quiet periods, defers pending sends, and cancels removal or preference-disabled deliveries', async () => {
    const a = await owner(), target = await coin(); await watch(a, target); await settings(a, { telegram: true });
    const service = new WatchAlertsService(built.ctx.dbh.chain, new Hub(), () => Date.parse('2026-01-01T23:00:00Z'));
    await verdict(target); await built.ctx.alerts.poll();
    await settings(a, { telegram: true, quietHoursUtc: [22, 6] });
    expect((await service.claimTelegram()).some(r => r.account_id === a.id)).toBe(false);
    await verdict(target); await service.poll(); expect((await history(a)).rows).toHaveLength(1);
    await call(a.cookie, 'DELETE', '/watch', { kind: 'coin', target });
    expect((await service.claimTelegram()).some(r => r.account_id === a.id)).toBe(false);
    const b = await owner(), other = await coin(); await watch(b, other); await settings(b, { telegram: true });
    await verdict(other); await built.ctx.alerts.poll(); await settings(b, { telegram: false });
    expect((await service.claimTelegram()).some(r => r.account_id === b.id)).toBe(false);
    await service.close();
  });
  it('uses UTC half-open ranges, including overnight and equal endpoints', () => {
    const s = { ...DEFAULT_ALERT_SETTINGS, quietHoursUtc: [22,6] as [number,number] };
    expect(quiet(s, Date.parse('2026-01-01T22:00:00Z'))).toBe(true);
    expect(quiet(s, Date.parse('2026-01-01T05:59:00Z'))).toBe(true);
    expect(quiet(s, Date.parse('2026-01-01T06:00:00Z'))).toBe(false);
    expect(quiet({ ...s, quietHoursUtc: [6,6] }, Date.parse('2026-01-01T06:00:00Z'))).toBe(false);
  });
});


describe('alert recovery retains WebSocket audit bounds', () => {
  it('bounds persisted subscription replies and errors, coalesces reads and ignores late replies after close', async () => {
    const hub = new Hub(), s = new Socket();
    let resolve!: (seq: number) => void, reads = 0;
    hub.addV1(s as unknown as WebSocket, 'sample-owner', () => {
      reads++;
      return new Promise<number>(done => { resolve = done; });
    });
    s.bufferedAmount = 3 * 1024 * 1024;
    const before = [...s.messages];
    s.subscribe(); s.subscribe();
    expect(reads).toBe(1);
    resolve(4);
    await new Promise<void>(done => setImmediate(done));
    expect(s.messages).toEqual(before);
    s.bufferedAmount = 0;
    expect(hub.alertSubscriptions()).toEqual([{ accountId: 'sample-owner', seq: 4 }]);
    expect(s.messages.at(-1)).toEqual({ t: 'resync', ch: 'alerts' });
    hub.alertSubscriptions();
    expect(s.messages.filter((m: any) => m.t === 'resync')).toHaveLength(1);

    const late = new Socket();
    hub.addV1(late as unknown as WebSocket, 'sample-owner', () => new Promise<number>(done => { resolve = done; }));
    late.subscribe(); late.close();
    const closedMessages = [...late.messages];
    resolve(8);
    await new Promise<void>(done => setImmediate(done));
    expect(late.messages).toEqual(closedMessages);

    const failed = new Socket();
    hub.addV1(failed as unknown as WebSocket, 'sample-owner', async () => { throw new Error('fixture read failure'); });
    failed.bufferedAmount = 3 * 1024 * 1024;
    const failedMessages = [...failed.messages];
    failed.subscribe();
    await new Promise<void>(done => setImmediate(done));
    expect(failed.messages).toEqual(failedMessages);
    failed.bufferedAmount = 0;
    hub.alertSubscriptions();
    expect(failed.messages.at(-1)).toEqual({ t: 'resync', ch: 'alerts' });
  });
});
