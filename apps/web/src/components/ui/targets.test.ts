import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../styles/ui.css', import.meta.url), 'utf8');
const target = /(?::where|:root :is)\(([^{}]+)\)\{min-width:(\d+)px;min-height:(\d+)px\}/g;

describe('shared interactive targets (FRONTEND §7.4, WCAG 2.2 2.5.8)', () => {
  const rules = [...css.matchAll(target)];
  it('sizes controls at 24px with a mouse and 44px under a coarse pointer', () => {
    expect(rules.map((m) => [m[2], m[3]])).toEqual([['24', '24'], ['44', '44']]);
    expect(css.slice(0, rules[1]!.index)).toMatch(/@media \(pointer: coarse\)\{[^{}]*$/);
    // Mouse: zero specificity, so a component may be larger. Touch: the floor wins over component sizes.
    expect(rules[0]![0]).toMatch(/^:where\(/); expect(rules[1]![0]).toMatch(/^:root :is\(/);
    for (const rule of rules) {
      for (const selector of ['button', 'select', 'summary', 'textarea', "[role='button']", "[role='tab']", "[role='switch']", 'a.btn']) expect(rule[1]).toContain(selector);
    }
    // Touch also enlarges the nav and phone tab links.
    expect(rules[1]![1]).toContain('.side nav a[href]'); expect(rules[1]![1]).toContain('.mtab > a');
  });
  it('leaves links in running text alone and never forces sizes with !important', () => {
    // No blanket a[href]: each selector item must be more specific than a bare link.
    for (const rule of rules) expect(rule[1]!.split(',').map((item) => item.trim())).not.toContain('a[href]');
    expect(css).not.toMatch(/min-(width|height):\s*\d+px\s*!important/);
    expect(css).not.toMatch(/a\[href\][^{}]*\)\s*\{\s*display:\s*inline-block/);
  });
});
