import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'vite';

test('the Robinhood landing build emits the Whitepaper entry and its assets', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'eko-landing-build-'));
  process.env.VITE_EKO_CHAIN = 'robinhood';
  try {
    await build({ logLevel: 'error', build: { outDir, copyPublicDir: false } });
    const html = readFileSync(join(outDir, 'whitepaper.html'), 'utf8');
    assert.match(html, /<title>EKO Whitepaper<\/title>/);
    assert.match(html, /name="viewport"/);
    const script = html.match(/<script type="module"[^>]+src="\/site\/([^"]+)"/)?.[1];
    assert.ok(script, 'Whitepaper loads a built module from the landing asset prefix');
    assert.match(readFileSync(join(outDir, script), 'utf8'), /EKO Whitepaper/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
