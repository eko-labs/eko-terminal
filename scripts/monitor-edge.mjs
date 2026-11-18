#!/usr/bin/env node
/**
 * One monitoring pass over the live edge services, for any scheduler (a Railway cron service every 5 minutes is the
 * intended home; see SECURITY.md "EKO on Elysium: incidents"):
 *
 *   node scripts/monitor-edge.mjs [--url [<chain>=]https://ekoterminal.com ...] [--chain robinhood] [--commit <sha>] [--max-lag 1800]
 *   node scripts/monitor-edge.mjs --both [--commit <sha>]     Robinhood at ekoterminal.com and Elysium at ELYSIUM_URL
 *
 * One deployment serves one chain, so each service is a target: repeat --url (or list them, comma-separated, in
 * EDGE_URL), each optionally pinned to its chain as `robinhood=https://ekoterminal.com`; --chain (or EXPECTED_CHAIN) pins
 * the targets that name none. For every target it checks that /health answers and reports ok, a build commit (the
 * expected one when --commit or EXPECTED_COMMIT is set; a short SHA matches the full one it starts), chain lag at most
 * --max-lag blocks (a restart backfills, so keep this generous), and storage 'ok' (the storage guard is not refusing
 * user content); then runs scripts/verify-edge.mjs against that commit and chain, which also checks the chain /v1/config
 * reports and the live trading config (routers, Permit2, trade cap) against the repo.
 * On any failure it posts one message to OPS_ALERT_WEBHOOK_URL (Slack- and Discord-compatible JSON; the URL must be
 * https and is never printed) and exits 1. Without the variable it only prints and exits 1, so the scheduler's own
 * failure alert still fires.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Where EKO's Elysium deployment lives once Robinhood Chain has ekoterminal.com (the working value; change it here). */
const ELYSIUM_URL = 'https://elysium.ekoterminal.com';
const ROBINHOOD_URL = 'https://ekoterminal.com';
const CHAINS = ['elysium', 'robinhood'];

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const all = (name) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]] : []));
const expected = String(opt('--commit', process.env.EXPECTED_COMMIT ?? '') || '').toLowerCase() || null;
const maxLag = Number(opt('--max-lag', process.env.MAX_LAG_BLOCKS ?? '1800'));
const pinned = opt('--chain', process.env.EXPECTED_CHAIN ?? '') || null;

/** `[chain=]origin` → a target; an unknown chain or a non-http(s) origin stops the run before anything is fetched. */
const target = (spec) => {
  const m = /^(?:([a-z]+)=)?(https?:\/\/.+)$/.exec(spec.trim());
  if (!m) usage(`not a [chain=]origin: ${spec}`);
  const chain = m[1] ?? pinned;
  if (chain && !CHAINS.includes(chain)) usage(`unknown chain ${chain} (one of ${CHAINS.join(', ')})`);
  return { url: m[2].replace(/\/$/, ''), chain };
};
const specs = args.includes('--both') ? [`robinhood=${ROBINHOOD_URL}`, `elysium=${ELYSIUM_URL}`]
  : (all('--url').length ? all('--url') : [process.env.EDGE_URL ?? ROBINHOOD_URL]).flatMap(s => s.split(/[\s,]+/)).filter(Boolean);
const targets = specs.map(target);
if (expected && !/^[0-9a-f]{7,40}$/.test(expected)) usage(`--commit must be a SHA of at least 7 hex digits, got ${expected}`);

// --test-alert sends one message through the webhook (to prove delivery) and exits 0 when it was accepted.
if (args.includes('--test-alert')) process.exit(await send(`EKO edge monitor: test alert for ${targets.map(t => t.url).join(', ')}. Delivery works; no action needed.`) ? 0 : 1);

const problems = [], ok = [];
for (const t of targets) {
  const found = await check(t), label = targets.length > 1 ? `${t.url}: ` : '';
  if (found.problems.length) problems.push(...found.problems.map(p => `${label}${p}`)); else ok.push(found.summary);
}
if (!problems.length) { for (const line of ok) console.log(line); process.exit(0); }

const text = `EKO edge alert (${targets.map(t => t.url).join(', ')}):\n- ${problems.join('\n- ')}`;
console.error(text);
await send(text);
process.exit(1);

/** One service: health, build commit, lag and storage, then the commit, chain and trading config through verify-edge. */
async function check({ url, chain }) {
  const problems = [];
  let health = null;
  try {
    const res = await fetch(`${url}/health`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
    health = await res.json();
    if (!res.ok || health?.ok !== true) problems.push(`health is not ok (HTTP ${res.status}, ok=${health?.ok})`);
  } catch (e) { problems.push(`health check failed: ${e.message}`); }
  if (!health) return { problems };
  const commit = health.build?.commit ?? null;
  if (!commit) problems.push('the service reports no build commit');
  else if (expected && !String(commit).toLowerCase().startsWith(expected)) problems.push(`the service runs ${commit.slice(0, 7)}, expected ${expected.slice(0, 7)}`);
  if (!(Number(health.lagBlocks) <= maxLag)) problems.push(`chain lag is ${health.lagBlocks} blocks (limit ${maxLag})`);
  if (health.storage !== 'ok') problems.push(`storage is ${health.storage ?? 'not reported'}: new accounts, agents and orders are being refused`);
  if (commit) {
    try {
      execFileSync('node', [fileURLToPath(new URL('verify-edge.mjs', import.meta.url)), '--url', url, '--commit', commit, ...(chain ? ['--chain', chain] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { problems.push(String(e.stderr || e.stdout || e.message).trim().split('\n').pop()); }
  }
  return { problems, summary: `OK: ${url} healthy (${chain ?? 'chain not pinned'}, commit ${String(commit).slice(0, 7)}, lag ${health.lagBlocks}, storage ok, chain and trading config match).` };
}

function usage(why) {
  console.error(`monitor-edge: ${why}\nUsage: node scripts/monitor-edge.mjs [--url [chain=]<origin> ...] [--chain elysium|robinhood] [--both] [--commit <sha>] [--max-lag <blocks>] [--test-alert]`);
  process.exit(2);
}

/** Post one message to OPS_ALERT_WEBHOOK_URL (Slack- and Discord-compatible); true when the webhook accepted it. */
async function send(message) {
  const hook = process.env.OPS_ALERT_WEBHOOK_URL;
  if (!hook) { console.error('OPS_ALERT_WEBHOOK_URL is not set: no alert was sent.'); return false; }
  try {
    const u = new URL(hook);
    if (u.protocol !== 'https:' || u.username || u.password) throw new Error('OPS_ALERT_WEBHOOK_URL must be https without credentials in the URL');
    const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: message, content: message }), signal: AbortSignal.timeout(10_000) });
    console.error(res.ok ? 'Alert sent.' : `Alert webhook answered HTTP ${res.status}.`);
    return res.ok;
  } catch (e) { console.error(`Alert not sent: ${e.message}`); return false; }
}
