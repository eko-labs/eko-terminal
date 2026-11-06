#!/usr/bin/env node
/**
 * pnpm setup:ai — connect one AI gateway key (PPQ.ai) that powers every AI analyst.
 *
 *   pnpm setup:ai                     prompt for the key (hidden input), verify, save
 *   pbpaste | pnpm setup:ai           read the key from stdin instead of prompting
 *   pnpm setup:ai --base-url <url>    another OpenAI-compatible gateway (verification is PPQ-only)
 *   pnpm setup:ai --env <path>        write somewhere other than apps/server/.env
 *
 * The key is verified with PPQ's credits endpoint (no generation, nothing is spent), then
 * written to apps/server/.env atomically with mode 0600. The key is never printed.
 */
import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BASE_URL = 'https://api.ppq.ai';
const KEY_RE = /^[A-Za-z0-9_.-]{12,512}$/;

export function validKey(key) {
  return typeof key === 'string' && KEY_RE.test(key);
}

/** Replace GATEWAY_BASE_URL / GATEWAY_API_KEY in an env file, keeping every other line. Atomic, mode 0600. */
export async function saveKey(envPath, key, baseUrl = DEFAULT_BASE_URL) {
  if (!validKey(key)) throw new Error('invalid_key');
  let current = '';
  try {
    current = await readFile(envPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const kept = current.split(/\r?\n/).filter((line) => !/^\s*(?:export\s+)?GATEWAY_(?:API_KEY|BASE_URL)\s*=/.test(line));
  const head = kept.join('\n').trimEnd();
  const next = `${head ? `${head}\n` : ''}GATEWAY_BASE_URL=${baseUrl}\nGATEWAY_API_KEY=${key}\n`;
  const temp = `${envPath}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temp, next, { mode: 0o600, flag: 'wx' });
    await rename(temp, envPath);
    await chmod(envPath, 0o600);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/** Checks the key against PPQ without generating anything. Never returns provider data. */
export async function verifyKey(key, baseUrl = DEFAULT_BASE_URL) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/credits/balance`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: '{}',
  });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'rejected' : `http_${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body || body.success === false || body.error || body.status === 'error') throw new Error('rejected');
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Hidden-input prompt: nothing is echoed. */
function promptHidden(question) {
  return new Promise((resolvePrompt, reject) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      if (err) reject(err);
      else resolvePrompt(value.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 4096) break;
  }
  return raw.trim();
}

async function main() {
  const envPath = resolve(ROOT, arg('--env') ?? 'apps/server/.env');
  const baseUrl = (arg('--base-url') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const isPpq = /(^|\.)ppq\.ai$/i.test(new URL(baseUrl).hostname);
  console.log('Connect EKO AI analysts to one gateway key.');
  console.log(`Gateway: ${baseUrl}${isPpq ? ' (PPQ.ai — get a key at https://ppq.ai)' : ''}`);
  let key;
  try {
    key = process.stdin.isTTY ? await promptHidden('Paste your API key (input is hidden): ') : await readStdin();
  } catch {
    console.log('Cancelled. Nothing was saved.');
    process.exit(1);
  }
  if (!validKey(key)) {
    console.error('That does not look like an API key (12-512 letters, digits, "_", "-" or "."). Nothing was saved.');
    process.exit(1);
  }
  if (isPpq) {
    process.stdout.write('Checking the key with PPQ (no generation, nothing is spent)… ');
    try {
      await verifyKey(key, baseUrl);
      console.log('ok.');
    } catch (e) {
      console.log('failed.');
      console.error(
        e.message === 'rejected'
          ? 'PPQ did not accept this key. Check it and try again. Nothing was saved.'
          : `Could not verify the key (${e.message}). Check your connection and try again. Nothing was saved.`,
      );
      process.exit(1);
    }
  } else {
    console.log('Not a PPQ URL: skipping verification. The first AI run will show whether the key works.');
  }
  await saveKey(envPath, key, baseUrl);
  console.log(`Saved to ${relative(process.cwd(), envPath) || envPath} (mode 600, gitignored).`);
  console.log('Restart the server (pnpm dev) to load it. Every AI analyst without its own provider key now runs through the gateway;');
  console.log('AI_DAILY_BUDGET_USD (default $2/day) still caps spend.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Setup failed unexpectedly. Nothing was printed or saved beyond what is shown above.');
    process.exit(1);
  });
}
