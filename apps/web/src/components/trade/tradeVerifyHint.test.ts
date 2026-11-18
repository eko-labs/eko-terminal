import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadHint() {
  vi.resetModules();
  return (await import('./tradeVerifyHint')).claimTradeVerifyHint;
}

afterEach(() => vi.unstubAllGlobals());

describe('one-time trade verification hint', () => {
  it('claims the hint once across panel mounts and page reloads', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const claim = await loadHint();
    expect(claim()).toBe(true);
    expect(claim()).toBe(false);
    expect((await loadHint())()).toBe(false);
  });

  it.each(['getItem', 'setItem'])('keeps working when localStorage %s throws', async method => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      [method]: () => { throw new Error('Storage blocked'); },
    });
    const claim = await loadHint();
    expect(claim()).toBe(true);
    expect(claim()).toBe(false);
  });
});
