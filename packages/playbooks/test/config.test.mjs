import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { keccak256, stringToHex } from 'viem';
import { canonicalize } from '@eko/policy';
import { CONFIG_HASH, CONFIG_V1, RULES_VERSION } from '../src/index.js';

it('the human YAML and TypeScript config exactly match BACKEND §7.3', () => {
  const yaml = readFileSync(new URL('../config/v1.yaml', import.meta.url), 'utf8');
  const spec = readFileSync(new URL('../../../docs/eko/04-BACKEND.md', import.meta.url), 'utf8');
  const thresholdSection = spec.split('### 7.3 Thresholds')[1].split('### 7.4')[0];
  expect(yaml.trim()).toBe(thresholdSection.match(/```yaml\n([\s\S]*?)```/)[1].trim());
  // Test-only reader for this restricted one-line flow-map format, not a runtime
  // YAML parser or dependency. Fail on anything outside that exact grammar.
  const parsed = Object.fromEntries(yaml.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => {
    const row = line.match(/^(\w+):\s+\{ ([\w.:,\[\] ]+) \}$/);
    if (!row) throw new Error(`Unexpected config line: ${line}`);
    const fields = Object.fromEntries(row[2].split(/, (?=\w+: )/).map((field) => {
      const [key, raw] = field.split(': ');
      const list = raw.match(/^\[(\w+(?:, \w+)*)\]$/);
      const value = list ? list[1].split(', ') : JSON.parse(raw);
      if (typeof value !== 'number' && typeof value !== 'boolean' && !(Array.isArray(value) && value.every((item) => ['rugged', 'honeypot', 'dumped'].includes(item)))) throw new Error('Unexpected config value');
      return [key, value];
    }));
    return [row[1], fields];
  }));
  expect(parsed).toEqual(CONFIG_V1); expect(RULES_VERSION).toBe('1.0.2');
});
it('hashes canonical JSON with keccak256 independent of insertion order', () => {
  const reversed = Object.fromEntries(Object.entries(CONFIG_V1).reverse().map(([id, cfg]) => [id, Object.fromEntries(Object.entries(cfg).reverse())]));
  expect(CONFIG_HASH).toBe(keccak256(stringToHex(canonicalize(reversed))));
  expect(CONFIG_HASH).toMatch(/^0x[\da-f]{64}$/);
  const changed = structuredClone(CONFIG_V1); changed.tax_trap.fixedInfoMaxPct = 6;
  expect(keccak256(stringToHex(canonicalize(changed)))).not.toBe(CONFIG_HASH);
});
it('freezes the published thresholds so the receipt hash cannot drift at runtime', () => {
  expect(Object.isFrozen(CONFIG_V1)).toBe(true);
  for (const cfg of Object.values(CONFIG_V1)) expect(Object.isFrozen(cfg)).toBe(true);
  expect(Object.isFrozen(CONFIG_V1.serial_deployer.dangerOutcomes)).toBe(true);
});
