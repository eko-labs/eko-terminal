import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'https://eko.example';
let output: string, source: string;
beforeAll(async () => {
  output = await mkdtemp(path.join(tmpdir(), 'eko-pwa-test-'));
  await build({ root, logLevel: 'silent', build: { outDir: output, sourcemap: false } });
  source = await readFile(path.join(output, 'sw.js'), 'utf8');
});
afterAll(async () => { if (output) await rm(output, { recursive: true, force: true }); });

function worker() {
  const stores = new Map<string, Map<string, Response>>();
  const handlers = new Map<string, (event: unknown) => void>();
  const key = (request: Request | string) => typeof request === 'string' ? new URL(request, origin).href : request.url;
  const caches = {
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    open: vi.fn(async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const cache = stores.get(name)!;
      return {
        put: async (request: Request | string, response: Response) => { cache.set(key(request), response.clone()); },
        match: async (request: Request | string) => cache.get(key(request))?.clone(),
        keys: async () => [...cache.keys()].map(url => new Request(url)),
        delete: async (request: Request | string) => cache.delete(key(request)),
      };
    }),
  };
  const fetch = vi.fn(async (request: Request) => {
    const file = path.join(output, new URL(request.url).pathname);
    try { return new Response(await readFile(file)); }
    catch { return new Response('network response'); }
  });
  const claim = vi.fn(async () => undefined);
  runInNewContext(source, { URL, Request, Response, caches, fetch, location: { origin }, clients: { claim },
    addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler) });
  const lifecycle = async (type: string) => {
    let work!: Promise<unknown>; handlers.get(type)!({ waitUntil: (pending: Promise<unknown>) => { work = pending; } }); await work;
  };
  const request = (pathname: string, init: RequestInit = {}, navigate = false) => {
    const req = new Request(new URL(pathname, origin), init);
    if (navigate) Object.defineProperty(req, 'mode', { value: 'navigate' });
    let response!: Promise<Response>; handlers.get('fetch')!({ request: req, respondWith: (pending: Promise<Response>) => { response = pending; } });
    return response;
  };
  return { stores, caches, fetch, handlers, claim, lifecycle, request };
}
const sensitive = ['/v1/orders', '/v1/approvals?status=pending', '/v1/agents/demo-agent/journal', '/v1/receipts/demo-receipt',
  '/v1/me', '/api/orders', '/v2/coins/demo-coin', '/og/demo-card.png', '/images/og/demo-card', '/share/demo-card.png',
  'https://api.example/v1/approvals'];

describe('production PWA (built artifacts and fake browser worker, no ports)', () => {
  it('emits linked standalone manifest, shortcuts, PNG sizes and an opaque maskable icon', async () => {
    const manifest = JSON.parse(await readFile(path.join(output, 'manifest.webmanifest'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'EKO', short_name: 'EKO', display: 'standalone', scope: '/', start_url: '/mission?src=pwa', background_color: '#05121c', theme_color: '#05121c' });
    expect(manifest.shortcuts).toEqual([{ name: 'Approvals', url: '/mission/approvals' }, { name: 'Scan', url: '/scan' }, { name: 'Radar', url: '/radar' }]);
    expect(manifest.icons).toHaveLength(3);
    for (const icon of manifest.icons) {
      const png = await readFile(path.join(output, icon.src));
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
      if (icon.purpose === 'maskable') expect(png[25]).toBe(2); // Opaque RGB.
    }
    const html = await readFile(path.join(output, 'index.html'), 'utf8');
    expect(html).toContain('href="/manifest.webmanifest"'); expect(html).toContain('content="#05121c"');
    expect(source).not.toMatch(/EKO_SHELL|EKO_PRECACHE|EKO_VERSION|skipWaiting|pushManager|notificationclick/);
  });
  it('precaches the emitted shell, serves offline navigation and fonts cache-first without storing page data', async () => {
    const w = worker(); await w.lifecycle('install'); await w.lifecycle('activate');
    const cache = [...w.stores.values()][0]!;
    expect(cache.has(`${origin}/index.html`)).toBe(true);
    const html = await (await w.request('/index.html')).text();
    const script = html.match(/src="(\/assets\/[^\"]+\.js)"/)![1]!;
    expect(cache.has(`${origin}${script}`)).toBe(true);
    expect(w.fetch.mock.calls.every(([request]) => request.credentials === 'omit' && request.cache === 'reload')).toBe(true);
    w.fetch.mockRejectedValue(new TypeError('Offline')); w.fetch.mockClear();
    expect(await (await w.request('/approve/demo-approval', {}, true)).text()).toBe(html);
    expect((await w.request(script)).ok).toBe(true);
    expect((await w.request('/fonts/Geist-Variable.woff2')).ok).toBe(true);
    expect(w.fetch).toHaveBeenCalledTimes(1); // Only navigation tried the network.
    expect(cache.has(`${origin}/approve/demo-approval`)).toBe(false);
    await expect(w.request(`${script}?private=demo`)).rejects.toThrow('Offline');
  });
  it('installs without wallet/chart/route JS and caches deferred chunks only when requested', async () => {
    const graph = JSON.parse(await readFile(path.join(output, 'budget-graph.json'), 'utf8')) as { file: string; modules: string[] }[];
    const deferred = graph.filter(c => c.modules.some(m => /\/WalletRuntime\.tsx$|\/chart\/ChartStage\.tsx$|\/pages\/terminal\/Feed\.tsx$/.test(m)));
    expect(deferred.length).toBeGreaterThanOrEqual(3);
    const w = worker(); await w.lifecycle('install');
    const cache = [...w.stores.values()][0]!;
    for (const chunk of deferred) {
      expect(cache.has(`${origin}/${chunk.file}`)).toBe(false);
      expect((await w.request(`/${chunk.file}`)).ok).toBe(true);
      expect(cache.has(`${origin}/${chunk.file}`)).toBe(true);
    }
  });
  it('never reads or writes cached sensitive responses, even when poisoned, offline or signed out', async () => {
    const w = worker(); await w.lifecycle('install');
    const cache = [...w.stores.values()][0]!;
    for (const endpoint of sensitive) cache.set(new URL(endpoint, origin).href, new Response('private fixture'));
    for (const endpoint of sensitive) {
      expect(await (await w.request(endpoint)).text()).toBe('network response');
      expect(w.fetch.mock.lastCall![0].cache).toBe('no-store');
    }
    await w.request('/v1/auth/logout', { method: 'POST' });
    expect(w.fetch.mock.lastCall![0]).toMatchObject({ method: 'POST', cache: 'no-store' });
    w.fetch.mockRejectedValue(new TypeError('Offline'));
    for (const endpoint of sensitive) await expect(w.request(endpoint)).rejects.toThrow('Offline');
    await expect(w.request('/v1/approvals/demo-approval/decide', { method: 'POST', body: '{}' })).rejects.toThrow('Offline');
    expect(w.handlers.has('push')).toBe(false); expect(w.handlers.has('notificationclick')).toBe(false);
  });
  it('purges obsolete and poisoned EKO caches on update and cannot replay orders, approvals, journals or receipts', async () => {
    const w = worker(); await w.lifecycle('install');
    const current = [...w.stores.values()][0]!;
    const old = new Map<string, Response>();
    for (const endpoint of sensitive) {
      const key = new URL(endpoint, origin).href;
      old.set(key, new Response('old private fixture')); current.set(key, new Response('poisoned fixture'));
    }
    w.stores.set('eko-pwa-obsolete', old); w.stores.set('other-app', new Map());
    await w.lifecycle('activate');
    expect(w.stores.has('eko-pwa-obsolete')).toBe(false); expect(w.stores.has('other-app')).toBe(true);
    expect(w.claim).toHaveBeenCalledTimes(1);
    for (const endpoint of sensitive) expect(current.has(new URL(endpoint, origin).href)).toBe(false);
    w.fetch.mockRejectedValue(new TypeError('Offline after update'));
    for (const endpoint of sensitive) await expect(w.request(endpoint)).rejects.toThrow('Offline after update');
  });
});
