import { renderToStaticMarkup as render } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

let desktop = true;
vi.mock('../../lib/useMedia', () => ({ useMedia: () => desktop }));
const { PANE, PaneResizer, clampWidth, keyWidth, readPaneWidth, savePaneWidth } = await import('./PaneResizer');

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
}

describe('side pane separator keys', () => {
  it('widens with Left and narrows with Right, in bigger steps with Shift', () => {
    expect(keyWidth('ArrowLeft', false, 400, 760)).toBe(400 + PANE.step);
    expect(keyWidth('ArrowRight', false, 400, 760)).toBe(400 - PANE.step);
    expect(keyWidth('ArrowLeft', true, 400, 760)).toBe(400 + PANE.bigStep);
    expect(keyWidth('ArrowRight', true, 400, 760)).toBe(400 - PANE.bigStep);
  });
  it('never goes past the minimum, the maximum, or the room the page leaves', () => {
    expect(keyWidth('ArrowRight', true, PANE.min + 10, 760)).toBe(PANE.min);
    expect(keyWidth('ArrowLeft', true, 750, 760)).toBe(PANE.max);
    expect(keyWidth('ArrowLeft', false, 500, 510)).toBe(510);
    expect(keyWidth('Home', false, 500, 760)).toBe(PANE.min);
    expect(keyWidth('End', false, 400, 600)).toBe(600);
    expect(keyWidth('End', false, 400, 5000)).toBe(PANE.max);
    // Even with no room at all, the pane keeps its minimum rather than collapsing.
    expect(clampWidth(900, 100)).toBe(PANE.min);
  });
  it('restores the default with Enter and ignores other keys', () => {
    expect(keyWidth('Enter', false, 700, 760)).toBe(PANE.initial);
    expect(keyWidth('a', false, 700, 760)).toBeNull();
    expect(keyWidth('ArrowUp', false, 700, 760)).toBeNull();
    expect(keyWidth('Tab', false, 700, 760)).toBeNull();
  });
});

describe('side pane width memory', () => {
  afterEach(() => { vi.unstubAllGlobals(); desktop = true; });
  it('remembers the chosen width per pane in this browser and forgets it on reset', () => {
    const storage = memoryStorage(); vi.stubGlobal('localStorage', storage);
    expect(readPaneWidth('coin')).toBeNull();
    savePaneWidth('coin', 512.4);
    expect(storage.data.get('eko.pane.coin')).toBe('512');
    expect(readPaneWidth('coin')).toBe(512);
    expect(readPaneWidth('other')).toBeNull();
    savePaneWidth('coin', null);
    expect(readPaneWidth('coin')).toBeNull();
  });
  it('treats junk and out-of-range values safely', () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'eko.pane.a': 'wide', 'eko.pane.b': '-4', 'eko.pane.c': '99999', 'eko.pane.d': '10' }));
    expect(readPaneWidth('a')).toBeNull();
    expect(readPaneWidth('b')).toBeNull();
    expect(readPaneWidth('c')).toBe(PANE.max);
    expect(readPaneWidth('d')).toBe(PANE.min);
  });
  it('keeps working when storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } });
    expect(readPaneWidth('coin')).toBeNull();
    expect(() => savePaneWidth('coin', 500)).not.toThrow();
    expect(() => savePaneWidth('coin', null)).not.toThrow();
  });
  it('renders a focusable vertical separator that starts at the saved width', () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'eko.pane.coin': '480' }));
    const html = render(<PaneResizer storageKey="coin" controls="radar-inspector" label="Resize coin details" />);
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-controls="radar-inspector"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(`aria-valuemin="${PANE.min}"`);
    expect(html).toContain('aria-valuenow="480"');
    vi.stubGlobal('localStorage', memoryStorage());
    expect(render(<PaneResizer storageKey="coin" controls="radar-inspector" label="Resize coin details" />)).toContain(`aria-valuenow="${PANE.initial}"`);
  });
  it('gives phones no drag edge', () => {
    desktop = false;
    expect(render(<PaneResizer storageKey="coin" controls="radar-inspector" label="Resize coin details" />)).toBe('');
  });
});
