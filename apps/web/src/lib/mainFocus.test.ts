import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], previous: undefined as { current: string } | undefined }));
vi.mock('react', () => ({ useEffect: (effect: () => void | (() => void)) => state.effects.push(effect), useRef: (value: string) => state.previous ??= { current: value } }));
import { focusMain, useMainFocus, onHeaderBackgroundClick } from './mainFocus';
import { SkipLink } from '../components/SkipLink';
afterEach(() => { state.effects.length = 0; state.previous = undefined; vi.unstubAllGlobals(); });
describe('main landmark focus', () => {
  it('activates the skip link without navigating or changing the hash', () => {
    const focus = vi.fn(); vi.stubGlobal('document', { getElementById: () => ({ focus }) });
    const link = SkipLink(), preventDefault = vi.fn();
    expect(link.props.href).toBe('#main');
    link.props.onClick({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledOnce();
  });
  it('retains cold-load tab order, including StrictMode effect replay, and focuses SPA arrivals', () => {
    const focus = vi.fn(); vi.stubGlobal('document', { getElementById: () => ({ focus }) });
    useMainFocus('/radar'); state.effects[0]!(); state.effects[0]!(); expect(focus).not.toHaveBeenCalled();
    useMainFocus('/pairs'); state.effects[1]!(); expect(focus).toHaveBeenCalledOnce();
  });
  it('resets the first Tab position after a blank-header click without intercepting child controls', () => {
    const body = { tabIndex: 0, focus: vi.fn() }, header = {} as HTMLElement, child = {} as HTMLElement;
    vi.stubGlobal('document', { body });
    onHeaderBackgroundClick({ target: child, currentTarget: header }); expect(body.focus).not.toHaveBeenCalled();
    onHeaderBackgroundClick({ target: header, currentTarget: header });
    expect(body.tabIndex).toBe(-1); expect(body.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
  it('waits for a lazy route landmark and disconnects on arrival or cancellation', () => {
    let main: { focus: () => void } | null = null; const root = {}, focus = vi.fn(), disconnect = vi.fn(), observe = vi.fn();
    let changed!: () => void;
    vi.stubGlobal('document', { getElementById: (id: string) => id === 'root' ? root : main });
    vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { changed = callback; } observe = observe; disconnect = disconnect; });
    expect(focusMain()).toBe(false);
    useMainFocus('/scan'); state.effects[0]!(); useMainFocus('/radar'); const cleanup = state.effects[1]!();
    expect(observe).toHaveBeenCalledWith(root, { childList: true, subtree: true });
    changed(); expect(disconnect).not.toHaveBeenCalled();
    main = { focus }; changed(); expect(focus).toHaveBeenCalledOnce(); expect(disconnect).toHaveBeenCalledOnce();
    if (typeof cleanup === 'function') cleanup(); expect(disconnect).toHaveBeenCalledTimes(2);
  });
});
