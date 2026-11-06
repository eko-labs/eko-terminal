import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'docs/public-launch/artifact-manifests.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const packagePrefixes = name => [`packages/${name}/src/`, `packages/${name}/test/`, `packages/${name}/config/`];
const packageFiles = name => [`packages/${name}/package.json`, `packages/${name}/tsconfig.json`];
const shared = [...packagePrefixes('shared'), ...packageFiles('shared')];
const definitions = [
  { name: 'contracts', prefixes: ['contracts/src/', 'contracts/script/', 'contracts/scripts/', 'contracts/test/', 'contracts/review/', 'contracts/release/', 'contracts/lib/forge-std/src/', 'docs/security/', '.audit-grade/'], exact: ['contracts/README.md', 'contracts/package.json', 'contracts/foundry.toml', 'contracts/slither.config.json', 'contracts/aderyn.toml', 'contracts/.gas-snapshot', 'contracts/lib/forge-std/LICENSE-MIT', 'contracts/lib/forge-std/LICENSE-APACHE', 'packages/shared/test/fixtures/receipts/v1.json', 'packages/shared/test/fixtures/receipts/guard-v2.json', 'packages/chain/abi/eko/ReceiptsRegistry.json'] },
  { name: 'playbooks', prefixes: [...packagePrefixes('playbooks'), ...packagePrefixes('policy'), ...packagePrefixes('untrusted'), ...shared.filter(path => path.endsWith('/'))], exact: [...packageFiles('playbooks'), ...packageFiles('policy'), ...packageFiles('untrusted'), ...packageFiles('shared')] },
  { name: 'receipts-verifier', prefixes: [...packagePrefixes('receipts-verifier'), ...shared.filter(path => path.endsWith('/'))], exact: [...packageFiles('receipts-verifier'), ...packageFiles('shared'), 'packages/receipts-verifier/README.md', 'packages/chain/abi/eko/ReceiptsRegistry.json'] },
];
const common = [
  ['LICENSE', 'LICENSE'],
  ['docs/public-launch/README.md', 'README.md'],
  ['docs/public-launch/README.md', 'docs/public-launch/README.md'],
  ['docs/public-launch/SECURITY.public.md', 'SECURITY.md'],
  ['docs/public-launch/security.txt.template', '.well-known/security.txt'],
  ['docs/public-launch/SECURITY.public.md', 'docs/public-launch/SECURITY.public.md'],
  ['docs/public-launch/security.txt.template', 'docs/public-launch/security.txt.template'],
  ['docs/public-launch/CHECKLIST.md', 'docs/public-launch/CHECKLIST.md'],
  ['docs/public-launch/EVIDENCE.md', 'docs/public-launch/EVIDENCE.md'],
  ['pnpm-lock.yaml', 'pnpm-lock.yaml'], ['pnpm-workspace.yaml', 'pnpm-workspace.yaml'], ['tsconfig.base.json', 'tsconfig.base.json'],
];
// Only tracked, reviewable source formats enter prefix selections. No broad
// directory copy, environment values, broadcasts, build metadata or raw runs.
export function selectedFiles(definition, tracked) {
  return tracked.filter(path => !/(?:^|\/)(?:node_modules|out|cache|dist|runs|broadcast|\.env)(?:\/|$|\.)/.test(path)
    && (definition.exact.includes(path) || (definition.prefixes.some(prefix => path.startsWith(prefix))
      && /\.(?:[cm]?[jt]sx?|json|ya?ml|sol|md|tsv)$/.test(path)))).sort();
}
export function describeArtifact(pairs, read) {
  const sorted = [...pairs].sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  if (new Set(sorted.map(pair => pair[1])).size !== sorted.length) throw new Error('Duplicate export destination');
  const digest = createHash('sha256');
  const files = sorted.map(([source, destination]) => {
    if ([source, destination].some(path => path.startsWith('/') || path.split('/').includes('..') || path.includes('\\'))) throw new Error('Export paths must be relative');
    const bytes = read(source);
    digest.update(destination).update('\0').update(bytes).update('\0');
    return { source, destination, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return { sha256: digest.digest('hex'), files };
}
export function generateManifest() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const repositories = definitions.map(definition => {
    for (const path of definition.exact) if (!tracked.includes(path)) throw new Error(`Missing tracked artifact: ${path}`);
    const pairs = [...common, ...selectedFiles(definition, tracked).map(path => [path, path])];
    if (definition.name === 'contracts') pairs.push(['SECURITY.md', 'docs/security/PRIVILEGED-POWERS.md']);
    return { name: definition.name, publicUrl: null, license: 'MIT (authored artifacts; preserve third-party notices)', ...describeArtifact(pairs, path => readFileSync(resolve(root, path))) };
  });
  return { schemaVersion: 1, state: 'prepared-source-review-only', sourceRevision, candidate: 'sourceRevision plus exact recorded worktree bytes; final release hash unresolved', publicWindow: { opensAt: '2026-10-13T13:00:00Z', closesAt: '2026-10-16T13:00:00Z', ownerSignoffDate: '2026-10-18', openedAt: null, closedAt: null }, publicationApproved: false, bountyActive: false, verifiedDeployments: [], repositories };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!['--write', '--check'].includes(mode) || process.argv.length !== 3) throw new Error('Use --write or --check');
  const bytes = `${JSON.stringify(generateManifest(), null, 2)}\n`;
  if (mode === '--write') { writeFileSync(output, bytes); console.log('Prepared three local source manifests; no publication performed.'); }
  else if (readFileSync(output, 'utf8') !== bytes) { console.error('Public launch manifest differs from candidate files; regenerate and review.'); process.exitCode = 1; }
  else console.log('Public launch manifest membership and SHA-256 hashes match.');
}
