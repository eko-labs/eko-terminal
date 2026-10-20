import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';

/** Concurrent pumps propagate backpressure and any producer/consumer failure.
 * Discard tool stderr: libpq and age diagnostics can contain secret locations.
 * Never use a shell, put connection URLs in argv, or stage plaintext on disk.
 * @remarks
 * Spawn the supplied command pipeline without a shell, await every exit, and kill all stages on
 * stream/process failure. Authorized backup operator controls stage commands/env and endpoints; no
 * credential validation occurs here. Spawn, pipeline and nonzero-exit failures reject, with child
 * stderr excluded from output.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function runStream(stages: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[], input?: Readable, output?: Writable) {
  const children = stages.map(stage => spawn(stage.command, stage.args, {
    env: stage.env ?? process.env, stdio: ['pipe', 'pipe', 'ignore'],
  }));
  const completions = children.map(child => new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Backup tool could not start')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Backup tool failed')));
  }));
  const pumps: Promise<unknown>[] = [];
  if (input) pumps.push(pipeline(input, children[0]!.stdin)); else children[0]!.stdin.end();
  for (let i = 1; i < children.length; i++) pumps.push(pipeline(children[i - 1]!.stdout, children[i]!.stdin));
  if (output) pumps.push(pipeline(children.at(-1)!.stdout, output)); else children.at(-1)!.stdout.resume();
  try { await Promise.all([...completions, ...pumps]); }
  catch {
    for (const child of children) child.kill('SIGKILL');
    await Promise.allSettled([...completions, ...pumps]);
    throw new Error('Encrypted backup pipeline failed');
  }
}
