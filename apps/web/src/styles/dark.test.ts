import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const colours = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[\da-f]{3,8})(?=;)/gi)].map((m) => [m[1], m[2]]));
function luminance(hex: string) {
  const s = hex.slice(1);
  const digits = s.length === 3 ? [...s].map((c) => c + c).join('') : s;
  const rgb = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
afterEach(() => vi.unstubAllGlobals());
describe('dark-only tokens (§7.1)', () => {
  it('retains AA text contrast across dark surfaces', () => {
    for (const text of ['ink', 'ink2', 'muted', 'faint', 'accent', 'clear', 'monitor', 'danger']) {
      for (const surface of ['bg', 'panel', 'plate', 'raise', 'side']) {
        const ratio = (luminance(colours[text]) + 0.05) / (luminance(colours[surface]) + 0.05);
        expect(ratio, `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('has no light palette or system colour-scheme switch', () => {
    expect(css).toContain('color-scheme:dark');
    expect(css).not.toMatch(/data-theme|prefers-color-scheme|color-scheme:light/);
  });
  it('drops a stored theme while preserving other UI preferences', async () => {
    let stored = JSON.stringify({ theme: 'light', density: 'compact', amountUsd: 50 });
    vi.stubGlobal('localStorage', { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } });
    vi.resetModules();
    const { useUi } = await import('../store/ui');
    expect(useUi.getState()).not.toHaveProperty('theme');
    expect(JSON.parse(stored)).toMatchObject({ density: 'compact', amountUsd: 50 });
    expect(JSON.parse(stored)).not.toHaveProperty('theme');
  });
});
