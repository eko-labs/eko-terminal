import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

it('boots with static web assets and shares one API 404 / SPA fallback handler', async () => {
  const web = await mkdtemp(join(tmpdir(), 'eko-spa-fixture-'));
  const html = '<!doctype html><head><!--eko:head--><title>EKO</title></head><main>Fixture</main>';
  await writeFile(join(web, 'index.html'), html);
  try {
    const built = await buildApp(loadConfig({
      NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'spa-fixture-placeholder'.repeat(3),
      RUN_WORKER: 'false', LEGACY_API: 'false', MARKET_DATA_SOURCE: 'onchain', SERVE_WEB: 'true', WEB_DIST_DIR: web,
    }), { startBackground: false });
    try {
      await built.app.ready();
      for (const path of ['/v1/missing', '/api/missing', '/ws/missing']) {
        const result = await built.app.inject(path);
        expect(result.statusCode).toBe(404);
        expect(result.json()).toMatchObject({ error: 'not_found' });
      }
      const spa = await built.app.inject('/mission/connect');
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toBe(html);
      expect(spa.headers['content-type']).toContain('text/html');
    } finally { await built.close(); }
  } finally { await rm(web, { recursive: true, force: true }); }
});

it('serves the marketing landing at "/" and its files under /site/, leaving terminal routes to the SPA', async () => {
  const web = await mkdtemp(join(tmpdir(), 'eko-spa-fixture-'));
  const landing = await mkdtemp(join(tmpdir(), 'eko-landing-fixture-'));
  const spaHtml = '<!doctype html><head><!--eko:head--><title>EKO</title></head><main>Terminal</main>';
  const landingHtml = '<!doctype html><title>EKO landing</title><script type="module" src="/site/assets/main.js"></script>';
  await writeFile(join(web, 'index.html'), spaHtml);
  await writeFile(join(landing, 'index.html'), landingHtml);
  await writeFile(join(landing, 'docs.html'), '<!doctype html><title>EKO docs</title>');
  await mkdir(join(landing, 'assets'));
  await writeFile(join(landing, 'assets', 'main.js'), 'export {};');
  try {
    const built = await buildApp(loadConfig({
      NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'spa-fixture-placeholder'.repeat(3), RUN_WORKER: 'false',
      LEGACY_API: 'false', MARKET_DATA_SOURCE: 'onchain', SERVE_WEB: 'true', WEB_DIST_DIR: web, LANDING_DIST_DIR: landing,
    }), { startBackground: false });
    try {
      await built.app.ready();
      for (const [path, body] of [['/', landingHtml], ['/?ref=share', landingHtml], ['/site/docs.html', '<!doctype html><title>EKO docs</title>']]) {
        const page = await built.app.inject(path);
        expect(page.statusCode).toBe(200);
        expect(page.body).toBe(body);
        expect(page.headers['content-type']).toContain('text/html');
        expect(page.headers['content-security-policy']).toContain("script-src 'self'");
        expect(page.headers['cache-control']).toBe('no-cache');
      }
      const asset = await built.app.inject('/site/assets/main.js');
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toBe('export {};');
      for (const path of ['/site/missing.js', '/site/index.html']) expect((await built.app.inject(path)).statusCode).toBe(404);
      for (const path of ['/radar', '/index.html']) expect((await built.app.inject(path)).body).toBe(spaHtml);
    } finally { await built.close(); }
  } finally { await Promise.all([rm(web, { recursive: true, force: true }), rm(landing, { recursive: true, force: true })]); }
});
