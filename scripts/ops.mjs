import { pathToFileURL } from 'node:url';
const kinds = ['guard_miss', 'rpc_outage', 'simulation_failure', 'stale_committer'];
export function prepareOps(args, env = process.env) {
  const [kind, ...options] = args;
  if (!kinds.includes(kind) || options.some(option => option !== '--execute') || options.length > 1)
    throw new Error('Usage: pnpm ops <guard_miss|rpc_outage|simulation_failure|stale_committer> [--execute]');
  const base = new URL(env.OPS_API_ORIGIN ?? 'https://api.eko.example');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/')
    throw new Error('OPS_API_ORIGIN must be a credential-free HTTPS origin');
  const origin = new URL(env.OPS_PUBLIC_ORIGIN ?? 'https://app.eko.example');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/')
    throw new Error('OPS_PUBLIC_ORIGIN must be a credential-free HTTPS origin');
  const execute = options.includes('--execute');
  if (execute && (!env.OPS_SESSION_COOKIE || base.hostname.endsWith('.example')))
    throw new Error('Execution requires a real API origin and authenticated admin session cookie');
  return { kind, execute, url: new URL('/admin/incident', base).href, origin: origin.origin };
}
export async function runOps(args, env = process.env, send = fetch) {
  const plan = prepareOps(args, env);
  if (!plan.execute) return { prepared: true, method: 'POST', url: plan.url, body: { kind: plan.kind } };
  const response = await send(plan.url, { method: 'POST', headers: { 'content-type': 'application/json', origin: plan.origin, cookie: env.OPS_SESSION_COOKIE },
    body: JSON.stringify({ kind: plan.kind }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Incident command refused (${response.status})`);
  // Never print arbitrary server/proxy response text or session credentials.
  return { submitted: true, kind: plan.kind };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runOps(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error instanceof Error ? error.message : 'Incident command failed'); process.exitCode = 1; });
}
