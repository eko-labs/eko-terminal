#!/usr/bin/env node
/**
 * Post-deploy check: the live edge must report the commit we expect, from a clean build.
 *
 *   node scripts/verify-edge.mjs                          expects this checkout's HEAD at https://ekoterminal.com
 *   node scripts/verify-edge.mjs --commit <sha> --url <origin> --wait 600
 *
 * Exits 0 when GET <url>/health answers ok with build.commit equal to the expected commit, and the live trading config at
 * GET <url>/v1/config is the one in the repo: the only router is the registry's Universal Router, the only token spender is
 * the registry's Permit2 (packages/chain/addresses.99901.yaml), and the trade cap is no higher than apps/edge/live-config.json.
 * Exits 1 on any mismatch, a missing build identity or an unhealthy service. --wait keeps polling (seconds) while a new
 * deploy rolls out.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
    if (res.ok && h.ok && commit === expected) { console.log(`OK: ${url} runs ${expected} (lag ${h.lagBlocks} blocks, ${h.coins} coins).`); await checkConfig(); process.exit(0); }
    last = !commit ? 'the service reports no build commit' : commit !== expected ? `the service runs ${commit}` : `the service is not healthy (ok=${h.ok})`;
  } catch (e) { last = `health check failed: ${e.message}`; }
  if (Date.now() >= deadline) break;
  await new Promise(r => setTimeout(r, 10_000));
}
console.error(`MISMATCH at ${url}: expected ${expected}; ${last}.`);
process.exit(1);

/** The live trading config must match the repo: where approvals and swaps go, and how large a trade may be. */
async function checkConfig() {
  const root = new URL('../', import.meta.url);
  const yaml = readFileSync(new URL('packages/chain/addresses.99901.yaml', root), 'utf8');
  const address = (name) => new RegExp(`^\\s*${name}:\\s*\\{\\s*address:\\s*"(0x[0-9a-fA-F]{40})"`, 'm').exec(yaml)?.[1]?.toLowerCase();
  const router = address('universalRouter212'), permit2 = address('permit2');
  const { maxTradeUsd } = JSON.parse(readFileSync(new URL('apps/edge/live-config.json', root), 'utf8'));
  const lower = (list) => (Array.isArray(list) ? list : []).map(a => String(a).toLowerCase());
  const t = (await (await fetch(`${url}/v1/config`, { signal: AbortSignal.timeout(10_000) })).json())?.trading;
  const problems = [];
  if (!router || !permit2) problems.push('the registry has no universalRouter212 or permit2 address');
  if (!t) problems.push('/v1/config publishes no trading config');
  else {
    if (JSON.stringify(lower(t.routers)) !== JSON.stringify([router])) problems.push(`routers ${JSON.stringify(t.routers)} are not exactly the registry's Universal Router ${router}`);
    if (lower(t.spenders).some(s => s !== permit2) || String(t.permit2).toLowerCase() !== permit2) problems.push(`spenders ${JSON.stringify(t.spenders)} / permit2 ${t.permit2} are not the registry's Permit2 ${permit2}`);
    if (!(typeof t.maxTradeUsd === 'number' && t.maxTradeUsd > 0 && t.maxTradeUsd <= maxTradeUsd)) problems.push(`maxTradeUsd ${t.maxTradeUsd} is above the repo's ${maxTradeUsd}`);
  }
  if (problems.length) { console.error(`CONFIG MISMATCH at ${url}: ${problems.join('; ')}.`); process.exit(1); }
  console.log(`OK: live trading config matches the repo (router ${router}, Permit2 ${permit2}, max trade $${t.maxTradeUsd} ≤ $${maxTradeUsd}).`);
}
