import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'eko-ci-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'scripts'));
  const trace = join(dir, 'trace');
  writeFileSync(trace, '');
  const env = { PATH: join(dir, 'bin'), TMPDIR: dir, TRACE: trace };
  for (const name of ['dirname', 'mktemp', 'head']) {
    const source = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    assert.equal(source.status, 0);
    symlinkSync(source.stdout.trim(), join(env.PATH, name));
  }
  symlinkSync('/bin/bash', join(env.PATH, 'bash'));
  return {
    stub(path, body) {
      writeFileSync(join(dir, path), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    },
    copy(script) {
      copyFileSync(new URL(`../${script}`, import.meta.url), join(dir, 'scripts', script));
    },
    run(script, args = [], extraEnv = {}) {
      return spawnSync('/bin/bash', [join(dir, 'scripts', script), ...args], {
        cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8',
      });
    },
    trace() {
      return readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean);
    },
  };
}

test('local CI runs both chains and reports missing scanners', t => {
  const f = fixture(t);
  f.copy('ci-local.sh');
  f.stub('bin/node', 'echo v22.22.0');
  f.stub('bin/npx', 'echo "${VITE_EKO_CHAIN:-workspace}: $*" >> "$TRACE"');

  const required = f.run('ci-local.sh');
  assert.equal(required.status, 1, required.stderr);
  assert.match(required.stdout, /FAIL\s+gitleaks\s+gitleaks is missing\. Install with: brew install gitleaks/);
  assert.match(required.stdout, /SKIPPED\s+contracts\s+forge is missing\. Install with: foundryup/);
  assert.match(required.stdout, /SKIPPED\s+slither/);
  assert.match(required.stdout, /SKIPPED\s+semgrep/);

  const optional = f.run('ci-local.sh', ['--allow-missing-scanners']);
  assert.equal(optional.status, 0, optional.stderr);
  assert.match(optional.stdout, /SKIPPED\s+gitleaks/);
  for (const chain of ['robinhood', 'elysium']) {
    assert.match(optional.stdout, new RegExp(`PASS\\s+frontend-${chain}`));
    assert.ok(f.trace().includes(`${chain}: --yes pnpm@11.5.1 --filter @eko/web build`));
    assert.ok(f.trace().includes(`${chain}: --yes pnpm@11.5.1 --filter @eko/landing build`));
  }
});

test('local CI reports failures and keeps checking independent jobs', t => {
  const f = fixture(t);
  f.copy('ci-local.sh');
  f.stub('bin/node', 'echo v22.22.0');
  f.stub('bin/npx', '[[ $* != "--yes pnpm@11.5.1 typecheck" ]]');
  f.stub('bin/gitleaks', 'if [[ $1 == --version ]]; then echo "gitleaks version 8.30.1"; else echo "$*" >> "$TRACE"; exit 7; fi');

  const result = f.run('ci-local.sh', ['--allow-missing-scanners']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /FAIL\s+workspace-typecheck\s+log: .*\/workspace-typecheck\.log/);
  assert.match(result.stdout, /FAIL\s+gitleaks\s+log: .*\/gitleaks\.log/);
  assert.match(result.stdout, /PASS\s+frontend-elysium/);
  assert.deepEqual(f.trace(), ['git --config .gitleaks.toml --redact --log-opts=--all .']);
});

test('ship orders CI, private push, and publication and stops after a failed step', t => {
  const f = fixture(t);
  f.copy('ship.sh');
  f.stub('scripts/ci-local.sh', 'echo ci >> "$TRACE"; exit "${CI_STATUS:-0}"');
  f.stub('bin/git', `
    case "$1" in
      status) exit 0 ;;
      rev-parse) echo checked-commit ;;
      push) echo "git $*" >> "$TRACE"; exit "\${PUSH_STATUS:-0}" ;;
      *) exit 99 ;;
    esac
  `);
  f.stub('bin/node', 'echo "node $*" >> "$TRACE"');

  const push = 'git push origin HEAD:main';
  assert.equal(f.run('ship.sh', [], { CI_STATUS: '3' }).status, 3);
  assert.deepEqual(f.trace(), ['ci']);
  assert.equal(f.run('ship.sh', [], { PUSH_STATUS: '4' }).status, 4);
  assert.deepEqual(f.trace(), ['ci', 'ci', push]);
  assert.equal(f.run('ship.sh').status, 0);
  assert.deepEqual(f.trace(), [
    'ci', 'ci', push, 'ci', push, 'node scripts/public/publish.mjs --push --ref checked-commit',
  ]);
});
