import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const censusPath = resolve(root, 'docs/security/EXTERNAL-SURFACE.md');
// Reviewed trust-boundary modules, not every internal workspace export.
const modules = [
  'apps/server/src/app.ts', 'apps/server/src/roles.ts', 'apps/server/src/launch.ts',
  'apps/server/src/http/auth.ts', 'apps/server/src/http/routes.ts',
  'apps/server/src/http/launch-monitoring.ts', 'apps/server/src/http/ghost-reports.ts',
  'apps/server/src/http/v2-guard.ts',
  'apps/server/src/harness/', 'apps/server/src/exec/', 'apps/server/src/flags/service.ts',
  'apps/server/src/obs/incidents.ts', 'apps/server/src/obs/launch.ts',
  'apps/server/src/ops/backup-stream.ts', 'apps/server/src/ops/restore-checks.ts',
  'apps/server/src/sanctions/service.ts', 'apps/mcp/src/',
  'packages/policy/src/guard.ts', 'packages/policy/src/preflight.ts',
  'packages/policy/src/repeat.ts', 'packages/policy/src/actual-order.ts', 'packages/policy/src/presets.ts',
  'packages/policy/src/canonical.ts',
  'packages/playbooks/src/verdict.ts', 'packages/playbooks/src/guard-scoring.ts',
  'packages/untrusted/src/index.ts', 'packages/db/src/crypto/',
  'packages/db/src/receipt-api.ts', 'packages/db/src/receipt-anchors.ts',
  'packages/db/src/receipt-committer.ts', 'packages/db/src/receipt-outbox.ts',
  'packages/db/src/guard-receipts.ts', 'packages/shared/src/contracts/receipt-encoding.ts',
  'packages/shared/src/contracts/guard-receipts.ts', 'packages/chain/src/execution/',
  'apps/indexer/src/head.ts', 'apps/indexer/src/log-head.ts', 'apps/indexer/src/backfill.ts',
  'apps/indexer/src/scan-jobs.ts', 'apps/indexer/src/clients.ts', 'apps/indexer/src/agent-registry.ts',
  'apps/indexer/src/enrich.ts',
  'apps/engines/src/worker.ts', 'apps/engines/src/receipts/worker.ts',
  'apps/engines/src/coverage-pilot.ts',
  // Later packets extend the same external boundaries; keep them in the census.
  'apps/server/src/obs/security-collectors.ts', 'apps/server/src/obs/security-worker.ts',
  'apps/server/src/obs/security-config.ts', 'apps/server/src/http/share.ts', 'apps/server/src/http/security-txt.ts',
  'apps/server/src/read/senses.ts', 'apps/server/src/read/scoreboard.ts',
  'packages/db/src/flow-read.ts', 'apps/engines/src/watcher/flow-store.ts',
  'apps/server/src/telegram/',
  'apps/server/src/swarm/runner.ts', 'apps/server/src/swarm/paper.ts',
  'apps/server/src/ai/swarm-worker.ts', 'apps/engines/src/swarm/index.ts',
  'apps/engines/src/swarm/calibration.ts', 'apps/bots/src/',
  'packages/chain/src/control/collector.ts', 'packages/chain/src/custody/collector.ts',
];
const excludedNames = new Set([
  'rowToOrder', 'applyFillToPosition', // internal DB/domain conversions
  'BlockQueue', 'BlockPrefetch', // scheduling helpers behind HeadFollower
  'RoleStartupError', 'HarnessError', 'ExecError', 'TradeAccessError', 'ChainQuoteError',
  'ScreeningError', 'OAuthDiscoveryError', 'ReorgDepthError', // error containers, no authority
  'BackfillFailedError', 'PilotStop', 'AdaptiveWindow', 'isRangeLimit', 'lower', 'digest',
  'reasonForMatch', 'readServices', // formatting, scheduling and service wiring helpers
]);

function walk(dir) {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
}
const files = [...new Set([
  ...modules.flatMap(p => p.endsWith('/') ? walk(p.slice(0, -1)) : [p]),
  ...walk('apps/server/src/http/v1'), ...walk('contracts/src'),
])].filter(p => /\.(ts|sol)$/.test(p) && !/(?:\.d\.ts|\.test\.ts|\/(?:cli|index|types|networks|fixtures|defaults|helpers|demo-token-cli)\.ts)$/.test(p)
  || ['packages/untrusted/src/index.ts', 'apps/server/src/http/v1/index.ts',
    'apps/engines/src/swarm/index.ts'].includes(p)).sort();

// Mask comments/literals without shifting offsets. This bounded declaration scanner
// supports this repository's named exports, class methods and factory/object methods.
// Templates are masked in full: definitions inside template data are not entry points.
function mask(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\])+\/[dgimsuvy]*(?=[\s.,;:)\]}]|$)/g,
    s => s.replace(/[^\n]/g, ' '));
}
function docBefore(source, offset) {
  const prefix = source.slice(0, offset).trimEnd();
  if (prefix.endsWith('*/')) {
    const start = prefix.lastIndexOf('/*');
    if (prefix[start + 2] === '*') return prefix.slice(start);
  }
  const lines = prefix.split('\n');
  const doc = [];
  while (lines.length && /^\s*\/\/\//.test(lines.at(-1))) doc.unshift(lines.pop());
  return doc.join('\n');
}
function scan(source, solidity = false) {
  const code = mask(source), entries = [];
  const depth = new Int32Array(code.length + 1);
  for (let i = 0; i < code.length; i++) depth[i + 1] = depth[i] + (code[i] === '{' ? 1 : code[i] === '}' ? -1 : 0);
  const add = (name, kind, offset) => {
    const doc = docBefore(source, offset);
    entries.push({ name, kind, offset, line: source.slice(0, offset).split('\n').length,
      documented: solidity ? /@notice\s+\S/.test(doc) && /@dev\s+\S/.test(doc) : /\/\*\*[\s\S]*\w/.test(doc) });
  };
  if (solidity) {
    for (const m of code.matchAll(/\b(function\s+(\w+)\s*\([^)]*\)[^{;]*\b(?:external|public)\b[^{;]*|constructor\s*\([^)]*\)[^{;]*|event\s+(\w+)\s*\([^;]*|error\s+(\w+)\s*\([^;]*|(?:address|u?int\d*|bytes\d*|bool)\s+public\s+(\w+))(?=[{;=])/g)) {
      add(m[2] ?? m[3] ?? m[4] ?? m[5] ?? 'constructor', m[3] ? 'event' : m[4] ? 'error' : m[5] ? 'getter' : 'function', m.index);
    }
    return entries;
  }
  for (const m of code.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g)) {
    if (!excludedNames.has(m[1])) add(m[1], 'function', m.index);
  }
  for (const m of code.matchAll(/\bexport\s+(?:abstract\s+)?class\s+(\w+)[^{]*\{/g)) {
    if (excludedNames.has(m[1])) continue;
    const start = m.index + m[0].length, level = depth[start];
    let end = start;
    while (end < code.length && depth[end] >= level) end++;
    for (const member of code.slice(start, end).matchAll(/^[ \t]*(?:(?:public|static|override|async|readonly|private|protected|get|set)\s+)*(\w+)\s*(?:<[^\n]*?>)?\s*\(/gm)) {
      const at = start + member.index, declaration = member[0].trimStart();
      if (depth[at] !== level || /\b(private|protected)\b/.test(declaration)) continue;
      add(`${m[1]}.${member[1]}`, member[1] === 'constructor' ? 'constructor' : 'method', at + member[0].length - declaration.length);
    }
  }
  for (const m of code.matchAll(/\bexport\s+const\s+(\w+)(?:\s*:[^=\n]+)?\s*=\s*/g)) {
    if (excludedNames.has(m[1])) continue;
    const start = m.index + m[0].length;
    if (code[start] === '{') {
      const level = depth[start] + 1;
      let end = start + 1;
      while (end < code.length && depth[end] >= level) end++;
      for (const member of code.slice(start + 1, end).matchAll(/\b(?:async\s+)?(\w+)\s*\(/g)) {
        const at = start + 1 + member.index;
        if (depth[at] === level) add(`${m[1]}.${member[1]}`, 'method', at);
      }
    } else {
      // Arrow/function initializers only; schema calls and constants are excluded.
      const line = code.slice(start, code.indexOf('\n', start) < 0 ? code.length : code.indexOf('\n', start));
      if (/^(?:async\s+)?(?:\([^)]*\)|\w+)\s*(?::[^=]*)?=>/.test(line) || /^function\b/.test(line)) add(m[1], 'function', m.index);
    }
  }
  // Methods in returned codec objects are part of the exported factory boundary.
  for (const m of code.matchAll(/\breturn\s*\{/g)) {
    const start = m.index + m[0].length, level = depth[start];
    let end = start;
    while (end < code.length && depth[end] >= level) end++;
    for (const member of code.slice(start, end).matchAll(/^[ \t]*(?:async\s+)?(\w+)\s*\(/gm)) {
      const at = start + member.index;
      if (depth[at] === level && entries.some(e => e.kind === 'function' && e.offset < at)) {
        add(`returned.${member[1]}`, 'method', at + member[0].length - member[0].trimStart().length);
      }
    }
    if (['createClients', 'createReceiptEncoder', 'createGuardReceiptCodec'].some(name =>
      entries.some(e => e.name === name && e.offset < m.index))) {
      for (const property of code.slice(start, end).matchAll(/\b(\w+)\s*:\s*(?:async\s+)?(?:\([^\n]*?\)|\w+)\s*=>/g)) {
        const at = start + property.index;
        if (depth[at] === level || property[1] === 'watch') add(`returned.${property[1]}`, 'method', at);
      }
      // Shorthand callable properties refer to local implementations, not re-exports.
      const body = code.slice(start, end);
      for (const local of code.slice(0, m.index).matchAll(/\b(?:function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^\n]*?\)|\w+)\s*(?::[^\n=]+)?=>)/g)) {
        const name = local[1] ?? local[2];
        if (depth[local.index] === level - 1 && new RegExp(`(?:^|[,\\s])${name}\\s*(?=[,}])`).test(body))
          add(`returned.${name}`, 'method', local.index);
      }
    }
  }
  return [...new Map(entries.map(e => [e.offset, e])).values()].sort((a, b) => a.offset - b.offset);
}

// Exercise attachment, literal masking, generics, private exclusion and getters.
assert.deepEqual(scan('/** Read. */\nexport function read() { return "export function fake() {}"; }\nexport class Gate {\n/** Run. */\nasync run<T>() {}\nprivate hidden() {}\n}\nexport const fn = (x: number) => x;').map(e => [e.name, e.documented]),
  [['read', true], ['Gate.run', true], ['fn', false]]);
assert.deepEqual(scan('contract C {\n/// @notice Read.\n/// @dev Storage.\nuint64 public id;\nfunction read() external view returns (uint64) { return id; }\n}', true).map(e => [e.name, e.documented]), [['id', true], ['read', false]]);

const entries = files.flatMap(file => scan(readFileSync(resolve(root, file), 'utf8'), file.endsWith('.sol')).map(e => ({ file, ...e })));
// Effective inherited public functions count once, at their locked implementation.
// Do not count the overridden single-step transfer or vendor internal helpers.
const registrySource = readFileSync(resolve(root, 'contracts/src/ReceiptsRegistry.sol'), 'utf8');
const registryDoc = docBefore(registrySource, registrySource.indexOf('contract ReceiptsRegistry'));
const ownershipTags = { owner: 'reads', pendingOwner: 'reads', transferOwnership: 'transfer',
  acceptOwnership: 'accept', renounceOwnership: 'renounce' };
for (const [module, names] of [
  ['Ownable', ['owner', 'renounceOwnership']],
  ['Ownable2Step', ['pendingOwner', 'transferOwnership', 'acceptOwnership']],
]) {
  const file = `contracts/node_modules/@openzeppelin/contracts/access/${module}.sol`;
  const source = readFileSync(resolve(root, file), 'utf8');
  for (const name of names) {
    const match = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(mask(source));
    assert(match, `Missing inherited registry entry: ${name}`);
    entries.push({ file, name: `ReceiptsRegistry.${name}`, kind: 'inherited function', offset: match.index,
      line: source.slice(0, match.index).split('\n').length,
      documented: /@dev\s+\S/.test(docBefore(source, match.index)) &&
        registryDoc.includes(`@custom:ownership-${ownershipTags[name]}`),
    });
  }
}
assert(entries.length > 0, 'Empty external surface');
const documented = entries.filter(e => e.documented).length;
const percent = 100 * documented / entries.length;
const table = '| Entry | Kind | Source (file:line) | Doc comment |\n| --- | --- | --- | --- |\n' + entries.map(e =>
  `| \`${e.name}\` | ${e.kind} | [${e.file}:${e.line}](../../${e.file}#L${e.line}) | ${e.documented ? 'Yes' : 'No'} |`).join('\n') + '\n';
const measurement = `Measured: **${documented}/${entries.length} (${percent.toFixed(2)}%)** documented. Minimum: **90%**.\n`;
const marker = '<!-- generated census: node scripts/check-doc-surface.mjs --write -->';
if (process.argv.includes('--json')) console.log(JSON.stringify(entries, null, 2));
else {
  const current = readFileSync(censusPath, 'utf8');
  const heading = current.split(marker)[0];
  const expected = `${heading}${marker}\n\n${measurement}\n${table}`;
  if (process.argv.includes('--write')) writeFileSync(censusPath, expected);
  else if (current !== expected) {
    console.error('External surface census is stale; inspect changes, then run node scripts/check-doc-surface.mjs --write.');
    process.exitCode = 1;
  }
  console.log(`External surface: ${documented}/${entries.length} (${percent.toFixed(2)}%) documented`);
}
if (percent < 90) {
  console.error('External surface documentation is below 90%.');
  process.exitCode = 1;
}
