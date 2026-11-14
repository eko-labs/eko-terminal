#!/usr/bin/env node
/**
 * Post-deploy check: the live edge must report the commit we expect, from a clean build.
 *
 *   node scripts/verify-edge.mjs                          expects this checkout's HEAD at https://ekoterminal.com
 *   node scripts/verify-edge.mjs --commit <sha> --url <origin> --wait 600
 *
 * Exits 0 when GET <url>/health answers ok with build.commit equal to the expected commit; 1 on a mismatch, a missing
 * build identity or an unhealthy service. --wait keeps polling (seconds) while a new deploy rolls out.
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const url = opt('--url', 'https://ekoterminal.com').replace(/\/$/, '');
const expected = opt('--commit', execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
const deadline = Date.now() + Number(opt('--wait', '0')) * 1000;

if (!/^[0-9a-f]{40}$/.test(expected)) { console.error(`Expected commit must be a full SHA, got ${expected}`); process.exit(1); }
let last = 'no answer';
for (;;) {
  try {
    const res = await fetch(`${url}/health`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(10_000) });
    const h = await res.json();
    const commit = h?.build?.commit ?? null;
    if (res.ok && h.ok && commit === expected) { console.log(`OK: ${url} runs ${expected} (lag ${h.lagBlocks} blocks, ${h.coins} coins).`); process.exit(0); }
    last = !commit ? 'the service reports no build commit' : commit !== expected ? `the service runs ${commit}` : `the service is not healthy (ok=${h.ok})`;
  } catch (e) { last = `health check failed: ${e.message}`; }
  if (Date.now() >= deadline) break;
  await new Promise(r => setTimeout(r, 10_000));
}
console.error(`MISMATCH at ${url}: expected ${expected}; ${last}.`);
process.exit(1);
