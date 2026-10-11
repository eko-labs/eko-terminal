import { roleIdentity } from './build-identity.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

// Closed launch allowlist. New handlers must be explicitly integrated after they land.
export const imageRoles = {
  api: { entry: 'index.js', singleton: false },
  worker: { entry: 'index.js', singleton: true },
  indexer: { entry: 'indexer.js', singleton: true },
  engines: { entry: 'engines.js', singleton: true },
  mcp: { entry: 'mcp.js', singleton: false },
  receipts: { entry: 'receipts.js', singleton: true },
  bots: null,
  og: null,
  swarm: null,
  research: null,
} as const;
export type ImageRole = keyof typeof imageRoles;
export interface RolePlan { role: ImageRole; entry: string; singleton: boolean; env: NodeJS.ProcessEnv }

// Only errors constructed here may be printed by the dispatcher. Raw provider errors stay private.
export class RoleStartupError extends Error {}
/**
 * Format only RoleStartupError messages and suppress arbitrary provider error details. Host
 * dispatcher only; no account authentication; other errors produce fixed withheld-detail text.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function roleStartupMessage(error: unknown): string {
  return `EKO role startup failed: ${error instanceof RoleStartupError ? error.message : 'runtime entry point failed (details withheld)'}`;
}

/**
 * Require an available closed-allowlist role, existing image entry and valid production Postgres
 * configuration; derive RUN_WORKER only for worker role. Host operator controls env/directory; no
 * wallet auth. Unknown/unavailable/missing roles or invalid database config throw RoleStartupError
 * and no role enables trading.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function planRole(env: NodeJS.ProcessEnv, directory: string): RolePlan {
  const role = env.APP_ROLE;
  if (!role || !Object.hasOwn(imageRoles, role)) throw new RoleStartupError('Unknown or missing APP_ROLE');
  const handler = imageRoles[role as ImageRole];
  if (!handler) throw new RoleStartupError(`APP_ROLE=${role} is unavailable in this image`);
  const entry = join(directory, handler.entry);
  if (!existsSync(entry)) throw new RoleStartupError(`APP_ROLE=${role} entry point is missing`);
  if (env.NODE_ENV === 'production' && !env.DATABASE_URL?.trim()) throw new RoleStartupError('DATABASE_URL required in production; PGlite is unavailable');
  if (env.DATABASE_URL) {
    try {
      if (!['postgres:', 'postgresql:'].includes(new URL(env.DATABASE_URL).protocol)) throw new Error();
    } catch { throw new RoleStartupError('DATABASE_URL must be a Postgres URL'); }
  }
  return { role: role as ImageRole, entry, singleton: handler.singleton, env: {
    ...env,
    // API replicas cannot accidentally run another reconciler. No role enables trading.
    RUN_WORKER: role === 'worker' ? 'true' : 'false',
  } };
}

export interface RoleLease { close(): Promise<void> }
/** Session ownership spans startup, runtime and draining; a second owner fails immediately.
 * @remarks
 * Acquire a session advisory lock for configured singleton Postgres roles before spawn; non-
 * singleton/local roles return a no-op lease. Host-only call; connection/duplicate ownership
 * failures reject with bounded RoleStartupError. DB loss invokes lost; local PGlite locking
 * belongs to the database adapter.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function acquireRoleLease(plan: RolePlan, lost: () => void): Promise<RoleLease> {
  // Local PGlite owns its directory through packages/db's process lock instead.
  if (!plan.singleton || !plan.env.DATABASE_URL) return { close: async () => {} };
  const client = new pg.Client({ connectionString: plan.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  let closing = false;
  client.on('error', () => { if (!closing) lost(); });
  client.on('end', () => { if (!closing) lost(); });
  try {
    await client.connect();
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(4663, hashtext($1)) AS acquired', [`eko:role:${plan.role}`],
    );
    if (result.rows[0]?.acquired !== true) throw new RoleStartupError(`APP_ROLE=${plan.role} singleton ownership is already taken`);
    return { close: async () => { closing = true; await client.end(); } };
  } catch (error) {
    closing = true;
    await client.end().catch(() => {});
    if (error instanceof RoleStartupError) throw error;
    throw new RoleStartupError(`APP_ROLE=${plan.role} Postgres connection or ownership check failed`);
  }
}

export interface LaunchDependencies {
  lease: typeof acquireRoleLease;
  spawn: (entry: string, env: NodeJS.ProcessEnv) => ChildProcess;
  /** Logs the build identity of roles that have no ready line of their own; throws to refuse a bad image. */
  announce?: (plan: RolePlan) => void;
}
/** One JSON line the staging verifier compares with the reviewed build: api and worker report theirs themselves. */
export function announceRoleIdentity(plan: RolePlan) {
  if (plan.role === 'api' || plan.role === 'worker') return;
  console.log(JSON.stringify({ msg: 'EKO role identity', identity: roleIdentity(plan.env) }));
}
/** Keep the role lease until the only child has exited, forwarding container termination signals.
 * @remarks
 * Hold the role lease through child exit, forward termination signals and force termination after
 * ten seconds; lost ownership kills the child. Host-only plan execution; no wallet auth.
 * Spawn/lease failures reject, otherwise return the child's exit status and release the lease in
 * finally.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function runRole(plan: RolePlan, dependencies: LaunchDependencies = {
  lease: acquireRoleLease,
  spawn: (entry, env) => spawn(process.execPath, [entry], { env, stdio: 'inherit' }),
  announce: announceRoleIdentity,
}): Promise<number> {
  let child: ChildProcess | undefined;
  let interrupted: NodeJS.Signals | undefined;
  let lost = false;
  let force: NodeJS.Timeout | undefined;
  const stop = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
    child?.kill(signal);
    if (child && !force) { force = setTimeout(() => child?.kill('SIGKILL'), 10_000); force.unref(); }
  };
  const term = () => stop('SIGTERM');
  const int = () => stop('SIGINT');
  process.on('SIGTERM', term);
  process.on('SIGINT', int);
  let lease: RoleLease | undefined;
  try {
    lease = await dependencies.lease(plan, () => {
      // Lost DB ownership cannot leave a competing writer running.
      lost = true;
      child?.kill('SIGKILL');
    });
    if (lost) return 1;
    if (interrupted) return 0;
    dependencies.announce?.(plan);
    child = dependencies.spawn(plan.entry, plan.env);
    return await new Promise<number>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('close', (code, signal) => resolve(lost ? 1 : code ?? (signal === interrupted ? 0 : 1)));
    });
  } finally {
    if (force) clearTimeout(force);
    process.removeListener('SIGTERM', term);
    process.removeListener('SIGINT', int);
    await lease?.close();
  }
}
