#!/usr/bin/env node
/**
 * One monitoring pass over the live edge, for any scheduler (a Railway cron service every 5 minutes is the intended home;
 * see SECURITY.md "EKO on Elysium: incidents"):
 *
 *   node scripts/monitor-edge.mjs [--url https://ekoterminal.com] [--commit <sha>] [--max-lag 1800]
 *
 * Checks that /health answers and reports ok, a build commit (the expected one when --commit or EXPECTED_COMMIT is set),
 * chain lag at most --max-lag blocks (about 0.11 s each; a restart backfills, so keep this generous), and storage 'ok'
 * (the storage guard is not refusing user content); then runs scripts/verify-edge.mjs against that commit, which also
 * checks the live trading config (router, Permit2, trade cap) against the repo.
 * On any failure it posts one message to OPS_ALERT_WEBHOOK_URL (Slack- and Discord-compatible JSON; the URL must be
 * https and is never printed) and exits 1. Without the variable it only prints and exits 1, so the scheduler's own
 * failure alert still fires.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const url = opt('--url', process.env.EDGE_URL ?? 'https://ekoterminal.com').replace(/\/$/, '');
const expected = opt('--commit', process.env.EXPECTED_COMMIT ?? '') || null;
const maxLag = Number(opt('--max-lag', process.env.MAX_LAG_BLOCKS ?? '1800'));

const problems = [];
// --test-alert sends one message through the webhook (to prove delivery) and exits 0 when it was accepted.
if (args.includes('--test-alert')) process.exit(await send(`EKO edge monitor: test alert for ${url}. Delivery works; no action needed.`) ? 0 : 1);
let health = null;
try {
  const res = await fetch(`${url}/health`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
  health = await res.json();
  if (!res.ok || health?.ok !== true) problems.push(`health is not ok (HTTP ${res.status}, ok=${health?.ok})`);
} catch (e) { problems.push(`health check failed: ${e.message}`); }

if (health) {
  const commit = health.build?.commit ?? null;
  if (!commit) problems.push('the service reports no build commit');
  else if (expected && commit !== expected) problems.push(`the service runs ${commit.slice(0, 7)}, expected ${expected.slice(0, 7)}`);
  if (!(Number(health.lagBlocks) <= maxLag)) problems.push(`chain lag is ${health.lagBlocks} blocks (limit ${maxLag})`);
  if (health.storage !== 'ok') problems.push(`storage is ${health.storage ?? 'not reported'}: new accounts, agents and orders are being refused`);
  if (commit) {
    try {
      execFileSync('node', [fileURLToPath(new URL('verify-edge.mjs', import.meta.url)), '--url', url, '--commit', commit], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { problems.push(String(e.stderr || e.stdout || e.message).trim().split('\n').pop()); }
  }
}

if (!problems.length) { console.log(`OK: ${url} healthy (commit ${health.build.commit.slice(0, 7)}, lag ${health.lagBlocks}, storage ok, trading config matches).`); process.exit(0); }

const text = `EKO edge alert (${url}):\n- ${problems.join('\n- ')}`;
console.error(text);
await send(text);
process.exit(1);

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
