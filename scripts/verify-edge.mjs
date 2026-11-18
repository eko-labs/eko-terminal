#!/usr/bin/env node
/**
 * Post-deploy check: the live edge must report the commit and chain we expect, from a clean build.
 *
 *   node scripts/verify-edge.mjs                          expects this checkout's HEAD at https://ekoterminal.com
 *   node scripts/verify-edge.mjs --commit <sha> --url <origin> --chain robinhood --wait 600
 *
 * Exits 0 when GET <url>/health answers ok with build.commit equal to the expected commit (a full SHA, or a short one of
 * at least 7 hex digits that the full one starts with), and GET <url>/v1/config reports a supported chain (the --chain
 * one when given: elysium or robinhood) and that chain's trading config from the repo: the routers and token spenders
 * are the chain registry's own (packages/chain/addresses.<chainId>.yaml) and the trade cap is no higher than
 * apps/edge/live-config.json. Elysium: the only router is the Universal Router, the only spender Permit2. Robinhood:
 * every router is the Uniswap v4 Universal Router or the Pons router, every spender Permit2 or the Pons router.
 * Without --chain the service's own chain is checked against its registry, and the chain is printed, not pinned.
 * Exits 1 on any mismatch, a missing build identity or an unhealthy service. --wait keeps polling (seconds) while a new
 * deploy rolls out.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Each chain's id and the registry entries its live trading config may name (exactly, for Elysium). */
const CHAINS = {
  elysium: { id: 99901, routers: ['universalRouter212'], spenders: ['permit2'], exact: true },
  robinhood: { id: 4663, routers: ['universalRouter', 'router'], spenders: ['permit2', 'router'], exact: false },
};

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const url = opt('--url', 'https://ekoterminal.com').replace(/\/$/, '');
const expected = String(opt('--commit', '') || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toLowerCase();
const chain = opt('--chain', process.env.EXPECTED_CHAIN || '') || null;
const deadline = Date.now() + Number(opt('--wait', '0')) * 1000;

if (!/^[0-9a-f]{7,40}$/.test(expected)) { console.error(`Expected commit must be a SHA (at least 7 hex digits), got ${expected}`); process.exit(1); }
if (chain && !(chain in CHAINS)) { console.error(`--chain must be one of ${Object.keys(CHAINS).join(', ')}, got ${chain}`); process.exit(1); }
const runs = (commit) => typeof commit === 'string' && commit.toLowerCase().startsWith(expected);
let last = 'no answer';
for (;;) {
  try {
    const res = await fetch(`${url}/health`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(10_000) });
    const h = await res.json();
    const commit = h?.build?.commit ?? null;
    if (res.ok && h.ok && runs(commit)) { console.log(`OK: ${url} runs ${commit} (lag ${h.lagBlocks} blocks, ${h.coins} coins).`); await checkConfig(); process.exit(0); }
    last = !commit ? 'the service reports no build commit' : !runs(commit) ? `the service runs ${commit}` : `the service is not healthy (ok=${h.ok})`;
  } catch (e) { last = `health check failed: ${e.message}`; }
  if (Date.now() >= deadline) break;
  await new Promise(r => setTimeout(r, 10_000));
}
console.error(`MISMATCH at ${url}: expected ${expected}; ${last}.`);
process.exit(1);

/** The live chain and trading config must match the repo: which chain, where approvals and swaps go, how large a trade may be. */
async function checkConfig() {
  const root = new URL('../', import.meta.url);
  const config = await (await fetch(`${url}/v1/config`, { signal: AbortSignal.timeout(10_000) })).json();
  const live = config?.chain, key = live?.key;
  const fail = (problems) => { console.error(`CONFIG MISMATCH at ${url}: ${problems.join('; ')}.`); process.exit(1); };
  // The chain first: every other check reads that chain's registry.
  if (!live || !(key in CHAINS)) fail([`/v1/config reports no supported chain (${JSON.stringify(live ?? null)})`]);
  if (live.id !== CHAINS[key].id) fail([`/v1/config reports chain ${key} with id ${live.id}, not ${CHAINS[key].id}`]);
  if (chain && key !== chain) fail([`the service runs ${key} (${live.id}), expected ${chain} (${CHAINS[chain].id})`]);
  const want = CHAINS[key];

  let yaml;
  try { yaml = readFileSync(new URL(`packages/chain/addresses.${want.id}.yaml`, root), 'utf8'); }
  catch { fail([`the repo has no packages/chain/addresses.${want.id}.yaml to compare ${key} against`]); }
  const address = (name) => new RegExp(`^\\s*${name}:\\s*\\{\\s*address:\\s*"(0x[0-9a-fA-F]{40})"`, 'm').exec(yaml)?.[1]?.toLowerCase();
  const routers = want.routers.map(address), spenders = want.spenders.map(address), permit2 = address('permit2');
  const { maxTradeUsd } = JSON.parse(readFileSync(new URL('apps/edge/live-config.json', root), 'utf8'));
  const lower = (list) => (Array.isArray(list) ? list : []).map(a => String(a).toLowerCase());
  const t = config?.trading;
  const problems = [];
  if (routers.some(a => !a) || spenders.some(a => !a) || !permit2) problems.push(`the ${key} registry lacks one of ${[...want.routers, ...want.spenders].join(', ')}`);
  if (!t) problems.push('/v1/config publishes no trading config');
  // TRADING=off (a first deploy, or a rollback): nothing is quoted, so no router, spender or trade size is published.
  else if (t.liveEnabled === false) {
    if (lower(t.routers).length || lower(t.spenders).length || t.maxTradeUsd !== 0) problems.push(`trading is off but /v1/config still lists routers ${JSON.stringify(t.routers)}, spenders ${JSON.stringify(t.spenders)} or max $${t.maxTradeUsd}`);
    if (problems.length) fail(problems);
    console.log(`OK: ${url} runs ${key} (${live.id})${chain ? '' : ', chain not pinned (pass --chain to require one)'}; trading is off (no routers or spenders published).`);
    return;
  }
  else {
    const liveRouters = lower(t.routers), liveSpenders = lower(t.spenders);
    if (want.exact ? JSON.stringify(liveRouters) !== JSON.stringify(routers) : !liveRouters.length || liveRouters.some(r => !routers.includes(r)))
      problems.push(`routers ${JSON.stringify(t.routers)} are not ${want.exact ? 'exactly' : 'within'} the registry's ${want.routers.join(' and ')} ${routers.join(', ')}`);
    if (liveSpenders.some(s => !spenders.includes(s)) || String(t.permit2).toLowerCase() !== permit2) problems.push(`spenders ${JSON.stringify(t.spenders)} / permit2 ${t.permit2} are not the registry's ${want.spenders.join(' or ')} ${spenders.join(', ')}`);
    if (!(typeof t.maxTradeUsd === 'number' && t.maxTradeUsd > 0 && t.maxTradeUsd <= maxTradeUsd)) problems.push(`maxTradeUsd ${t.maxTradeUsd} is not between $1 and the repo's $${maxTradeUsd}`);
  }
  if (problems.length) fail(problems);
  console.log(`OK: ${url} runs ${key} (${live.id})${chain ? '' : ', chain not pinned (pass --chain to require one)'}; live trading config matches the repo (routers ${lower(t.routers).join(', ')}, Permit2 ${permit2}, max trade $${t.maxTradeUsd} ≤ $${maxTradeUsd}).`);
}
