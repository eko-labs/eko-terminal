import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A deliberately scoped Solidity token mutator, not a general Solidity parser.
// Comments, strings, imports, pragmas and type declarations are never mutation sites.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = text => createHash('sha256').update(text).digest('hex');
const files = (dir, suffix) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? files(path, suffix) : path.endsWith(suffix) ? [path] : [];
});
const sources = files(join(project, 'src'), '.sol');
const sourceTexts = new Map(sources.map(path => [relative(project, path), readFileSync(path, 'utf8')]));
const runnerSha256 = hash(readFileSync(fileURLToPath(import.meta.url)));
const mutants = [];
const operators = [
  'relational-replacement', 'arithmetic-replacement', 'logical-replacement', 'not-removal',
  'boolean-flip', 'guard-removal', 'guard-negation', 'if-negation', 'assignment-removal',
  'delete-removal', 'emit-removal', 'modifier-removal', 'unary-replacement',
  'increment-replacement', 'return-replacement', 'constant-replacement', 'visibility-tightening',
];
function tokenize(source) {
  const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z_$][\w$]*\b|\b(?:0x[\da-fA-F]+|\d[\d_]*)\b|\+\+|--|<=|>=|==|!=|&&|\|\||\+=|-=|\*=|\/=|%=|=>|[^\s]/g;
  return [...source.matchAll(pattern)].filter(m => !/^(\/\/|\/\*|"|')/.test(m[0])).map(m => ({ value: m[0], start: m.index, end: m.index + m[0].length }));
}
for (const path of sources) {
  const source = sourceTexts.get(relative(project, path));
  const tokens = tokenize(source);
  const matching = index => {
    const close = { '(': ')', '{': '}', '[': ']' }[tokens[index].value];
    let depth = 0;
    for (let i = index; i < tokens.length; i++) {
      if (tokens[i].value === tokens[index].value) depth++;
      if (tokens[i].value === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    throw new Error('Unbalanced source');
  };
  const add = (operator, start, end, replacement) => {
    const original = source.slice(start, end);
    if (original === replacement) return;
    if (mutants.some(m => m.file === relative(project, path) && m.start === start && m.end === end && m.replacement === replacement)) return;
    mutants.push({ file: relative(project, path), operator, start, end, line: source.slice(0, start).split('\n').length, original, replacement });
  };
  // Restrict expression-level operators to executable bodies.
  for (let f = 0; f < tokens.length; f++) {
    if (!['function', 'constructor', 'modifier'].includes(tokens[f].value)) continue;
    let body = f;
    while (body < tokens.length && !['{', ';'].includes(tokens[body].value)) body++;
    if (tokens[body]?.value !== '{') continue;
    const bodyEnd = matching(body);
    const header = tokens.slice(f, body).map(t => t.value);
    if (tokens[f].value === 'function') {
      // Bare custom modifiers (including onlyOwner) in function headers.
      for (let i = f; i < body; i++) {
        if (/^only[A-Z]/.test(tokens[i].value)) add('modifier-removal', tokens[i].start, tokens[i].end, '');
        if (['external', 'public', 'internal'].includes(tokens[i].value)) {
          for (const visibility of tokens[i].value === 'internal' ? ['private'] : ['internal', 'private']) {
            add('visibility-tightening', tokens[i].start, tokens[i].end, visibility);
          }
        }
      }
      // Explicit values for the implicit named scalar return, before the closing brace.
      const returns = header.indexOf('returns');
      if (returns !== -1 && /^uint\d*$/.test(header[returns + 2]) && header[returns + 3] !== ')') {
        const type = header[returns + 2];
        for (const value of ['0', '1', `type(${type}).max`]) add('return-replacement', tokens[bodyEnd].start, tokens[bodyEnd].start, `return ${value};\n    `);
      }
    }
    for (let i = body + 1; i < bodyEnd; i++) {
      const t = tokens[i];
      const replacements = ['<', '<=', '>', '>=', '==', '!='].includes(t.value) ? ['<', '<=', '>', '>=', '==', '!='] : ['+', '-', '*', '/', '%'].includes(t.value) ? ['+', '-', '*', '/', '%'] : [];
      for (const replacement of replacements) add(replacements.length === 6 ? 'relational-replacement' : 'arithmetic-replacement', t.start, t.end, replacement);
      if (['&&', '||'].includes(t.value)) add('logical-replacement', t.start, t.end, t.value === '&&' ? '||' : '&&');
      if (t.value === '!') add('not-removal', t.start, t.end, '');
      if (['true', 'false'].includes(t.value)) add('boolean-flip', t.start, t.end, t.value === 'true' ? 'false' : 'true');
      if (['++', '--'].includes(t.value)) {
        add('increment-replacement', t.start, t.end, t.value === '++' ? '--' : '++');
        add('increment-replacement', t.start, t.end, '');
        if (/^[A-Za-z_$]/.test(tokens[i + 1].value)) add('increment-replacement', t.start, tokens[i + 1].end, `${tokens[i + 1].value}${t.value}`);
      }
      if (['-', '+', '~'].includes(t.value) && ['(', '=', 'return', ','].includes(tokens[i - 1].value)) add('unary-replacement', t.start, t.end, t.value === '-' ? '+' : '-');
      if (/^(?:0x[\da-fA-F]+|\d[\d_]*)$/.test(t.value)) {
        const cast = tokens[i - 1].value === '(' ? tokens[i - 2].value : '';
        const type = cast === 'address' ? 'uint160' : 'uint256';
        for (const value of ['0', '1', `type(${type}).max`]) {
          if (value === t.value) continue;
          const replacement = /^(address|bytes\d+)$/.test(cast) && /^[01]$/.test(value) ? `${type}(${value})` : value;
          add('constant-replacement', t.start, t.end, replacement);
        }
      }
      if (t.value === 'if') {
        const close = matching(i + 1);
        const start = tokens[i + 1].end;
        const end = tokens[close].start;
        const condition = source.slice(start, end);
        add('if-negation', start, end, `!(${condition})`);
        if (tokens[close + 1].value === 'revert') {
          let stop = close + 1;
          while (tokens[stop].value !== ';') stop++;
          add('guard-removal', t.start, tokens[stop].end, '');
          add('guard-negation', start, end, `!(${condition})`); // Deduplicated with if-negation.
        }
      }
      if (['require', 'revert', 'emit', 'delete', 'return'].includes(t.value)) {
        let stop = i;
        while (tokens[stop].value !== ';') stop++;
        if (['require', 'revert'].includes(t.value)) {
          // An empty block keeps a surrounding if well-formed.
          add('guard-removal', t.start, tokens[stop].end, '{}');
          if (t.value === 'require') {
            let end = i + 2, nesting = 0;
            while (!(nesting === 0 && [',', ')'].includes(tokens[end].value))) {
              if (tokens[end].value === '(') nesting++;
              if (tokens[end].value === ')') nesting--;
              end++;
            }
            add('guard-negation', tokens[i + 1].end, tokens[end].start, `!(${source.slice(tokens[i + 1].end, tokens[end].start)})`);
          }
        } else if (t.value === 'return') {
          for (const value of ['0', '1', 'type(uint256).max', 'false', 'true']) add('return-replacement', tokens[i + 1].start, tokens[stop].start, value);
        } else add(`${t.value}-removal`, t.start, tokens[stop].end, '');
      }
      if (['=', '+=', '-=', '*=', '/=', '%='].includes(t.value)) {
        let start = i - 1, stop = i;
        while (![';', '{', '}'].includes(tokens[start - 1].value)) start--;
        while (tokens[stop].value !== ';') stop++;
        add('assignment-removal', tokens[start].start, tokens[stop].end, '');
        // For a local declaration also remove just its initializer, leaving the default value.
        if (/^(bytes\d*|u?int\d*|address|bool)$/.test(tokens[start].value)) {
          add('assignment-removal', t.start, tokens[stop].start, '');
        }
      }
    }
    f = bodyEnd;
  }
}
mutants.sort((a, b) => a.file.localeCompare(b.file, 'en') || a.start - b.start || a.end - b.end || a.operator.localeCompare(b.operator, 'en') || a.replacement.localeCompare(b.replacement, 'en'));
mutants.forEach((m, i) => { m.id = `M${String(i + 1).padStart(4, '0')}`; });
if (process.argv.slice(2).some(arg => arg !== '--list')) throw new Error('Usage: node contracts/scripts/mutate.mjs [--list]');
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(mutants, null, 2));
  process.exit(0);
}
const scratch = mkdtempSync(join(tmpdir(), 'eko-mutation-'));
const copy = join(scratch, 'contracts');
const env = { ...process.env, FOUNDRY_PROFILE: 'default', RPC_HTTP_URL: '' };
// Do not inherit settings overrides, RPC configuration, fuzz overrides or signer material.
for (const key of Object.keys(env)) if (/^(FOUNDRY_|DAPP_|RECEIPTS_)/.test(key)) delete env[key];
env.FOUNDRY_PROFILE = 'default';
const execute = args => {
  const result = spawnSync('forge', args, { cwd: copy, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.signal || result.status === null) throw new Error('Forge process failed or timed out; no mutation score written');
  return result;
};
function tests() {
  const result = execute(['test', '--offline', '--json', '--fuzz-seed', '0x1', '--threads', '2']);
  let suites;
  try { suites = JSON.parse(result.stdout); } catch { throw new Error('Invalid Forge test JSON; no mutation score written'); }
  const statuses = Object.entries(suites).flatMap(([suite, value]) => Object.entries(value.test_results ?? {}).map(([test, detail]) => ({ test: `${suite}::${test}`, status: detail.status })));
  if (!statuses.length) throw new Error('No tests in Forge output');
  const failed = statuses.filter(t => t.status === 'Failure').map(t => t.test).sort();
  if ((result.status === 0) !== (failed.length === 0) || statuses.some(t => !['Success', 'Failure', 'Skipped'].includes(t.status))) throw new Error('Unrecognized Forge test outcome');
  return { failed, skipped: statuses.filter(t => t.status === 'Skipped').map(t => t.test).sort(), passed: statuses.filter(t => t.status === 'Success').length };
}
try {
  mkdirSync(copy, { recursive: true });
  for (const item of ['foundry.toml', 'src', 'test', 'script', 'lib']) cpSync(join(project, item), join(copy, item), { recursive: true, dereference: true });
  cpSync(join(project, 'node_modules/@openzeppelin/contracts'), join(copy, 'node_modules/@openzeppelin/contracts'), { recursive: true, dereference: true });
  cpSync(join(project, '../packages/shared/test/fixtures'), join(scratch, 'packages/shared/test/fixtures'), { recursive: true });
  const manifest = dir => files(join(copy, dir), '.sol').map(path => ({ file: relative(copy, path), sha256: hash(readFileSync(path)) }));
  const dependencyHash = dir => hash(JSON.stringify(files(join(copy, dir), '.sol').map(path => [relative(copy, path), hash(readFileSync(path))])));
  const inputs = { sources: manifest('src'), tests: manifest('test'), scripts: manifest('script'), foundryTomlSha256: hash(readFileSync(join(copy, 'foundry.toml'))), runnerSha256,
    forgeStdSha256: dependencyHash('lib/forge-std'), openZeppelinSha256: dependencyHash('node_modules/@openzeppelin/contracts'),
    fixturesSha256: hash(JSON.stringify(files(join(scratch, 'packages/shared/test/fixtures'), '.json').map(path => [relative(scratch, path), hash(readFileSync(path))]))) };
  if (inputs.sources.some(input => input.sha256 !== hash(sourceTexts.get(input.file)))) throw new Error('Source changed while copying project');
  const build = execute(['build', '--offline']);
  if (build.status !== 0) throw new Error('Baseline does not compile');
  const baseline = tests();
  if (baseline.failed.length || !baseline.passed) throw new Error('Baseline suite failed; no mutation score written');
  const version = execute(['--version']).stdout.trim().split('\n');
  const config = JSON.parse(execute(['config', '--json']).stdout);
  const metadata = JSON.parse(JSON.parse(readFileSync(join(copy, 'out/ReceiptsRegistry.sol/ReceiptsRegistry.json'), 'utf8')).rawMetadata);
  const results = [];
  const rejectedVisibility = [];
  for (const mutant of mutants) {
    const original = sourceTexts.get(mutant.file);
    writeFileSync(join(copy, mutant.file), original.slice(0, mutant.start) + mutant.replacement + original.slice(mutant.end));
    // Avoid persisted invariant counterexamples from earlier mutants influencing later ones.
    rmSync(join(copy, 'cache/invariant'), { recursive: true, force: true });
    const compiled = execute(['build', '--offline']);
    const entry = { id: mutant.id, file: mutant.file, operator: mutant.operator, line: mutant.line, offset: mutant.start, original: mutant.original, replacement: mutant.replacement };
    if (compiled.status !== 0) {
      entry.outcome = 'compile-failed';
      entry.compilerErrors = [...new Set([...`${compiled.stdout}\n${compiled.stderr}`.matchAll(/Error(?: \((\d+)\))?: ([^\n]+)/g)].map(m => `${m[1] ?? ''} ${m[2]}`.trim()))].sort();
      if (!entry.compilerErrors.length) throw new Error(`Unrecognized build failure for ${mutant.id}`);
    } else {
      const result = tests();
      entry.outcome = result.failed.length ? 'killed' : 'survived';
      entry.killingTest = result.failed[0] ?? null;
    }
    writeFileSync(join(copy, mutant.file), original);
    // Tightening is admitted only when the entire Foundry project still compiles.
    if (entry.operator === 'visibility-tightening' && entry.outcome === 'compile-failed') rejectedVisibility.push(entry);
    else results.push(entry);
    console.log(`${mutant.id} ${entry.outcome} (${results.length + rejectedVisibility.length}/${mutants.length})`);
  }
  const counts = Object.fromEntries(['killed', 'survived', 'compile-failed'].map(outcome => [outcome, results.filter(r => r.outcome === outcome).length]));
  // Reviewed equivalences are pinned to the exact source hash and exact edit.
  // Do not generalize these arguments to other variables, types or contracts.
  const equivalences = [
    [83, '==', '<=', 'bytes32 is an unsigned 256-bit value: root <= bytes32(0) iff root == bytes32(0), including a zero root. No state, event, return or revert behavior changes.'],
    [83, '==', '<=', 'leafCount is uint32: leafCount <= 0 iff leafCount == 0 for every representable input. The rejection condition and its short-circuit behavior are unchanged.'],
    [115, '!=', '>', 'bytes32 is unsigned: root > bytes32(0) iff root != bytes32(0) for every stored or default root. The identical predicate preserves short-circuit proof evaluation and all observable results.'],
  ];
  const reviewedSourceHash = "c8cc2e8dc778a2a70e14ffa7f0c5859b8876988c65bd3d3dac64bb0b949e79e4";
  for (const result of results.filter(r => r.outcome === 'survived')) {
    const source = sourceTexts.get(result.file);
    const site = source.slice(0, result.offset).split('\n').at(-1).trim();
    const equivalence = equivalences.find(([line, original, replacement, argument]) => line === result.line && original === result.original && replacement === result.replacement &&
      ((argument.startsWith('leafCount') && site.endsWith('leafCount')) || (argument.startsWith('bytes32') && site.endsWith('root'))));
    if (result.file === 'src/ReceiptsRegistry.sol' && hash(source) === reviewedSourceHash && equivalence) result.disposition = { kind: 'equivalent', argument: equivalence[3] };
    else result.disposition = { kind: 'unresolved', argument: 'Requires a behavior test or a separately reviewed equivalence argument.' };
  }
  const equivalent = results.filter(r => r.disposition?.kind === 'equivalent').length;
  const denominator = counts.killed + counts.survived - equivalent;
  const report = {
    schemaVersion: 1,
    scope: 'All authored Solidity in contracts/src; dependencies, scripts and tests are not mutated.',
    environment: { node: process.version, forge: version, solc: metadata.compiler.version, settings: { optimizer: config.optimizer, optimizerRuns: config.optimizer_runs, viaIR: config.via_ir, evmVersion: config.evm_version, offline: config.offline }, fuzzSeed: '0x1', threads: 2 },
    inputs,
    operators, baseline, generatedCandidates: mutants.length, admittedMutants: results.length,
    counts, equivalent, nonEquivalentDenominator: denominator, score: denominator ? counts.killed / denominator : 0,
    rejectedVisibility, mutants: results,
  };
  mkdirSync(join(project, 'release'), { recursive: true });
  writeFileSync(join(project, 'release/mutation.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Mutation score: ${counts.killed}/${denominator}; ${counts.survived} survived (${equivalent} equivalent), ${counts['compile-failed']} compile-failed, ${rejectedVisibility.length} inadmissible visibility candidates.`);
  if (!denominator || counts.killed / denominator < 0.8 || results.some(r => r.disposition?.kind === 'unresolved')) process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
