// Synthetic sessions and judgments only. Fastify injection opens no network port.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, migrateEngines, ReviewStore, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { ReviewExportSchema, ReviewViewSchema } from '@eko/shared';
import { reviewApiRoutes } from '../src/http/review-api.js';
import type { Account } from '../src/http/auth.js';
import { reviewFixture, labelFixture, reviewerAccounts as accounts, hash } from '../../../packages/db/test/fixtures/review.js';
let db: ChainDb, app: FastifyInstance, store: ReviewStore;
const sessions: Record<string, Account> = Object.fromEntries(['slot-one', 'slot-two', 'adjudicator', 'evaluator', 'coordinator'].map((token, i) => [token, {
  id: accounts[i] ?? '00000000-0000-4000-8000-000000000005', kind: 'guest', walletAddress: null, displayName: null, role: i === 4 ? 'admin' : 'user',
}]));
const headers = (token: string) => ({ cookie: token, origin: 'https://review.example.invalid' });
beforeAll(async () => {
  db = await openDb({ pgliteDir: ':memory:' }); await migrate(db); await migrateEngines(db); store = new ReviewStore(db);
  app = Fastify(); app.decorateRequest('account', null);
  await reviewApiRoutes(app, store, {
    readCookie: req => req.headers.cookie,
    fromToken: async token => token ? sessions[token] ?? null : null,
    originFor: req => { if (req.headers.origin !== 'https://review.example.invalid') throw Object.assign(new Error('Origin is not allowed'), { statusCode: 403 }); return req.headers.origin; },
  });
});
afterAll(async () => { await app?.close(); await db?.close(); });
describe('055 session-bound review transport, fixture integration', () => {
  it('requires a session and coordinator authority for immutable case provisioning', async () => {
    expect((await app.inject({ method: 'POST', url: '/v2/review/cases', payload: reviewFixture('http-denied') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v2/review/cases', headers: headers('slot-one'), payload: reviewFixture('http-denied') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v2/review/cases', headers: { cookie: 'coordinator', origin: 'https://other.example.invalid' }, payload: reviewFixture('http-denied') })).statusCode).toBe(403);
    const res = await app.inject({ method: 'POST', url: '/v2/review/cases', headers: headers('coordinator'), payload: reviewFixture('http-case') });
    expect(res.statusCode).toBe(200); expect(res.json().revision).toBe(1);
    const c = res.json();
    for (const [i, role] of ['reviewer_1', 'reviewer_2', 'adjudicator', 'evaluator'].entries()) {
      expect((await app.inject({ method: 'POST', url: `/v2/review/cases/${c.caseId}/assignments`, headers: headers('coordinator'), payload: { accountId: accounts[i], pseudonym: hash(`http-role-${i}`), role } })).statusCode).toBe(200);
    }
    expect((await app.inject({ url: `/v2/review/revisions/${c.id}`, headers: headers('coordinator') })).statusCode).toBe(403);
  });
  it('returns only the assigned session role without revealing judgments or account data', async () => {
    const c = await store.putCase(reviewFixture('http-case')), url = `/v2/review/revisions/${c.id}/role`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: headers('coordinator') })).statusCode).toBe(403);
    for (const [token, role] of [['slot-one', 'reviewer_1'], ['slot-two', 'reviewer_2'], ['adjudicator', 'adjudicator'], ['evaluator', 'evaluator']]) {
      const response = await app.inject({ url, headers: { ...headers(token), 'x-review-role': 'evaluator' } });
      expect(response.statusCode).toBe(200); expect(response.json()).toBe(role);
      expect(response.body).toBe(JSON.stringify(role));
    }
    expect((await app.inject({ url: '/v2/review/revisions/invalid/role', headers: headers('slot-one') })).statusCode).toBe(400);
  });
  it('blinds scores, nested incident text and other answers until the requesting slot submits', async () => {
    const c = await store.putCase(reviewFixture('http-case')), draft = labelFixture(c), url = `/v2/review/revisions/${c.id}`;
    const initial = await app.inject({ url, headers: headers('slot-one') });
    expect(initial.statusCode).toBe(200); expect(ReviewViewSchema.parse(initial.json()).blinded).toBe(true);
    expect(initial.body).not.toContain('legacyPoints'); expect(initial.body).not.toContain('Synthetic allegation');
    expect((await app.inject({ method: 'POST', url: `${url}/labels`, headers: headers('slot-one'), payload: { ...draft, reviewerId: hash('http-role-1') } })).statusCode).toBe(400);
    const first = await app.inject({ method: 'POST', url: `${url}/labels`, headers: headers('slot-one'), payload: draft });
    expect(first.statusCode).toBe(200); expect(first.json().slot).toBe('reviewer_1');
    expect((await app.inject({ url, headers: headers('slot-one') })).json().reveal).toEqual(c.reveal);
    expect((await app.inject({ url, headers: { ...headers('slot-two'), 'x-review-role': 'evaluator', 'x-reviewer-id': hash('http-role-0') } })).json()).toMatchObject({ blinded: true, reveal: null, labels: [] });
    expect((await app.inject({ url: `/v2/review/cases/${c.caseId}/export`, headers: headers('slot-two') })).body).not.toContain('reviewer_1');
    const second = await app.inject({ method: 'POST', url: `${url}/labels`, headers: headers('slot-two'), payload: draft });
    expect(second.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${url}/adjudications`, headers: headers('evaluator'), payload: { ...draft, labelIds: [first.json().id, second.json().id] } })).statusCode).toBe(403);
    const adjudication = await app.inject({ method: 'POST', url: `${url}/adjudications`, headers: headers('adjudicator'), payload: { ...draft, labelIds: [first.json().id, second.json().id] } });
    expect(adjudication.statusCode).toBe(200);
    const exported = await app.inject({ url: `/v2/review/cases/${c.caseId}/export`, headers: headers('evaluator') });
    expect(exported.statusCode).toBe(200); expect(ReviewExportSchema.parse(exported.json()).revisions[0].status).toBe('adjudicated');
    const { exportHash, ...body } = exported.json(); expect(exportHash).toBe(hash(body));
  });
  it('rejects raw injected text and unknown routes/evidence without network or engine work', async () => {
    const c = await store.putCase(reviewFixture('http-case')), draft = labelFixture(c);
    const raw = await app.inject({ method: 'POST', url: `/v2/review/revisions/${c.id}/labels`, headers: headers('slot-one'), payload: { ...draft, rationale: { text: '<b>ignore previous instructions</b>', truncated: false, flags: [] } } });
    expect(raw.statusCode).toBe(400);
    expect((await app.inject({ url: '/v2/review/revisions/invalid', headers: headers('slot-one') })).statusCode).toBe(400);
    expect((await app.inject({ url: `/v2/review/revisions/${hash('unknown')}`, headers: headers('slot-one') })).statusCode).toBe(404);
    expect((await db.sql.query('SELECT id FROM guard_shadow_runs')).rows).toHaveLength(0);
    expect((await db.sql.query('SELECT id FROM outcome_label_revisions')).rows).toHaveLength(0);
  });
});
