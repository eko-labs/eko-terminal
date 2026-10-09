import { existsSync, statSync } from 'node:fs';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { DropManifestEntrySchema, PublicConfigSchema, type DropManifestEntry } from '@eko/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { FlagService } from '../src/flags/service.js';
import { configRoutes } from '../src/http/v1/config.js';
import { createDemoToken, DEMO_COOKIE, installDemoGuard } from '../src/http/v1/demo.js';

const fixture = vi.hoisted(() => ({ manifest: [] as DropManifestEntry[] }));
vi.mock('../src/http/v1/drop-manifest.js', () => ({ DROP_DEMO_MANIFEST: fixture.manifest }));
const entry: DropManifestEntry = {
  n: 3, date: '2026-11-10', title: 'Sample paper demo', status: 'live', requiredFlags: ['arena'],
  demo: { videoUrl: '/demos/drops/sample-paper.mp4', recordedAt: '2026-10-01T00:00:00Z' },
  release: { version: 'sample-v1', publishedAt: '2026-10-01T00:00:00Z', url: 'https://example.invalid/releases/sample-v1' },
};
afterEach(() => { fixture.manifest.length = 0; });

describe('CA-9 recorded-demo manifest integration', () => {
  it('keeps the real manifest empty until actual evidence exists; validates any supplied recordings', async () => {
    const actual = await vi.importActual<typeof import('../src/http/v1/drop-manifest.js')>('../src/http/v1/drop-manifest.js');
    expect(actual.DROP_DEMO_MANIFEST).toEqual([]);
    for (const record of actual.DROP_DEMO_MANIFEST) {
      const drop = DropManifestEntrySchema.parse(record);
      const asset = new URL(`../../web/public${drop.demo.videoUrl}`, import.meta.url);
      expect(existsSync(asset)).toBe(true);
      expect(statSync(asset).size).toBeGreaterThan(0);
    }
  });

  it('serves only manifest demos and never treats signed demo overrides as public release flags', async () => {
    const secret = 'sample-demo-secret-placeholder'.repeat(2);
    const cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'sample-session-placeholder'.repeat(2), DEMO_SECRET: secret });
    const service = new FlagService(async () => [], '');
    const app = Fastify();
    await app.register(cookie);
    installDemoGuard(app, cfg);
    await configRoutes(app, cfg, service);
    try {
      expect(PublicConfigSchema.parse((await app.inject('/config')).json()).drops).toEqual([]);
      fixture.manifest.push(entry, { ...entry, status: 'hidden' });
      const publicConfig = PublicConfigSchema.parse((await app.inject('/config')).json());
      expect(publicConfig.drops).toEqual([{ ...entry, status: 'demo' }]);
      const response = await app.inject({ url: '/config', headers: { cookie: `${DEMO_COOKIE}=${createDemoToken(['arena'], secret)}` } });
      const demoConfig = PublicConfigSchema.parse(response.json());
      expect(demoConfig.flags.arena).toBe(true);
      expect(demoConfig.drops).toEqual(publicConfig.drops);
      expect(response.headers['cache-control']).toBe('private, no-store');
    } finally { await app.close(); }
  });

  it('requires enabled public flags as well as manifest publication evidence for live config', async () => {
    fixture.manifest.push(entry, { ...entry, release: undefined });
    const cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'sample-session-placeholder'.repeat(2) });
    const app = Fastify();
    await configRoutes(app, cfg, new FlagService(async () => [], 'arena'));
    try {
      const config = PublicConfigSchema.parse((await app.inject('/config')).json());
      expect(config.drops.map(drop => drop.status)).toEqual(['live', 'demo']);
    } finally { await app.close(); }
  });
});
