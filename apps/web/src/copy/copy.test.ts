import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as copy from './index';

const src = dirname(dirname(fileURLToPath(import.meta.url)));
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const sourceFiles = files(src).filter((file) => /\.(tsx?|css)$/.test(file) && !/\.test\./.test(file));
const FORBIDDEN = [/price support/i, /\bfloor\b/i, /\bbid\b/i, /our chart gets bought/i, /number go up/i,
  /strict(ly)? (guardrail|enforced)/i, /guaranteed?/i, /rug-?proof/i, /100% safe/i, /win rate/i, /\balpha\b/i,
  /never lose/i, /\bthe only\b/i, /first ever/i, /partner(ed|ship)? with Robinhood/i, /\$HOOD/i, /\bHood\b/,
  /\bHood Chain/i, /29M agents/i, /express this view/i,
  /only way out/i, /only leave as a burn/i, /leaves? only as a burn/i,
  /buys? the dip/i, /speeds? up on dips?/i, /dip accelerator/i,
  /trustless burns?/i, /automated burns?/i, /\baudited\b/i,
  /ownerless/i, /(no ?one|nobody) can touch/i];

describe('canonical §8 copy', () => {
  it('snapshots every exact constant and fee wording', () => {
    expect({ ...copy }).toMatchSnapshot();
  });
  it('keeps disclaimers out of hard-coded source text outside copy/', () => {
    const violations: string[] = [];
    for (const file of sourceFiles.filter((file) => !file.startsWith(join(src, 'copy') + '/'))) {
      const content = readFileSync(file, 'utf8');
      if (content.includes(copy.NON_AFFILIATION)) violations.push(file);
      const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) && /\bDYOR\b/.test(node.text)) violations.push(file);
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(violations).toEqual([]);
  });
  it('names the safe risk mode Careful wherever it is shown', async () => {
    const { riskModeLabel, RISK_OPTIONS } = await import('./shell');
    const { GUARD_POLICY_OPTIONS } = await import('./guard');
    expect(riskModeLabel('safe')).toBe('Careful'); expect(riskModeLabel('Safe')).toBe('Careful'); expect(riskModeLabel('degen')).toBe('Degen');
    for (const option of [...RISK_OPTIONS, ...GUARD_POLICY_OPTIONS]) expect(option.label).not.toMatch(/\bsafe\b/i);
  });
  // AGENTS.md hard rule 3, as user-facing claims; the landing mixes copy with graphics code, so the list is exact.
  const LANDING_FORBIDDEN = [/\baudited\b/i, /trustless/i, /automated burn/i, /ownerless/i, /\bguaranteed\b/i, /rug-?proof/i, /\bwin rate\b/i,
    /protects your robinhood account/i, /\bSafe\b/, /robinhood (partner|official)/i];
  it('rejects forbidden claims and the word Safe in the marketing landing', () => {
    const landing = join(src, '..', '..', 'landing', 'src');
    const violations: string[] = [];
    for (const file of files(landing).filter((file) => /\.(tsx?|css)$/.test(file))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('// copy-allow:')) return;
        if (LANDING_FORBIDDEN.some((pattern) => pattern.test(line))) violations.push(`${file.slice(landing.length + 1)}:${i + 1}`);
      });
    }
    expect(violations).toEqual([]);
  });
  // Owner decision 2026-10-05: no token burns, buybacks, milestone buys or bug bounty in anything users read.
  const DROPPED = [/burn wallet/i, /burned daily/i, /daily burn/i, /buy[- ]?(and|&)[- ]?burn/i, /burn board/i, /buy-?backs?/i, /milestone (buy|timelock)/i,
    /\bbounty\b/i, /\bpayouts?\b/i, /closed beta/i];
  it('keeps dropped token burn, buyback, milestone and bounty promises out of canonical copy', () => {
    const violations: string[] = [];
    for (const file of sourceFiles.filter((file) => file.startsWith(join(src, 'copy') + '/'))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        // The one allowed mention says plainly that there is none.
        const text = line.replace('There is no bug bounty', '');
        if (DROPPED.some((pattern) => pattern.test(text))) violations.push(`${file}:${i + 1}`);
      });
    }
    expect(violations).toEqual([]);
  });
  it('rejects forbidden claims in canonical copy and marketing', () => {
    const violations: string[] = [];
    for (const file of sourceFiles.filter((file) => file.startsWith(join(src, 'copy') + '/') || file.startsWith(join(src, 'marketing') + '/'))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('// copy-allow:')) return;
        if (FORBIDDEN.some((pattern) => pattern.test(line))) violations.push(`${file}:${i + 1}`);
      });
    }
    expect(violations).toEqual([]);
  });
});
