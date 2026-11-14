#!/usr/bin/env node
/**
 * Deploy the edge from a clean, pushed commit and prove the live site runs it.
 *
 *   node scripts/deploy-edge.mjs                 deploy HEAD to Railway service eko-edge, then wait for /health to match
 *   options: --service <name> (default eko-edge) --url <origin> (default https://ekoterminal.com) --wait <sec> (default 600)
 *
 * Refuses a dirty checkout or a HEAD that is not on origin/main, so the commit the site reports is code anyone can
 * read. Writes apps/edge/build.json (the commit /health reports), runs `railway up`, removes the file, then runs
 * scripts/verify-edge.mjs until the new build answers or the wait runs out (exit 1).
 */
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const root = git('rev-parse', '--show-toplevel');
const service = opt('--service', 'eko-edge'), url = opt('--url', 'https://ekoterminal.com'), wait = opt('--wait', '600');

if (git('status', '--porcelain', '--untracked-files=no')) { console.error('Commit or stash your changes first: a deploy must be exactly one commit.'); process.exit(1); }
const commit = git('rev-parse', 'HEAD');
try { git('merge-base', '--is-ancestor', commit, 'origin/main'); }
catch { console.error(`HEAD ${commit.slice(0, 7)} is not on origin/main. Merge and push it first.`); process.exit(1); }

const file = join(root, 'apps', 'edge', 'build.json');
writeFileSync(file, `${JSON.stringify({ commit, builtAt: new Date().toISOString() })}\n`);
try { execFileSync('railway', ['up', '--service', service, '--detach'], { cwd: root, stdio: 'inherit' }); }
finally { rmSync(file, { force: true }); }

console.log(`Uploaded ${commit.slice(0, 7)}; waiting up to ${wait}s for ${url} to run it…`);
execFileSync('node', [join(root, 'scripts', 'verify-edge.mjs'), '--commit', commit, '--url', url, '--wait', wait], { stdio: 'inherit' });
