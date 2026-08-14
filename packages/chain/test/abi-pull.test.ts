import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { abiPullTargets, pullAbi } from '../src/abi-pull.js';
import { loadRegistry } from '../src/registry.js';
describe('abi:pull', () => {
  it('resolves only verified launchpad registry targets', () => {
    expect(abiPullTargets(loadRegistry(), 'pons').map(t => t.name)).toEqual(['factory', 'v4Hook', 'router']);
    expect(() => abiPullTargets(loadRegistry(), 'flap')).toThrow('No verified addresses');
  });
  it('uses the key for the Blockscout API and validates the ABI without network access', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: '1', result: JSON.stringify([{ type: 'event', name: 'TokenLaunched' }]) })));
    expect(await pullAbi(loadRegistry().requireAddress('pons.factory'), 'fixture-api-key', fetcher)).toEqual([{ type: 'event', name: 'TokenLaunched' }]);
    const url = fetcher.mock.calls[0][0] as URL;
    expect(url.searchParams.get('apikey')).toBe('fixture-api-key'); expect(url.searchParams.get('action')).toBe('getabi');
    expect(url.hostname).toBe('robinhoodchain.blockscout.com');
  });
  it('reports bot checks, HTTP failures and unverified contracts without retries or leaking keys', async () => {
    for (const response of [new Response('<html>bot check</html>'), new Response('', { status: 403 }), new Response(JSON.stringify({ status: '0', result: 'Not verified' })), new Response(JSON.stringify({ status: '1', result: '{}' }))]) {
      const fetcher = vi.fn<typeof fetch>(async () => response);
      await expect(pullAbi(loadRegistry().requireAddress('pons.factory'), 'fixture-api-key', fetcher)).rejects.toThrow(/Blockscout/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    await expect(pullAbi(loadRegistry().requireAddress('pons.factory'), 'fixture-api-key', async () => { throw new Error('request contained fixture-api-key'); })).rejects.toThrow('Blockscout request failed');
  });
  it('explains the bot check and local fragments without a key, without fetching', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/abi-pull-cli.ts', 'pons'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, BLOCKSCOUT_API_KEY: '' }, encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('behind a bot check'); expect(result.stderr).toContain('packages/chain/abi/pons/');
  });
  it('rejects incompatible CHAIN_ID before constructing a live RPC check', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/verify-cli.ts'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, CHAIN_ID: '1' }, encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('CHAIN_ID must be 4663');
  });
});
