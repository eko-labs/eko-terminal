import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packsDir = join(root, 'harness-packs');
// JSON is a YAML 1.2 subset, keeping the single manifest dependency-free.
export function generatePacks(manifest) {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.mcp.url, '{{MCP_URL}}');
  assert.equal(manifest.mcp.auth.header, 'Authorization');
  assert.equal(manifest.mcp.auth.value, 'Bearer {{API_KEY}}');
  const instructions = manifest.instructions.join('\n');
  const values = { '${mcp.url}': manifest.mcp.url, '${mcp.auth.value}': manifest.mcp.auth.value, '${instructions}': instructions };
  const expand = value => {
    if (typeof value === 'string') return Object.entries(values).reduce((text, [from, to]) => text.replaceAll(from, to), value);
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)]));
    return value;
  };
  const files = {}, packs = [];
  for (const [platform, source] of Object.entries(manifest.targets)) {
    assert.ok(['claude_code', 'claude_desktop', 'generic_mcp', 'claude_connector'].includes(platform));
    const target = expand(source);
    assert.equal(target.stage, platform === 'claude_connector' ? 'D0' : 'T');
    const rendered = {};
    for (const [path, contents] of Object.entries(target.files ?? {})) {
      assert.ok(!path.split('/').includes('..') && !path.startsWith('/'));
      rendered[path] = path.endsWith('.md')
        ? `---\n${Object.entries(contents.frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${contents.body}\n`
        : `${JSON.stringify(contents, null, 2)}\n`;
      files[`${platform}/${path}`] = rendered[path];
    }
    // A one-line command (Claude Code) beats a file to paste; connectors carry only their URL.
    const configTemplate = target.command ?? target.connectorUrl ?? Object.entries(rendered).find(([path]) => path.endsWith('.json'))?.[1]?.trimEnd();
    assert.ok(configTemplate);
    packs.push({ platform, stage: target.stage, version: manifest.version, configTemplate, instructions, setup: target.setup });
    if (target.connectorUrl) {
      files[`${platform}/connector.json`] = `${JSON.stringify(target, null, 2)}\n`;
    }
    files[`${platform}/instructions.md`] = `${instructions}\n`;
  }
  files['packs.json'] = `${JSON.stringify(packs, null, 2)}\n`;
  return files;
}
export function buildPacks(check = false) {
  const output = generatePacks(JSON.parse(readFileSync(join(packsDir, 'pack.yaml'), 'utf8')));
  const dir = join(packsDir, 'generated');
  if (check) {
    const visit = (path, prefix = '') => readdirSync(path, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? visit(join(path, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
    assert.deepEqual(visit(dir).sort(), Object.keys(output).sort(), 'Generated pack file set has drifted');
  }
  for (const [path, content] of Object.entries(output)) {
    if (check) assert.equal(readFileSync(join(dir, path), 'utf8'), content, `Generated pack drift: ${path}`);
    else { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
  }
  return Object.keys(output).length;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Packs ${process.argv.includes('--check') ? 'checked' : 'built'} (${buildPacks(process.argv.includes('--check'))} files).`);
}
