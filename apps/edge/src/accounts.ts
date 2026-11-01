import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { encodeFunctionData, getAddress, hashMessage, isAddress, parseAbi, recoverMessageAddress, type Address, type Hex } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { AlertSettingsSchema, ELYSIUM_CHAIN_ID, DEFAULT_PREFERENCES, PreferencesSchema, SiweVerifySchema, WatchBodySchema, type AlertSettings, type Me } from '@eko/shared';
import type { Rpc } from './tracker.js';

/**
 * Accounts on Elysium: a wallet signs in (Sign-In With Ethereum), and that wallet is the account. No email, no KYC.
 * Sessions are random tokens in an HttpOnly cookie; only their SHA-256 is stored. Every write must come from the
 * site's own origin. Stored alongside EKO's memory in the same SQLite file.
 */
export const SESSION_COOKIE = 'eko_session';
const SESSION_DAYS = 30, NONCE_TTL_SEC = 600;
export interface Account { id: string; wallet: Address; createdAt: number }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const nowSec = () => Math.floor(Date.now() / 1000);

export class AccountStore {
  constructor(readonly db: DatabaseSync) {
    const version = Number((db.prepare(`SELECT value FROM meta WHERE key = 'accounts.version'`).get() as { value: string } | undefined)?.value ?? 0);
    if (version < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, wallet TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
        CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS preferences(account_id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS watch(account_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(account_id, kind, target));
        CREATE TABLE IF NOT EXISTS consents(account_id TEXT PRIMARY KEY, journal INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS alert_settings(account_id TEXT PRIMARY KEY, data TEXT NOT NULL);
        INSERT INTO meta(key, value) VALUES('accounts.version', '1') ON CONFLICT(key) DO UPDATE SET value = '1';`);
    }
  }

  nonce(): string {
    const n = randomBytes(12).toString('hex');
    this.db.prepare('DELETE FROM nonces WHERE created_at < ?').run(nowSec() - NONCE_TTL_SEC);
    this.db.prepare('INSERT INTO nonces(nonce, created_at) VALUES(?, ?)').run(n, nowSec());
    return n;
  }
  /** Use a nonce once; false when unknown, used or expired. */
  consumeNonce(n: string): boolean {
    const r = this.db.prepare('DELETE FROM nonces WHERE nonce = ? AND created_at >= ?').run(n, nowSec() - NONCE_TTL_SEC);
    return Number(r.changes) === 1;
  }

  accountFor(wallet: Address): Account {
    const w = wallet.toLowerCase();
    const found = this.db.prepare('SELECT * FROM accounts WHERE wallet = ?').get(w) as { id: string; wallet: string; created_at: number } | undefined;
    if (found) return { id: found.id, wallet: getAddress(found.wallet), createdAt: found.created_at };
    const id = `acct_${randomBytes(9).toString('hex')}`;
    this.db.prepare('INSERT INTO accounts(id, wallet, created_at) VALUES(?, ?, ?)').run(id, w, nowSec());
    return { id, wallet: getAddress(w), createdAt: nowSec() };
  }
  openSession(accountId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions(token_hash, account_id, created_at, expires_at) VALUES(?, ?, ?, ?)').run(sha(token), accountId, nowSec(), nowSec() + SESSION_DAYS * 86_400);
    return token;
  }
  closeSession(token: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); }
  bySession(token: string | undefined): Account | null {
    if (!token || token.length > 128) return null;
    const r = this.db.prepare('SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?').get(sha(token), nowSec()) as
      { id: string; wallet: string; created_at: number } | undefined;
    return r ? { id: r.id, wallet: getAddress(r.wallet), createdAt: r.created_at } : null;
  }
  /** Forget the account: sessions, preferences, watchlist, consents, and the account row. */
  erase(accountId: string) {
    for (const t of ['sessions', 'preferences', 'watch', 'consents', 'alert_settings']) this.db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).run(accountId);
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
  }
}

/** A tiny fixed-window limiter per client address (one instance, so memory is enough). */
export function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; until: number }>();
  return (key: string) => {
    const now = Date.now(), h = hits.get(key);
    if (!h || h.until < now) { hits.set(key, { n: 1, until: now + windowMs }); if (hits.size > 50_000) hits.clear(); return true; }
    h.n++; return h.n <= max;
  };
}

const erc1271 = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);

export interface AuthContext { store: AccountStore; rpc?: Rpc; onErase?: (accountId: string) => void }

export function readCookie(req: FastifyRequest, name = SESSION_COOKIE): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
const origin = (req: FastifyRequest) => `${req.protocol}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
/** Writes must come from this site: a cross-site Origin (or Referer) is refused. */
export function sameOrigin(req: FastifyRequest): boolean {
  const o = req.headers.origin ?? (req.headers.referer ? new URL(String(req.headers.referer)).origin : undefined);
  return !o || o === origin(req);
}
export function sessionCookie(req: FastifyRequest, token: string, maxAgeSec: number) {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export function me(account: Account): Me {
  return {
    account: { id: account.id, wallet: account.wallet, linked: [] },
    // One free tier on Elysium until a token exists: everything open, no trading fee.
    entitlements: { tier: 'source', limits: { agents: 3, deepResearchPerDay: 0, loopBacktestsPerDay: 0, realtime: true }, feeBps: 0 },
    trial: { status: 'not_open' }, holdings: { minBalance24h: null }, referralCode: account.id.slice(5, 13),
  };
}

const fail = (reply: FastifyReply, status: number, error: string, message: string) => reply.code(status).send({ error, message });

/** Auth, profile, preferences and watchlist routes, plus `account(req)` for other modules. */
export function registerAccountRoutes(app: FastifyInstance, ctx: AuthContext) {
  const { store } = ctx;
  const nonceLimit = limiter(30, 60_000), verifyLimit = limiter(20, 60_000);
  app.addHook('onRequest', async (req, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.url.startsWith('/v1/') || req.url.startsWith('/v1/rpc')) return;
    if (!sameOrigin(req)) return fail(reply, 403, 'forbidden', 'Cross-site requests are refused.');
  });
  const account = (req: FastifyRequest) => store.bySession(readCookie(req));
  const need = (req: FastifyRequest, reply: FastifyReply) => {
    const a = account(req);
    if (!a) void fail(reply, 401, 'wallet_auth_required', 'Sign in with your wallet to continue.');
    return a;
  };

  app.post('/v1/auth/siwe/nonce', async (req, reply) => {
    if (!nonceLimit(req.ip)) return fail(reply, 429, 'rate_limited', 'Too many sign-in attempts. Try again in a minute.');
    const issued = new Date(), host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
    return { nonce: store.nonce(), domain: host, uri: origin(req), issuedAt: issued.toISOString(), expirationTime: new Date(issued.getTime() + NONCE_TTL_SEC * 1000).toISOString() };
  });

  app.post('/v1/auth/siwe/verify', async (req, reply) => {
    if (!verifyLimit(req.ip)) return fail(reply, 429, 'rate_limited', 'Too many sign-in attempts. Try again in a minute.');
    const body = SiweVerifySchema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'bad_request', 'Malformed sign-in.');
    const message = parseSiweMessage(body.data.message), host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
    if (!message.address || !message.nonce || message.chainId !== ELYSIUM_CHAIN_ID || message.uri !== origin(req) ||
      !validateSiweMessage({ message, domain: host, time: new Date() })) return fail(reply, 401, 'unauthorized', 'This sign-in message is not for this site, chain or time.');
    if (!store.consumeNonce(message.nonce)) return fail(reply, 401, 'unauthorized', 'This sign-in request expired. Try again.');
    const signature = body.data.signature as Hex;
    let ok = false;
    try { ok = (await recoverMessageAddress({ message: body.data.message, signature })).toLowerCase() === message.address.toLowerCase(); } catch { ok = false; }
    if (!ok && ctx.rpc) {
      // A contract wallet signs by EIP-1271.
      try {
        const out = await ctx.rpc.request({ method: 'eth_call', params: [{ to: message.address, data: encodeFunctionData({ abi: erc1271, functionName: 'isValidSignature', args: [hashMessage(body.data.message), signature] }) }, 'latest'] }) as Hex;
        ok = out.slice(0, 10).toLowerCase() === '0x1626ba7e';
      } catch { ok = false; }
    }
    if (!ok) return fail(reply, 401, 'unauthorized', 'The signature does not match the wallet.');
    const a = store.accountFor(getAddress(message.address));
    reply.header('set-cookie', sessionCookie(req, store.openSession(a.id), SESSION_DAYS * 86_400));
    return me(a);
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const token = readCookie(req);
    if (token) store.closeSession(token);
    reply.header('set-cookie', sessionCookie(req, '', 0));
    return { ok: true };
  });

  app.get('/v1/me', async (req, reply) => { const a = need(req, reply); return a ? me(a) : reply; });
  app.get('/v1/me/preferences', async (req, reply) => {
    const a = need(req, reply); if (!a) return reply;
    const r = store.db.prepare('SELECT data FROM preferences WHERE account_id = ?').get(a.id) as { data: string } | undefined;
    return PreferencesSchema.parse(r ? JSON.parse(r.data) : DEFAULT_PREFERENCES);
  });
  app.put('/v1/me/preferences', async (req, reply) => {
    const a = need(req, reply); if (!a) return reply;
    const p = PreferencesSchema.safeParse(req.body);
    if (!p.success) return fail(reply, 400, 'bad_request', 'Invalid preferences.');
    store.db.prepare('INSERT INTO preferences(account_id, data) VALUES(?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data').run(a.id, JSON.stringify(p.data));
    return p.data;
  });
  app.get('/v1/me/journal-consent', async (req, reply) => {
    const a = need(req, reply); if (!a) return reply;
    const r = store.db.prepare('SELECT journal FROM consents WHERE account_id = ?').get(a.id) as { journal: number } | undefined;
    return { optedIn: !!r?.journal };
  });
  app.put<{ Body: { optedIn?: unknown } }>('/v1/me/journal-consent', async (req, reply) => {
    const a = need(req, reply); if (!a) return reply;
    if (typeof req.body?.optedIn !== 'boolean') return fail(reply, 400, 'bad_request', 'optedIn must be true or false.');
    store.db.prepare('INSERT INTO consents(account_id, journal) VALUES(?, ?) ON CONFLICT(account_id) DO UPDATE SET journal = excluded.journal').run(a.id, req.body.optedIn ? 1 : 0);
    return { optedIn: req.body.optedIn };
  });
  app.delete('/v1/me/data', async (req, reply) => {
    const a = need(req, reply); if (!a) return reply;
    ctx.onErase?.(a.id);
    store.erase(a.id);
    reply.header('set-cookie', sessionCookie(req, '', 0));
    return { deletedAt: new Date().toISOString() };
  });
  app.get('/v1/referrals', async (req, reply) => {
    const a = need(req, reply); if (!a) return reply;
    const code = a.id.slice(5, 13);
    return { code, link: `${origin(req)}/?ref=${code}`, referred: 0, qualified: 0, bonusMinutes: 0 };
  });
  app.post('/v1/telegram/link', async (_req, reply) => fail(reply, 503, 'unavailable', 'Telegram alerts are not available on Elysium yet.'));

  app.get('/v1/watch', async (req, reply) => {
    const a = need(req, reply); if (!a) return reply;
    return { items: (store.db.prepare('SELECT kind, target FROM watch WHERE account_id = ? ORDER BY created_at DESC LIMIT 500').all(a.id) as { kind: string; target: string }[]) };
  });
  app.post('/v1/watch', async (req, reply) => {
    const a = need(req, reply); if (!a) return reply;
    const w = WatchBodySchema.safeParse(req.body);
    if (!w.success || (w.data.kind !== 'crew' && !isAddress(w.data.target, { strict: false }))) return fail(reply, 400, 'bad_request', 'Invalid watch target.');
    const target = w.data.kind === 'crew' ? w.data.target : w.data.target.toLowerCase();
    const count = (store.db.prepare('SELECT count(*) AS n FROM watch WHERE account_id = ?').get(a.id) as { n: number }).n;
    if (count >= 500) return fail(reply, 400, 'limit_reached', 'The watchlist holds up to 500 items.');
    store.db.prepare('INSERT INTO watch(account_id, kind, target, created_at) VALUES(?, ?, ?, ?) ON CONFLICT DO NOTHING').run(a.id, w.data.kind, target, nowSec());
    return { kind: w.data.kind, target };
  });
  app.delete<{ Querystring: { kind?: string; target?: string } }>('/v1/watch', async (req, reply) => {
    const a = need(req, reply); if (!a) return reply;
    const w = WatchBodySchema.safeParse((req.body as object | undefined) ?? req.query);
    if (!w.success) return fail(reply, 400, 'bad_request', 'Invalid watch target.');
    store.db.prepare('DELETE FROM watch WHERE account_id = ? AND kind = ? AND target = ?').run(a.id, w.data.kind, w.data.kind === 'crew' ? w.data.target : w.data.target.toLowerCase());
    return { ok: true };
  });

  // Alerts are delivered in the app only on Elysium (no Telegram or push yet); the settings are kept for when they are.
  const DEFAULT_ALERTS: AlertSettings = { telegram: false, push: false, minLevel: 'monitor', kinds: ['verdict_change', 'playbook', 'order'] };
  app.get('/v1/alerts/settings', async (req, reply) => {
    const a = need(req, reply); if (!a) return reply;
    const r = store.db.prepare('SELECT data FROM alert_settings WHERE account_id = ?').get(a.id) as { data: string } | undefined;
    return r ? AlertSettingsSchema.parse(JSON.parse(r.data)) : DEFAULT_ALERTS;
  });
  app.put('/v1/alerts/settings', async (req, reply) => {
    const a = need(req, reply); if (!a) return reply;
    const p = AlertSettingsSchema.safeParse(req.body);
    if (!p.success) return fail(reply, 400, 'bad_request', 'Invalid alert settings.');
    store.db.prepare('INSERT INTO alert_settings(account_id, data) VALUES(?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data').run(a.id, JSON.stringify(p.data));
    return p.data;
  });
  app.get('/v1/alerts', async (req, reply) => { const a = need(req, reply); if (!a) return reply; return { rows: [], cursor: null }; });

  return { account, need };
}
