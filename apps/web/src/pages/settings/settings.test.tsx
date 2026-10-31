import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { DEFAULT_PREFERENCES, SIWE_STATEMENT, type Preferences } from '@eko/shared';
import { createApi } from '../../lib/api';
import { createMockTransport } from '../../mocks/transport';
import { createSession, createConfig } from '../../mocks/responses';
import { useApp } from '../../store/app';
import { useShell } from '../../store/shell';
import { Settings } from '../Settings';
import Plan, { ReferralDetails, trialCountdown } from './Plan';
import { PrivacySettings } from './Privacy';
import { deleteHarnessData, journalConsent, referralLink, setJournalConsent } from '../../lib/settings';
import { JournalConsentSetting } from './JournalConsent';
import { SETTINGS_COPY as C, PLAN_COPY as P } from '../../copy/settings';
import { ADVISORY, BUILT_ON, NON_AFFILIATION } from '../../copy';
import { resolveRoute } from '../../routes';

const mocks = vi.hoisted(() => ({ address: undefined as string | undefined, fetchParsed: vi.fn(), api: vi.fn(), hookState: null as { values: unknown[]; index: number } | null }));
vi.mock('wagmi', () => ({ useConnection: () => ({ address: mocks.address, chainId: 4663 }) }));
vi.mock('../../lib/api', async original => ({ ...await original<typeof import('../../lib/api')>(), fetchParsed: mocks.fetchParsed, api: mocks.api }));
// SSR uses the store's initial snapshot; these fixtures deliberately select current state.
vi.mock('../../store/app', async original => {
  const actual = await original<typeof import('../../store/app')>();
  return { ...actual, useApp: Object.assign((select: (s: ReturnType<typeof actual.useApp.getState>) => unknown) => select(actual.useApp.getState()), actual.useApp) };
});
vi.mock('../../store/shell', async original => {
  const actual = await original<typeof import('../../store/shell')>();
  return { ...actual, useShell: Object.assign((select: (s: ReturnType<typeof actual.useShell.getState>) => unknown) => select(actual.useShell.getState()), actual.useShell) };
});
// Exercise the confirmation form's real handlers without a browser/port or new test dependency.
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: (initial: unknown) => {
    const state = mocks.hookState;
    if (!state) return actual.useState(initial);
    const index = state.index++;
    if (!(index in state.values)) state.values[index] = typeof initial === 'function' ? initial() : initial;
    return [state.values[index], (next: unknown) => { state.values[index] = typeof next === 'function' ? next(state.values[index]) : next; }];
  }, useEffect: (effect: () => void, deps?: unknown[]) => {
    // Harness renders call components directly; their loads are driven explicitly by each test.
    if (!mocks.hookState) return actual.useEffect(effect, deps);
  } };
});
const walletA = `0x${'1'.repeat(40)}`, walletB = `0x${'2'.repeat(40)}`;
let client: ReturnType<typeof createApi>;
beforeEach(() => {
  vi.clearAllMocks(); mocks.hookState = null; mocks.address = undefined;
  vi.stubGlobal('document', { documentElement: { setAttribute: vi.fn(), removeAttribute: vi.fn() } });
  client = createApi('/v1', createMockTransport());
  mocks.fetchParsed.mockImplementation(client.parse); mocks.api.mockImplementation(client.request);
  useApp.setState({ account: null, preferences: DEFAULT_PREFERENCES, toasts: [] });
  useShell.setState({ config: createConfig(), me: null, realtime: null });
});
afterEach(() => { mocks.hookState = null; vi.unstubAllGlobals(); });
async function signIn(wallet: string) {
  await client.request('/auth/siwe/verify', { body: { message: `localhost wants you to sign in with your Ethereum account:\n${wallet}\n\n${SIWE_STATEMENT}` } });
  await useApp.getState().refreshSession(); mocks.address = wallet;
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function privacyHarness(owner: string) {
  const state = { values: [] as unknown[], index: 0 };
  const view = () => { mocks.hookState = state; state.index = 0; const tree = PrivacySettings({ owner }); mocks.hookState = null; return tree; };
  const find = (type: string) => elements(view()).find(e => e.type === type)!;
  const begin = () => (find('button').props.onClick as () => void)();
  const type = (value: string) => (find('input').props.onChange as (e: unknown) => void)({ target: { value } });
  const submit = () => (find('form').props.onSubmit as (e: unknown) => void)({ preventDefault: () => {} });
  return { view, find, begin, type, submit };
}

describe('task 119 settings (offline fixtures, no live account)', () => {
  it('replaces both route entry points and preserves public sections with inline connect', async () => {
    expect((await resolveRoute('/settings')!.route.load()).default).toBe(Settings);
    expect((await resolveRoute('/settings/plan')!.route.load()).default).toBe(Plan);
    const html = render(<Settings />);
    for (const copy of [C.title, C.display, C.about, C.connect, BUILT_ON, NON_AFFILIATION, ADVISORY, P.feeLaunch, P.feeCurve]) expect(html).toContain(copy);
    expect(html).not.toContain('aria-label="Trading preferences"');
    expect(html).not.toMatch(/Type DELETE|Web push|Redeem|Hold ≥|Trial ·/);
  });
  it('shows guest trading preferences while keeping wallet-only sections inline', async () => {
    await useApp.getState().refreshSession();
    const html = render(<Settings />);
    for (const copy of [C.defaultMode, C.sellPresets, C.slippagePresets, C.confirmationLabel]) expect(html).toContain(copy);
    expect(html).toContain(C.connectNote); expect(html).not.toContain(C.deletePrompt);
  });
  it('persists trading preferences separately for each wallet and rejects failed saves', async () => {
    await signIn(walletA);
    const prefs: Partial<Preferences> = { quickAmounts: [20, 80], quickSellPercents: [20, 100], slippagePresetsBps: [20, 40], defaultSlippageBps: 40, confirmLargeTradeUsd: 800, defaultMode: 'testnet' };
    await useApp.getState().setPreferences(prefs);
    await useApp.getState().refreshSession(); expect(useApp.getState().preferences).toMatchObject(prefs);
    await signIn(walletB); expect(useApp.getState().preferences).toEqual(DEFAULT_PREFERENCES);
    await useApp.getState().setPreferences({ quickAmounts: [15] });
    await signIn(walletA); expect(useApp.getState().preferences).toMatchObject(prefs);
    const before = useApp.getState().preferences;
    mocks.fetchParsed.mockRejectedValueOnce(new Error('Offline failure'));
    await expect(useApp.getState().setPreferences({ quickAmounts: [99] })).rejects.toThrow('Offline failure');
    expect(useApp.getState().preferences).toBe(before);
  });
  it('discards delayed preference responses after a session/account change', async () => {
    await signIn(walletA);
    let finish!: (value: Preferences) => void;
    mocks.fetchParsed.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const save = useApp.getState().setPreferences({ quickAmounts: [99] });
    const refusal = expect(save).rejects.toThrow('Account changed');
    await signIn(walletB); finish({ ...DEFAULT_PREFERENCES, quickAmounts: [99] });
    await refusal; expect(useApp.getState().preferences).toEqual(DEFAULT_PREFERENCES);
  });
  it('hides previous wallet preferences and deletion immediately on a connection switch', async () => {
    await signIn(walletA); await useApp.getState().setPreferences({ quickAmounts: [987] });
    mocks.address = walletB;
    const html = render(<Settings />);
    expect(html).not.toMatch(/value="987"|aria-label="Trading preferences"|Type DELETE/);
    expect(html).toContain(C.connectNote);
  });
  it('uses confirmed DELETE, retains failed confirmation for retry, and displays the accepted timestamp', async () => {
    await signIn(walletA); mocks.fetchParsed.mockClear();
    const harness = privacyHarness(useApp.getState().account!.id);
    harness.begin(); harness.submit(); expect(mocks.fetchParsed).not.toHaveBeenCalled();
    harness.type('delete'); harness.submit(); expect(mocks.fetchParsed).not.toHaveBeenCalled();
    expect(harness.find('button').props.disabled).toBe(false);
    harness.type('DELETE'); mocks.fetchParsed.mockRejectedValueOnce(new Error('Deletion failed')); harness.submit();
    await vi.waitFor(() => expect(render(harness.view())).toContain(C.deleteError));
    expect(render(harness.view())).toContain('value="DELETE"'); expect(render(harness.view())).not.toContain(C.deleted);
    harness.submit(); await vi.waitFor(() => expect(render(harness.view())).toContain(C.deleted));
    expect(render(harness.view())).toContain('2026-10-13T12:00:00.000Z');
    expect(mocks.fetchParsed).toHaveBeenCalledWith('/me/data', expect.anything(), { method: 'DELETE' });
    expect(render(harness.view())).not.toContain('<form');
  });
  it('lets only the verified owner turn the agent journal on and off; deletion forgets it', async () => {
    await signIn(walletA); mocks.fetchParsed.mockClear();
    expect(await journalConsent()).toEqual({ optedIn: false });
    expect(await setJournalConsent(true)).toEqual({ optedIn: true });
    expect(await journalConsent()).toEqual({ optedIn: true });
    expect(mocks.fetchParsed).toHaveBeenCalledWith('/me/journal-consent', expect.anything(), { method: 'PUT', body: { optedIn: true } });
    const html = render(<Settings />);
    for (const copy of [C.journalTitle, C.journalToggle, C.journalLoading, C.deleteTitle]) expect(html).toContain(copy);
    // The toggle: disabled until loaded, then a change saves and shows the server's answer.
    const state = { values: [] as unknown[], index: 0 }, owner = useApp.getState().account!.id;
    const view = (id = owner) => { mocks.hookState = state; state.index = 0; const tree = JournalConsentSetting({ owner: id }); mocks.hookState = null; return tree; };
    const box = () => elements(view()).find(e => e.type === 'input')!;
    expect(box().props.disabled).toBe(true);
    state.values[0] = true; mocks.fetchParsed.mockClear();
    expect(render(view())).toContain(C.journalOn);
    (box().props.onChange as (e: unknown) => void)({ target: { checked: false } });
    await vi.waitFor(() => expect(render(view())).toContain(C.journalOff));
    expect(mocks.fetchParsed).toHaveBeenCalledWith('/me/journal-consent', expect.anything(), { method: 'PUT', body: { optedIn: false } });
    mocks.fetchParsed.mockClear();
    const stale = elements(view('previous-account')).find(e => e.type === 'input')!;
    (stale.props.onChange as (e: unknown) => void)({ target: { checked: true } });
    expect(mocks.fetchParsed).not.toHaveBeenCalled();
    await setJournalConsent(true); await deleteHarnessData('DELETE');
    expect(await journalConsent()).toEqual({ optedIn: false });
  });
  it('does not send deletion if its confirmation belongs to an old account', async () => {
    await signIn(walletA); const harness = privacyHarness('previous-account');
    harness.begin(); harness.type('DELETE'); mocks.fetchParsed.mockClear(); harness.submit(); expect(mocks.fetchParsed).not.toHaveBeenCalled();
    await expect(deleteHarnessData(' DELETE ')).rejects.toThrow(C.deletePrompt);
  });
  it('clears the SIWE session only after logout succeeds', async () => {
    await signIn(walletA); const account = useApp.getState().account;
    mocks.api.mockRejectedValueOnce(new Error('Logout failed'));
    await expect(useApp.getState().signOut()).rejects.toThrow('Logout failed'); expect(useApp.getState().account).toBe(account);
    await useApp.getState().signOut(); expect(useApp.getState().account?.kind).toBe('guest'); expect(useShell.getState().me?.account.wallet).toBeUndefined();
    expect(mocks.api).toHaveBeenCalledWith('/auth/logout', { method: 'POST' });
  });
  it('renders exact launch and D0 fee copy while hiding all D0+1 amounts, trials and bonuses', async () => {
    await signIn(walletA);
    const config = createConfig(); config.tiers[1].minBalance = '87654321';
    useShell.setState({ config, me: { ...createSession(), trial: { status: 'eligible' } } });
    const launch = render(<Plan />); expect(launch).toContain(P.launch); expect(launch).toContain(P.feeLaunch);
    expect(launch).not.toMatch(/87654321|Connect to start 30|Redeem|Bonus minutes|Qualified referrals/);
    useShell.setState({ config: { ...config, phase: 'token_live' } });
    const d0 = render(<Plan />); expect(d0).toContain(P.tokenLive); expect(d0).toContain('Terminal fee: 0.5% on Uniswap-routed trades.'); expect(d0).not.toMatch(/burn/i); expect(d0).not.toContain(P.feeLaunch);
  });
  it('uses real referral response values, with bonuses hidden until their flag', () => {
    const data = { code: 'sample-code', link: 'https://eko.example/?ref=sample-code', referred: 7, qualified: 4, bonusMinutes: 120 };
    const html = render(<ReferralDetails data={data} bonuses={false} />);
    expect(html).toContain(data.link); expect(html).toContain('>7<'); expect(html).not.toMatch(/Qualified referrals|Bonus minutes|>120</);
    expect(render(<ReferralDetails data={data} bonuses />)).toContain('>120<');
    for (const link of ['javascript:alert(1)', 'https://sample-code@evil.test/?ref=sample-code', 'https://eko.example/?ref=wrong', 'https://eko.example/?ref=sample-code&aff=other']) expect(referralLink(link, data.code)).toBeNull();
  });
  it('calculates trial time within one second and uses entitlements events without a reload', async () => {
    await signIn(walletA); const now = Date.now();
    expect(trialCountdown(new Date(now + 30_001).toISOString(), now)).toBe('Trial · 0:31');
    expect(trialCountdown(new Date(now - 1).toISOString(), now)).toBe(P.trialEnded);
    const config = createConfig(); config.phase = 'tiers'; config.flags.tiers_active = true; config.flags.trial = true;
    useShell.setState({ config, me: createSession() });
    expect(render(<Plan />)).toContain('Listener');
    const me = useShell.getState().me!;
    useShell.setState({ me: { ...me, entitlements: { ...me.entitlements, trial: { endsAt: new Date(now + 30_000).toISOString() } } } });
    expect(render(<Plan />)).toContain('Trial · 0:30');
  });
});
