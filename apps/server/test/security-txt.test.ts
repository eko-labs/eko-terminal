import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SECURITY_TXT, SECURITY_TXT_EXPIRES, securityTxtRoutes } from '../src/http/security-txt.js';

const DAY = 86_400_000;
// The day the file is first planned to be public (product launch, Oct 13, 2026).
const LAUNCH = Date.parse('2026-10-13T00:00:00Z');

function fields(body: string) {
  const lines = body.split('\n').filter(line => line && !line.startsWith('#'));
  return lines.map(line => {
    const at = line.indexOf(': ');
    return [line.slice(0, at), line.slice(at + 2)] as const;
  });
}

describe('RFC 9116 security.txt', () => {
  it('names the role mailbox, the private advisory form, policy, language, canonical URL and expiry', () => {
    expect(fields(SECURITY_TXT)).toEqual([
      ['Contact', 'mailto:security@ekoterminal.com'],
      ['Contact', 'https://github.com/EkoTerminal/eko/security/advisories/new'],
      ['Expires', SECURITY_TXT_EXPIRES],
      ['Preferred-Languages', 'en'],
      ['Canonical', 'https://ekoterminal.com/.well-known/security.txt'],
      ['Policy', 'https://ekoterminal.com/security'],
    ]);
    // One-line comment only; every other line is a single "Field: value" pair and the file ends with a newline.
    expect(SECURITY_TXT.endsWith('\n')).toBe(true);
    expect(SECURITY_TXT.split('\n').filter(line => line.startsWith('#'))).toHaveLength(1);
    expect(SECURITY_TXT).not.toMatch(/\{\{|TODO|DRAFT|example\.|localhost/i);
  });

  it('expires in RFC 3339 form, after launch and less than a year out', () => {
    expect(SECURITY_TXT_EXPIRES).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const expires = Date.parse(SECURITY_TXT_EXPIRES);
    expect(expires - LAUNCH).toBeGreaterThan(300 * DAY);
    expect(expires - LAUNCH).toBeLessThan(365 * DAY);
  });

  it('serves plain UTF-8 text with nosniff and a public cache on GET and HEAD, without reflecting the request', async () => {
    const app = Fastify();
    await securityTxtRoutes(app);
    try {
      const get = await app.inject({ url: '/.well-known/security.txt?x=<script>', headers: { host: 'attacker.example' } });
      expect(get.statusCode).toBe(200);
      expect(get.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(get.headers['x-content-type-options']).toBe('nosniff');
      expect(get.headers['cache-control']).toBe('public, max-age=86400');
      expect(get.body).toBe(SECURITY_TXT);
      expect(get.body).not.toContain('attacker');
      const head = await app.inject({ method: 'HEAD', url: '/.well-known/security.txt' });
      expect(head.statusCode).toBe(200);
      expect(head.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(head.body).toBe('');
      expect((await app.inject({ method: 'POST', url: '/.well-known/security.txt' })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it('is served by the full app next to the SPA, while other well-known paths stay 404 instead of the SPA', async () => {
    const web = await mkdtemp(join(tmpdir(), 'eko-security-txt-'));
    const html = '<!doctype html><head><!--eko:head--><title>EKO</title></head><main>Fixture</main>';
    await writeFile(join(web, 'index.html'), html);
    try {
      const built = await buildApp(loadConfig({
        NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'security-txt-placeholder'.repeat(3),
        RUN_WORKER: 'false', LEGACY_API: 'false', MARKET_DATA_SOURCE: 'onchain', SERVE_WEB: 'true', WEB_DIST_DIR: web,
      }), { startBackground: false });
      try {
        await built.app.ready();
        const file = await built.app.inject('/.well-known/security.txt');
        expect(file.statusCode).toBe(200);
        expect(file.body).toBe(SECURITY_TXT);
        expect(file.headers['content-type']).toBe('text/plain; charset=utf-8');
        for (const path of ['/.well-known/missing', '/.well-known/oauth-authorization-server']) {
          const missing = await built.app.inject(path);
          expect(missing.statusCode).toBe(404);
          expect(missing.json()).toMatchObject({ error: 'not_found' });
        }
        // The security policy page the file links to is an SPA route.
        expect((await built.app.inject('/security')).body).toBe(html);
      } finally { await built.close(); }
    } finally { await rm(web, { recursive: true, force: true }); }
  });
});
