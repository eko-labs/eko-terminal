import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const Fastify = require('fastify');
export const LogController = Fastify.LogController;
export default function fixtureFastify(options) {
  const app = Fastify(options);
  // Keep real Fastify plugin boot and routing; replace only the forbidden socket bind.
  app.listen = async () => {
    await app.ready();
    if (process.env.APP_ROLE === 'mcp') {
      assert.equal((await app.inject('/health')).json().oauthEnabled, false);
      const denied = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
      assert.equal(denied.statusCode, 401);
      assert.equal((await app.inject('/.well-known/oauth-protected-resource')).statusCode, 404);
      console.log(JSON.stringify({ event: 'built_mcp_routes_ready', socketBound: false }));
      return 'fixture://no-listener';
    }
    const health = await app.inject('/v1/health');
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().ok, true);
    assert.equal(health.json().rpc.sessionUnits, 0);
    for (const path of ['/v1/missing', '/api/missing', '/ws/missing']) {
      const response = await app.inject(path);
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error, 'not_found');
    }
    const spa = await app.inject('/mission/connect');
    assert.equal(spa.statusCode, 200);
    assert.ok(spa.headers['content-type'].includes('text/html'));
    assert.equal(spa.body, readFileSync(join(process.env.WEB_DIST_DIR, 'index.html'), 'utf8'));
    // Exercise the default production renderer, its copied fonts and native workspace dependency.
    const scan = await app.inject(`/v1/scan?q=0x${'1'.repeat(40)}`);
    assert.equal(scan.statusCode, 200);
    const id = scan.json().id;
    const meta = await app.inject(`/v1/share-meta?path=${encodeURIComponent(`/scan/${id}`)}`);
    assert.ok(meta.json().image.endsWith(`/og/scan/${id}.png`));
    const image = await app.inject(`/og/scan/${id}.png`);
    assert.equal(image.statusCode, 200);
    assert.equal(image.rawPayload.readUInt32BE(16), 1200);
    assert.equal(image.rawPayload.readUInt32BE(20), 630);
    assert.ok(image.rawPayload.length > 10000);
    console.log(JSON.stringify({ event: 'built_api_routes_ready', socketBound: false }));
    return 'fixture://no-listener';
  };
  return app;
}
