// Test-only process fixture: no HTTP listeners, sockets or provider traffic.
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./role-image-loader.mjs', import.meta.url), import.meta.url);
globalThis.fetch = async (url, options) => {
  assert.equal(new URL(String(url)).hostname, 'fixture.invalid', 'Unexpected provider request');
  assert.ok(['indexer', 'receipts'].includes(process.env.APP_ROLE), 'Only chain worker fixtures may request RPC');
  const respond = request => {
    let result;
    switch (request.method) {
      case 'eth_chainId': result = '0x1237'; break;
      case 'eth_blockNumber': result = '0x0'; break;
      case 'eth_getBlockByNumber': result = {
        number: '0x0', timestamp: '0x1', hash: `0x${'a'.repeat(64)}`, parentHash: `0x${'0'.repeat(64)}`,
      }; break;
      default: throw new Error('Unexpected fixture RPC method');
    }
    console.log(JSON.stringify({ event: 'fixture_rpc', method: request.method }));
    return { jsonrpc: '2.0', id: request.id, result };
  };
  const request = JSON.parse(options.body);
  return new Response(JSON.stringify(Array.isArray(request) ? request.map(respond) : respond(request)), {
    headers: { 'content-type': 'application/json' },
  });
};
