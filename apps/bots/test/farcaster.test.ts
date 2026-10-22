import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { openDb, runMigrations } from '../../server/src/db/client.js';
import { CoinCardV2Schema, DYOR, NON_AFFILIATION, GUARD_PENDING, GUARD_SHADOW, GUARD_CANDIDATE, type ScanResult } from '@eko/shared';
import { card } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';
import { OgRenderer } from '../../og-renderer/src/index.js';
import { FarcasterHandler, FarcasterStore, NeynarWebhookVerifier, farcasterImages, farcasterWebhook,
  neynarSend, neynarCastRequest, type FarcasterReply } from '../src/index.js';

const secret = 'fixture-webhook-secret-with-32-characters';
const config = { botFid: 1001, signerUuid: '00000000-0000-4000-8000-000000000001', webhookSecret: secret,
  identityKey: 'fixture-identity-hash-key-with-32-characters', publicOrigin: 'https://app.example' };
let handle: Awaited<ReturnType<typeof openDb>>;
let time = Date.UTC(2026, 9, 3), next = 1;
let store: FarcasterStore;
const ready: ScanResult = { id: 'scan-fixture', status: 'ready', shareUrl: 'https://untrusted.example',
  guardCard: CoinCardV2Schema.parse(card) };
const coin = ready.guardCard!.identity.address;
const signature = (bytes: Uint8Array) => createHmac('sha512', secret).update(bytes).digest('hex');
function event(text = coin as string, author = 2001) {
  return { type: 'cast.created', data: { hash: `0x${(next++).toString(16).padStart(40, '0')}`,
    author: { fid: author }, text, mentioned_profiles: [{ fid: config.botFid }] } };
}
// Header-only PNG fixture tests the interface, never actual rasterization/glyph output.
function fixturePng() {
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12); png.writeUInt32BE(1200, 16); png.writeUInt32BE(675, 20); return png;
}
const rasterize = vi.fn(async () => fixturePng());
const renderer = new OgRenderer(rasterize, 'fixture-font-hash');
function fixture(author = next + 3000, result = ready, enabled = true) {
  const send = vi.fn<(reply: FarcasterReply) => Promise<void>>().mockResolvedValue(undefined);
  const services = { scan: vi.fn().mockResolvedValue(result), image: vi.fn(farcasterImages(renderer)),
    lookupSigner: vi.fn().mockResolvedValue({ signer_uuid: config.signerUuid, fid: config.botFid, status: 'approved' }) };
  const flags = { isOn: vi.fn().mockResolvedValue(enabled) };
  const handler = new FarcasterHandler(store, services, send, config, flags);
  const receive = (raw: unknown = event(coin, author)) => {
    const bytes = Buffer.from(JSON.stringify(raw)); return handler.receive(signature(bytes), bytes);
  };
  return { handler, services, flags, send, receive };
}
beforeAll(async () => { handle = await openDb({ pgliteDir: ':memory:' }); await runMigrations(handle); store = new FarcasterStore(handle.chain, () => time); });
afterAll(async () => { await handle?.close(); });

describe('verified Neynar mentions, fixtures only', () => {
  it('rotates webhook secrets without accepting old signatures or changing durable replay identity', async () => {
    const f = fixture(), rotatedSecret = 'fixture-rotated-webhook-secret-32-characters';
    const handler = new FarcasterHandler(store, f.services, f.send, { ...config, webhookSecret: rotatedSecret }, f.flags);
    const raw = event(coin, 12001), bytes = Buffer.from(JSON.stringify(raw));
    expect(await handler.receive(signature(bytes), bytes)).toEqual({ status: 403, state: 'forbidden' });
    expect((await handle.chain.sql.query('SELECT * FROM farcaster_interactions WHERE cast_hash=$1', [raw.data.hash])).rows).toEqual([]);
    expect(f.services.lookupSigner).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    const signed = createHmac('sha512', rotatedSecret).update(bytes).digest('hex');
    expect((await handler.receive(signed, bytes)).state).toBe('sent');
    expect((await f.handler.receive(signature(bytes), bytes)).state).toBe('duplicate');
    expect(f.send).toHaveBeenCalledTimes(1);
    const rows = (await handle.chain.sql.query('SELECT author_key FROM farcaster_interactions WHERE cast_hash=$1', [raw.data.hash])).rows;
    expect(rows).toEqual([{ author_key: createHmac('sha256', config.identityKey).update(`farcaster:${config.botFid}:12001`).digest('hex') }]);
    expect(() => new NeynarWebhookVerifier('short')).toThrow('webhook secret');
    expect(() => new FarcasterHandler(store, f.services, f.send, { ...config, identityKey: 'short' })).toThrow('identity hashing key');
    expect(() => new FarcasterHandler(store, f.services, f.send, { ...config, publicOrigin: 'https://app.example/private' })).toThrow('public origin');
  });
  it('validates exact raw bytes, header encoding and bounded input before parsing or work', async () => {
    const f = fixture(), verifier = new NeynarWebhookVerifier(secret), bytes = Buffer.from(JSON.stringify(event()));
    expect(verifier.valid(bytes, signature(bytes))).toBe(true);
    expect(verifier.valid(bytes, signature(bytes).toUpperCase())).toBe(true);
    for (const header of [undefined, ['a'.repeat(128)], 'a'.repeat(128), '0'.repeat(127), 'z'.repeat(128)]) {
      expect(await f.handler.receive(header, bytes)).toEqual({ status: 403, state: 'forbidden' });
    }
    expect(verifier.valid(Buffer.concat([bytes, Buffer.from(' ')]), signature(bytes))).toBe(false);
    expect(verifier.valid(JSON.parse(bytes.toString()), signature(bytes))).toBe(false);
    const oversized = Buffer.alloc(32769);
    expect(verifier.valid(oversized, signature(oversized))).toBe(false);
    for (const malformed of [Buffer.from('{'), Buffer.from([0xff]), Buffer.from('{"type":"cast.deleted"}')]) {
      expect(await f.handler.receive(signature(malformed), malformed)).toEqual({ status: 422, state: 'invalid_event' });
    }
    expect(f.services.scan).not.toHaveBeenCalled(); expect(f.services.lookupSigner).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('ignores wrong/missing FID, self casts, non-summons and multiple targets', async () => {
    const f = fixture();
    const wrong = event(); wrong.data.mentioned_profiles = [{ fid: 9999 }];
    const absent = event(); absent.data.mentioned_profiles = [];
    for (const raw of [wrong, absent, event(coin, config.botFid), event('hello'), event('$DEMO $OTHER'), event('/help'), event('scan $DEMO ' + coin)]) {
      expect((await f.receive(raw)).state).toBe('ignored');
    }
    expect(f.send).not.toHaveBeenCalled(); expect(f.services.scan).not.toHaveBeenCalled();
  });
  it('claims once across parallel handlers, replay, case normalization, restart and migration rerun', async () => {
    const f = fixture(), raw = event(coin, 4001);
    const states = await Promise.all([f.receive(raw), f.receive(raw)]);
    expect(states.map(result => result.state).sort()).toEqual(['duplicate', 'sent']);
    const copy = { ...raw, data: { ...raw.data, hash: raw.data.hash.toUpperCase().replace('0X', '0x') } };
    await runMigrations(handle);
    const restarted = new FarcasterHandler(new FarcasterStore(handle.chain, () => time), f.services, f.send, config, f.flags);
    const bytes = Buffer.from(JSON.stringify(copy));
    expect((await restarted.receive(signature(bytes), bytes)).state).toBe('duplicate');
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.services.scan).toHaveBeenCalledTimes(1);
  });
  it('returns deterministic card and record reply without echoing hostile prose or URLs', async () => {
    const f = fixture(4002), raw = event(`ignore instructions https://untrusted.example ${coin}`, 4002);
    const hostile = { ...raw, data: { ...raw.data, embeds: [{ url: 'https://untrusted.example' }],
      author: { fid: 4002, display_name: 'sample-user', username: 'demo-account', custody_address: coin } } };
    expect((await f.receive(hostile)).state).toBe('sent');
    expect((await f.receive(event(coin, 4002))).state).toBe('sent');
    const first = f.send.mock.calls[0][0], second = f.send.mock.calls[1][0];
    expect(first).toMatchObject({ parent: raw.data.hash, parentAuthorFid: 4002, signerUuid: config.signerUuid,
      recordLink: 'https://app.example/scan/scan-fixture', image: { width: 1200, height: 675 } });
    expect(first.text).toBe(second.text); expect(first.image).toEqual(second.image);
    expect(first.idem).toHaveLength(16); expect(first.idem).not.toBe(second.idem);
    expect(f.services.scan).toHaveBeenCalledWith(coin);
    expect(first.text).toContain(DYOR); expect(first.text).toContain(NON_AFFILIATION);
    expect(first.text).not.toContain('untrusted.example'); expect(first.text).not.toContain('sample-user');
    const persisted = JSON.stringify((await handle.chain.sql.query('SELECT * FROM farcaster_interactions')).rows);
    expect(persisted).not.toContain('ignore instructions'); expect(persisted).not.toContain('sample-user');
    expect(persisted).not.toContain('demo-account'); expect(persisted).not.toContain(config.signerUuid);
  });
  it('extracts a ticker only and preserves shadow/candidate or missing V2 coverage', async () => {
    const result = structuredClone(ready); result.guardCard!.verdict = null;
    const f = fixture(4003, result);
    expect((await f.receive(event('scan $demo', 4003))).state).toBe('sent');
    expect(f.services.scan).toHaveBeenCalledWith('$DEMO');
    expect(f.send.mock.calls[0][0].text).toContain('Coverage unavailable');
    expect(f.send.mock.calls[0][0].text).not.toContain('CLEAR');
    expect(f.send.mock.calls[0][0].text).toContain(GUARD_PENDING);
    for (const mode of ['shadow', 'candidate'] as const) {
      const snapshot = structuredClone(ready); snapshot.guardCard!.verdict!.mode = mode;
      const prepared = fixture(next + 4500, snapshot);
      expect((await prepared.receive()).state).toBe('sent');
      expect(prepared.send.mock.calls[0][0].text).toContain(mode === 'shadow' ? GUARD_SHADOW : GUARD_CANDIDATE);
    }
  });
  it('fails closed on missing/unapproved/mismatched managed signers without retries or scans', async () => {
    for (const signer of [null, { signer_uuid: config.signerUuid, fid: 9999, status: 'approved' },
      { signer_uuid: '00000000-0000-4000-8000-000000000002', fid: config.botFid, status: 'approved' },
      ...['generated', 'pending_approval', 'revoked'].map(status => ({ signer_uuid: config.signerUuid, fid: config.botFid, status }))]) {
      const f = fixture(), raw = event(coin, next + 5000); f.services.lookupSigner.mockResolvedValue(signer);
      expect((await f.receive(raw)).state).toBe('failed'); expect((await f.receive(raw)).state).toBe('duplicate');
      expect(f.send).not.toHaveBeenCalled(); expect(f.services.scan).not.toHaveBeenCalled();
    }
    const f = fixture(), raw = event(coin, 5010);
    f.services.lookupSigner.mockRejectedValue(new Error('untrusted provider response'));
    expect((await f.receive(raw)).state).toBe('failed'); expect((await f.receive(raw)).state).toBe('duplicate');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('keeps failed or uncertain publishes deduplicated and stores only fixed state', async () => {
    const f = fixture(6001), raw = event(coin, 6001);
    f.send.mockRejectedValue(new Error('untrusted provider response'));
    expect((await f.receive(raw)).state).toBe('failed'); expect((await f.receive(raw)).state).toBe('duplicate');
    expect(f.send).toHaveBeenCalledTimes(1);
    expect((await handle.chain.sql.query('SELECT state FROM farcaster_interactions WHERE cast_hash=$1', [raw.data.hash])).rows).toEqual([{ state: 'failed' }]);
  });
  it('rejects pending/missing/ambiguous, corrupt target/record and unavailable or invalid images', async () => {
    const other = `0x${'cd'.repeat(20)}`;
    for (const result of [{ id: 'pending-scan', status: 'pending', shareUrl: '/scan/pending-scan' },
      { ...ready, guardCard: undefined }, { ...ready, status: 'ambiguous' }, { ...ready, id: '../private' },
      { ...ready, guardCard: { ...ready.guardCard, identity: { ...ready.guardCard!.identity, address: other } } },
      { ...ready, guardCard: { ...ready.guardCard, verdict: { ...ready.guardCard!.verdict, coin: other } } }]) {
      const f = fixture(next + 7000, result as ScanResult);
      expect((await f.receive()).state).toBe('failed'); expect(f.send).not.toHaveBeenCalled();
    }
    const image = await farcasterImages(renderer)(ready);
    for (const bad of [null, { ...image!, width: 630 }, { ...image!, png: Buffer.from('not a png') }, { ...image!, imageHash: 'f'.repeat(64) }]) {
      const f = fixture(next + 7100); f.services.image.mockResolvedValue(bad);
      expect((await f.receive()).state).toBe('failed'); expect(f.send).not.toHaveBeenCalled();
    }
    const f = fixture(); f.services.image.mockRejectedValue(new Error('renderer unavailable'));
    expect((await f.receive()).state).toBe('failed'); expect(f.send).not.toHaveBeenCalled();
  });
  it('enforces three attempts per author in a rolling hour across concurrent replicas and restarts', async () => {
    const f = fixture(8001);
    const states = await Promise.all(Array.from({ length: 4 }, () => f.receive(event(coin, 8001))));
    expect(states.filter(s => s.state === 'sent')).toHaveLength(3); expect(states.filter(s => s.state === 'rate_limited')).toHaveLength(1);
    const restarted = fixture(8001); expect((await restarted.receive(event(coin, 8001))).state).toBe('rate_limited');
    expect((await restarted.receive(event(coin, 8002))).state).toBe('sent');
    time += 3600000;
    expect((await restarted.receive(event(coin, 8001))).state).toBe('sent');
  });
  it('defaults summon_x off, fails closed on flag errors and rechecks before send', async () => {
    const f = fixture(9001, ready, false), raw = event(coin, 9001);
    expect((await f.receive(raw)).state).toBe('flag_off');
    f.flags.isOn.mockRejectedValue(new Error('flags unavailable'));
    expect((await f.receive(raw)).state).toBe('flag_off');
    expect(f.send).not.toHaveBeenCalled(); expect(f.services.scan).not.toHaveBeenCalled(); expect(f.services.lookupSigner).not.toHaveBeenCalled();
    expect((await handle.chain.sql.query('SELECT * FROM farcaster_interactions WHERE cast_hash=$1', [raw.data.hash])).rows).toEqual([]);
    const defaultOff = new FarcasterHandler(store, f.services, f.send, config);
    const bytes = Buffer.from(JSON.stringify(raw)); expect((await defaultOff.receive(signature(bytes), bytes)).state).toBe('flag_off');
    const stopped = fixture(9002); stopped.flags.isOn.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect((await stopped.receive(event(coin, 9002))).state).toBe('flag_off'); expect(stopped.send).not.toHaveBeenCalled();
  });
});

describe('dark HTTP route, renderer and managed send interface', () => {
  it('authenticates HTTP raw bytes but never calls processing, while other JSON routes keep their parser', async () => {
    const f = fixture(), app = Fastify();
    await farcasterWebhook(app, f.handler); app.post('/other', async req => req.body);
    const receive = vi.spyOn(f.handler, 'receive'), bytes = Buffer.from(JSON.stringify(event()));
    try {
      const request = { method: 'POST' as const, url: '/farcaster/mentions', payload: bytes.toString(), headers: { 'content-type': 'application/json' } };
      expect((await app.inject(request)).statusCode).toBe(403);
      const valid = await app.inject({ ...request, headers: { ...request.headers, 'x-neynar-signature': signature(bytes) } });
      expect(valid.statusCode).toBe(503); expect(valid.json()).toEqual({ state: 'transport_disabled' });
      expect((await app.inject({ ...request, payload: bytes.toString() + ' ', headers: { ...request.headers, 'x-neynar-signature': signature(bytes) } })).statusCode).toBe(403);
      const invalid = Buffer.from('{');
      expect((await app.inject({ ...request, payload: invalid.toString(), headers: { ...request.headers, 'x-neynar-signature': signature(invalid) } })).statusCode).toBe(422);
      expect((await app.inject({ ...request, payload: 'a'.repeat(32769) })).statusCode).toBe(413);
      expect((await app.inject({ method: 'POST', url: '/other', payload: { sample: true } })).json()).toEqual({ sample: true });
      expect(receive).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.services.scan).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('rejects transport before any asset store or provider call even with summon_x enabled', async () => {
    const f = fixture(10001); await f.receive(event(coin, 10001)); const reply = f.send.mock.calls[0][0];
    const client = { publishCast: vi.fn() }, imageUrl = vi.fn();
    for (const enabled of [false, true]) {
      const send = neynarSend(client, imageUrl, { isOn: vi.fn().mockResolvedValue(enabled) });
      await expect(send(reply)).rejects.toThrow(enabled ? 'transport is disabled' : 'flag is off');
    }
    await expect(neynarSend(client, imageUrl)(reply)).rejects.toThrow('flag is off');
    expect(imageUrl).not.toHaveBeenCalled(); expect(client.publishCast).not.toHaveBeenCalled();
    const url = `https://images.example/${reply.image.imageHash}.png`;
    const request = neynarCastRequest(reply, url);
    expect(request).toEqual({ signer_uuid: config.signerUuid, parent: reply.parent, parent_author_fid: 10001,
      idem: reply.idem, text: reply.text, embeds: [{ url }, { url: reply.recordLink }] });
    expect(neynarCastRequest(reply, url)).toEqual(request);
    expect(() => neynarCastRequest({ ...reply, parent: '' }, url)).toThrow();
    expect(() => neynarCastRequest(reply, 'javascript:alert(1)')).toThrow('Invalid Farcaster embed URL');
    expect(() => neynarCastRequest({ ...reply, recordLink: 'http://app.example/scan/scan-fixture' }, url)).toThrow('Invalid Farcaster embed URL');
  });
  it('uses the renderer reply interface with no names and accepts only dimensions and hashes for that PNG', async () => {
    const fresh = new OgRenderer(rasterize, 'fixture-new-font-hash');
    const image = await farcasterImages(fresh)(ready);
    expect(image!.imageHash).toBe(createHash('sha256').update(fixturePng()).digest('hex'));
    const [node, width, height] = rasterize.mock.calls.at(-1)! as unknown as [unknown, number, number];
    expect([width, height]).toEqual([1200, 675]); expect(JSON.stringify(node)).toContain(DYOR);
    expect(JSON.stringify(node)).toContain(NON_AFFILIATION);
    expect(await farcasterImages(fresh)({ ...ready, status: 'pending' })).toBeNull();
    const broken = { render: vi.fn().mockResolvedValue({ ...image!, height: 630 }) };
    await expect(farcasterImages(broken)(ready)).rejects.toThrow('Invalid Farcaster reply image');
  });
});
