import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_ONBOARDING, DEFAULT_PREFERENCES, PreferencesSchema } from '@eko/shared';
vi.mock('../../lib/router', () => ({ usePath: () => '/scan/sample-scan', navigate: vi.fn() }));
vi.mock('../../lib/useMedia', () => ({ useMedia: () => false }));
vi.mock('../../lib/api', () => ({ fetchParsed: vi.fn() }));
import { fetchParsed } from '../../lib/api';
import { useApp } from '../../store/app';
import { mergeProgress, persistProgress, progressOf, useOnboarding } from '../../store/onboarding';
import { OnboardingView } from './Onboarding';
import { availableTourSteps, findAnchor, TOUR_STEPS } from './steps';
import { startOnboardingSync } from './sync';
import { tourKeyboard } from './Tour';
import { prefersReducedMotion } from './useDialog';

const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
const account = (id: string) => ({ id, kind: 'wallet' as const, walletAddress: '0x00000000000000000000000000000000000000aa', displayName: null, role: 'user' as const });
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); values.clear();
  vi.stubGlobal('window', { localStorage: storage, setTimeout, matchMedia: () => ({ matches: true }) });
  useOnboarding.setState({ ...DEFAULT_ONBOARDING, checklist: { ...DEFAULT_ONBOARDING.checklist }, hydrated: false, owner: null, scanSeen: false, disabled: false, welcomeOpen: false, tour: null, pointer: null, helpOpen: false, checklistOpen: false });
  useApp.setState({ account: null, preferences: DEFAULT_PREFERENCES });
  vi.mocked(fetchParsed).mockReset();
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('launch onboarding persistence and account boundaries', () => {
  it('OR-merges the five actions, retains legacy preferences and rejects malformed values', () => {
    const p = mergeProgress({ checklist: { scan_coin: true, scan_bags: false, paper_trade: true } }, { checklist: { scan_bags: true, open_evidence: true, guarded_trade: true, connect_agent: true } });
    expect(p.checklist).toEqual({ ...DEFAULT_ONBOARDING.checklist, scan_coin: true, scan_bags: true, open_evidence: true, guarded_trade: true, connect_agent: true, paper_trade: true });
    expect(PreferencesSchema.parse({ onboarding: p }).onboarding).toEqual(p);
    expect(mergeProgress({ checklist: { scan_coin: 'yes', unknown: true } } as never).checklist).toEqual(DEFAULT_ONBOARDING.checklist);
  });
  it('keeps offline progress on reload and claims it on the first sign-in only', async () => {
    stop = startOnboardingSync();
    useOnboarding.getState().scanRendered();
    expect(JSON.parse(storage.getItem('eko.onboarding.state')!).checklist.scan_coin).toBe(true);
    stop(); stop = undefined;
    useOnboarding.setState({ ...DEFAULT_ONBOARDING, checklist: { ...DEFAULT_ONBOARDING.checklist }, hydrated: false });
    stop = startOnboardingSync();
    expect(useOnboarding.getState().checklist.scan_coin).toBe(true);
    const prefs = { ...DEFAULT_PREFERENCES, onboarding: mergeProgress({ checklist: { open_evidence: true } }) };
    vi.mocked(fetchParsed).mockImplementation(async (_path, _schema, options) => (options?.body as typeof prefs));
    useApp.setState({ account: account('sample-account-a'), preferences: prefs });
    expect(useOnboarding.getState().checklist).toMatchObject({ scan_coin: true, open_evidence: true });
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchParsed).toHaveBeenCalledWith('/me/preferences', PreferencesSchema, expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ onboarding: expect.objectContaining({ checklist: expect.objectContaining({ scan_coin: true, open_evidence: true }) }) }) }));
    expect(storage.getItem('eko.onboarding.state')).toBeNull();
    useApp.setState({ account: account('sample-account-b'), preferences: DEFAULT_PREFERENCES });
    expect(useOnboarding.getState().checklist).toEqual(DEFAULT_ONBOARDING.checklist);
    useApp.setState({ account: account('sample-account-a'), preferences: DEFAULT_PREFERENCES });
    expect(useOnboarding.getState().checklist).toMatchObject({ scan_coin: true, open_evidence: true });
  });
  it('cancels an old account’s pending save and closes its tour on switch', async () => {
    useApp.setState({ account: account('sample-account-a') }); stop = startOnboardingSync();
    useOnboarding.getState().markStep('guarded_trade'); useOnboarding.getState().startTour();
    useApp.setState({ account: account('sample-account-b'), preferences: DEFAULT_PREFERENCES });
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchParsed).not.toHaveBeenCalled();
    expect(useOnboarding.getState().tour).toBeNull();
    expect(useOnboarding.getState().checklist.guarded_trade).toBe(false);
  });
  it('aborts in-flight preference writes and ignores their late result after account switch', async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(fetchParsed).mockImplementation(() => new Promise(r => { resolve = r; }));
    useApp.setState({ account: account('sample-account-a') }); stop = startOnboardingSync();
    useOnboarding.getState().markStep('scan_bags'); await vi.advanceTimersByTimeAsync(400);
    const options = vi.mocked(fetchParsed).mock.calls[0]![2]!;
    useApp.setState({ account: account('sample-account-b'), preferences: DEFAULT_PREFERENCES });
    expect(options.signal!.aborted).toBe(true);
    resolve(options.body); await vi.advanceTimersByTimeAsync(0);
    expect(useApp.getState().preferences).toEqual(DEFAULT_PREFERENCES);
    expect(useOnboarding.getState().checklist.scan_bags).toBe(false);
  });
  it('preserves the off bypass and mirrors locally without server writes', async () => {
    storage.setItem('eko.onboarding', 'off'); useOnboarding.getState().hydrate(null);
    const save = vi.fn().mockResolvedValue(undefined); stop = persistProgress(null, save);
    useOnboarding.getState().scanRendered(); await vi.advanceTimersByTimeAsync(500);
    expect(save).not.toHaveBeenCalled();
    expect(JSON.parse(storage.getItem('eko.onboarding.state')!).checklist.scan_coin).toBe(true);
    expect(renderToStaticMarkup(<OnboardingView state={useOnboarding.getState()} path="/scan/sample-scan" />)).toBe('');
  });
  it('offers a nonblocking pill after value, never a welcome modal or automatic tour', () => {
    useOnboarding.getState().hydrate(null);
    expect(renderToStaticMarkup(<OnboardingView state={useOnboarding.getState()} path="/scan/sample-scan" />)).toBe('');
    useOnboarding.getState().scanRendered();
    const html = renderToStaticMarkup(<OnboardingView state={useOnboarding.getState()} path="/scan/sample-scan" />);
    expect(html).toContain('Take the 40-second tour.'); expect(html).not.toContain('role="dialog"'); expect(html).not.toContain('data-testid="welcome"');
    useOnboarding.getState().closeWelcome();
    expect(progressOf(useOnboarding.getState()).welcomeDone).toBe(true);
    expect(renderToStaticMarkup(<OnboardingView state={useOnboarding.getState()} path="/scan/sample-scan" />)).toContain('checklist-pill');
  });
});

describe('implemented anchors and keyboard controls', () => {
  it('skips absent, hidden, inert and gated stops, including on mobile', () => {
    const element = (blocked = false, width = 40) => ({ closest: () => blocked ? {} : null, getBoundingClientRect: () => ({ width, height: 40 }) });
    vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible', opacity: '1' }));
    const scan = element(), hidden = element(true), zero = element(false, 0);
    vi.stubGlobal('document', { querySelectorAll: (selector: string) => selector.includes('scan') ? [hidden, scan] : selector.includes('trade') ? [hidden] : selector.includes('playbooks') ? [zero] : [] });
    expect(findAnchor('scan')).toBe(scan); expect(findAnchor('trade')).toBeNull();
    expect(availableTourSteps().map(s => s.anchor)).toEqual(['scan']);
    expect(TOUR_STEPS.map(s => s.anchor)).toEqual(['scan', 'verdict', 'playbooks', 'flow-markers', 'coin-card', 'fee-lines', 'trade', 'mode', 'mission', 'wallet']);
  });
  it('dismisses with Escape from an input and retains typing navigation', () => {
    const finish = vi.fn(), go = vi.fn();
    const event = (key: string, tagName = 'INPUT') => ({ key, target: { tagName }, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent);
    tourKeyboard(event('Escape'), go, finish); expect(finish).toHaveBeenCalledOnce();
    tourKeyboard(event('ArrowRight'), go, finish); expect(go).not.toHaveBeenCalled();
    tourKeyboard(event('ArrowRight', 'BUTTON'), go, finish); expect(go).toHaveBeenCalledWith(1);
  });
  it('honors system reduced motion and the Settings override', () => {
    let attr: string | null = null;
    vi.stubGlobal('document', { documentElement: { getAttribute: () => attr } });
    expect(prefersReducedMotion()).toBe(true); attr = 'on'; expect(prefersReducedMotion()).toBe(false); attr = 'off'; expect(prefersReducedMotion()).toBe(true);
  });
});
