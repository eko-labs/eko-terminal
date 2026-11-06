import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function checkBrand(root) {
  const denyFile = join(root, 'infra/brand-denylist.txt');
  const terms = [...new Set(readFileSync(denyFile, 'utf8').split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (!terms.length) throw new Error('Brand denylist must not be empty');
  const targets = ['apps/web/index.html', '.env.example', 'infra', 'harness-packs', 'apps/web/dist'];
  const apps = join(root, 'apps');
  if (existsSync(apps)) {
    for (const app of readdirSync(apps, { withFileTypes: true })) {
      if (app.isDirectory()) targets.push(`apps/${app.name}/public`);
    }
  }
  const failures = [];
  let checked = 0;
  const visit = (path) => {
    // This is the rule definition, not a served/configured brand occurrence.
    if (path === denyFile) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Cannot verify symlink: ${relative(root, path)}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    if (!stat.isFile()) return;
    checked++;
    const name = relative(root, path);
    const content = `${name}\n${readFileSync(path).toString('utf8')}`.toLowerCase();
    for (const term of terms) {
      if (content.includes(term)) failures.push(`${name}: ${term}`);
    }
  };
  for (const target of targets) {
    const path = join(root, target);
    if (existsSync(path)) visit(path);
  }
  return { checked, failures };
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'eko-brand-check-'));
  const put = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  try {
    put('infra/brand-denylist.txt', 'signalos\nSignalOS\nsos_\n');
    put('apps/web/index.html', '<title>EKO</title>');
    put('.env.example', 'MARKET_DATA_SOURCE=demo');
    put('apps/server/public/ok.svg', '<svg>EKO</svg>');
    put('docs/history.md', 'SignalOS');
    put('brand/history.svg', 'SignalOS');
    assert.deepEqual(checkBrand(root), { checked: 3, failures: [] });
    for (const file of ['apps/web/public/nested/mark.svg', 'apps/server/public/message.txt', 'apps/web/index.html', '.env.example', 'infra/service.json', 'apps/web/dist/assets/app.js', 'harness-packs/pack.yaml']) {
      const previous = existsSync(join(root, file)) ? readFileSync(join(root, file)) : null;
      put(file, 'sIgNaLoS SOS_sid');
      assert.equal(checkBrand(root).failures.filter((f) => f.startsWith(`${file}:`)).length, 2, file);
      if (previous) put(file, previous);
      else rmSync(join(root, file));
    }
    put('apps/web/dist/assets/signalos.svg', '<svg />');
    assert.equal(checkBrand(root).failures.length, 1, 'retired filename');
    rmSync(join(root, 'apps/web/dist/assets/signalos.svg'));
    put('infra/brand-denylist.txt', '');
    assert.throws(() => checkBrand(root), /must not be empty/);
    console.log('Brand check self-test passed (all scan targets, case, filenames, exclusions, empty denylist).');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const { checked, failures } = checkBrand(repo);
  if (failures.length) {
    console.error(`Brand check failed:\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`Brand check passed (${checked} files checked).`);
  }
}
