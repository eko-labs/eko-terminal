import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GUARD_REASON_CODES, PlaybookIdSchema, type CoinCard, type Verdict } from '@eko/shared';
vi.mock('../../lib/router', () => ({ usePath: () => '/radar', navigate: vi.fn() }));
import { navigate } from '../../lib/router';
import { useOnboarding } from '../../store/onboarding';
import { navHidden, navLabel, shellHidden, viewPage } from '../../components/views';
import { NAV_GROUPS } from '../../components/shell/navigation';
import feature, { SIMPLE_MENU } from './index';
import { savedChoice, savedWalks, useSimple } from './choice';
import { readOwnerAgents, useOwnerAgents } from './missionLink';
import { NOTHING_WRONG, PLAYBOOK_PLAIN, REASON_PLAIN, SELL_WORDS, STILL_CHECKING, WARNING_SIGNS, WATCHED_LATE, answerOf, canSell, hundredBack, moveText, plainReason } from './model';
import { LIST_WALK, coinWalk } from './Walkthrough';
import Switch from './Switch';

const JARGON = /\b(fdv|liquidity|impact|curve|holders? ?%|slippage|mcap|market cap|playbook|guard|honeypot|bonding|deployer|rug|lp)\b/i;
const verdict = (level: Verdict['level'], playbooks: { id: string; level: string }[] = [], extra: Partial<Verdict> = {}) =>
  ({ level, playbooks: playbooks.map(p => ({ ...p, confidence: 0.9, evidence: [] })), ...extra }) as unknown as Verdict;
const card = (t: { honeypot?: boolean; e100?: number; e1k?: number; flags?: string[]; missing?: string[] }) => ({
  tradeability: { honeypot: t.honeypot ?? false, exitCostPct: { usd100: t.e100 ?? 2, usd1k: t.e1k ?? 3, usd10k: 9 }, buyTaxPct: 0, sellTaxPct: 0 },
  meta: { tradeability: { confidence: 1, asOfBlock: 1, flags: t.flags ?? ['sell_check_sellable'], missing: t.missing ?? [] } },
}) as unknown as CoinCard;

describe('plain language', () => {
  it('has one plain sentence for every finding a verdict can name and every reason the guard can give', () => {
    expect(Object.keys(PLAYBOOK_PLAIN).sort()).toEqual([...PlaybookIdSchema.options].sort());
    expect(Object.keys(REASON_PLAIN).sort()).toEqual([...GUARD_REASON_CODES].sort());
    for (const line of [...Object.values(PLAYBOOK_PLAIN), ...Object.values(REASON_PLAIN), NOTHING_WRONG, WARNING_SIGNS, STILL_CHECKING, WATCHED_LATE]) {
      expect(line, line).toMatch(/^[A-Z].*\.$/);
      expect(line.split(/\s+/).length, line).toBeLessThanOrEqual(14);
      expect(line, line).not.toMatch(JARGON);
      expect(line, line).not.toMatch(/\d/);
    }
    expect(PLAYBOOK_PLAIN.dev_dump).toBe('The people who made it already sold most of theirs.');
    expect(REASON_PLAIN.SELL_RESTRICTION).toBe('You may not be able to sell it.');
    expect(PLAYBOOK_PLAIN.fake_mcap).toBe('Its price is mostly made up: almost no real money is behind it.');
  });
  it('answers in a word or two, in the verdict’s own terms', () => {
    expect(answerOf({ level: 'clear' })).toEqual({ kind: 'ok', word: 'Looks OK' });
    expect(answerOf({ level: 'monitor' })).toEqual({ kind: 'careful', word: 'Be careful' });
    expect(answerOf({ level: 'danger' })).toEqual({ kind: 'dont', word: "Don't buy" });
    expect(answerOf({ level: 'pending' })).toEqual({ kind: 'checking', word: 'Still checking' });
    expect(answerOf({ level: 'clear', pending: true }).kind).toBe('checking');
    expect(answerOf({ level: 'clear', historyPartial: { since: '2026-11-01T00:00:00.000Z' } })).toEqual({ kind: 'ok', word: 'Looks OK so far' });
    expect(answerOf({ level: 'danger', historyPartial: { since: '2026-11-01T00:00:00.000Z' } }).word).toBe("Don't buy");
  });
  it('gives one reason: the strongest finding, else what the answer means', () => {
    expect(plainReason(verdict('danger', [{ id: 'run_up', level: 'monitor' }, { id: 'dev_dump', level: 'danger' }]))).toBe(PLAYBOOK_PLAIN.dev_dump);
    expect(plainReason(verdict('monitor', [{ id: 'serial_deployer', level: 'info' }]))).toBe(WARNING_SIGNS);
    expect(plainReason(verdict('monitor', [{ id: 'malicious_hook', level: 'monitor' }]))).toMatch(/hasn't checked/);
    expect(plainReason(verdict('clear', [{ id: 'tax_trap', level: 'info' }]))).toBe(NOTHING_WRONG);
    expect(plainReason(verdict('clear', [], { historyPartial: { since: '2026-11-01T00:00:00.000Z' } }))).toBe(WATCHED_LATE);
    expect(plainReason(verdict('pending'))).toBe(STILL_CHECKING);
    expect(plainReason(null)).toBe(STILL_CHECKING);
  });
  it('says plainly whether you can sell it later, and what $100 comes back as', () => {
    expect(canSell(null)).toBe('unknown');
    expect(canSell(card({}))).toBe('yes');
    expect(canSell(card({ honeypot: true }))).toBe('no');
    expect(canSell(card({ flags: ['sell_check_refused'] }))).toBe('no');
    expect(canSell(card({ e100: 45 }))).toBe('maybe');
    expect(canSell(card({ flags: ['sell_check_not_available'] }))).toBe('unknown');
    expect(canSell(card({ missing: ['exitCostPct'] }))).toBe('unknown');
    expect(Object.values(SELL_WORDS)).toEqual(['Yes', 'Maybe not', 'No', 'Not checked yet']);
    expect(hundredBack(card({ e100: 2.4 }))).toBe(98);
    expect(hundredBack(card({ honeypot: true }))).toBeNull();
    expect(hundredBack(card({ missing: ['exitCostPct.usd100'] }))).toBeNull();
    expect(hundredBack(card({ e100: 100 }))).toBeNull();
    expect(moveText(12.4, 'today')).toBe('Up 12% today');
    expect(moveText(-30.2, 'today')).toBe('Down 30% today');
    expect(moveText(0.2, 'in the last hour')).toBe('About the same in the last hour');
    expect(moveText(undefined, 'today')).toBeNull();
  });
});

describe('the Simple | Full choice', () => {
  it('starts in Simple with no saved choice, or one that cannot be read', () => {
    expect(savedChoice(null)).toBe('simple');
    expect(savedChoice('nonsense')).toBe('simple');
    expect(savedChoice('full')).toBe('full');
    expect(useSimple.getState().choice).toBe('simple');
    expect(savedWalks('not json')).toEqual([]);
    expect(savedWalks('["list","other"]')).toEqual(['list']);
  });
  it('switches at once, and survives storage that throws', () => {
    // Two big segments, the current one lit (a server render reads the store's first state: Simple).
    const html = renderToStaticMarkup(<Switch compact={false} />);
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>Simple</);
    expect(html).toMatch(/role="radio"[^>]*aria-checked="false"[^>]*>Full</);
    vi.stubGlobal('window', { get localStorage(): Storage { throw new Error('blocked'); } });
    useSimple.getState().choose('full');
    expect(useSimple.getState().choice).toBe('full');
    useSimple.getState().choose('simple');
    expect(useSimple.getState().choice).toBe('simple');
    vi.unstubAllGlobals();
  });
});

describe('Simple as a view of the site', () => {
  const views = [feature.views!];
  it('replaces the coins list and the coin page only, loaded lazily', () => {
    expect(Object.keys(feature.views!.pages).sort()).toEqual(['/coin/:address', '/radar']);
    expect(viewPage(views, '/radar')).not.toBeNull();
    expect(viewPage(views, '/pairs')).toBeNull();
  });
  it('keeps only the coins list, the watchlist and practice trading in the menu, and hides the terminal controls', () => {
    const menu = NAV_GROUPS.flatMap(([, items]) => items.map(([to]) => to as string)).concat(['/paper', '/multichart', '/quant', '/bonding-alerts']);
    expect(menu.filter(to => !navHidden(views, to)).sort()).toEqual(['/paper', '/radar', '/watch']);
    expect([...SIMPLE_MENU].sort()).toEqual(['/paper', '/radar', '/watch']);
    expect(navLabel(views, '/radar', 'Radar')).toBe('Coins');
    for (const part of ['search', 'plan', 'risk', 'crumb'] as const) expect(shellHidden(views, part)).toBe(true);
    expect(feature.places?.header).toBeDefined();
  });
  it('keeps Mission Control in the menu only for a signed-in owner whose agents are not all disconnected', async () => {
    const menu = () => NAV_GROUPS.flatMap(([, items]) => items.map(([to]) => to as string)).filter(to => !navHidden(views, to)).sort();
    const agent = (status: string) => ({ id: 'sample-agent', name: 'Sample', kind: 'other', status, uncheckedOrders24h: 0 });
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ agents: [agent('disconnected')] })));
    vi.stubGlobal('fetch', fetch);
    await readOwnerAgents('0x1111111111111111111111111111111111111111');
    expect(menu()).toEqual(['/radar', '/watch']);
    fetch.mockImplementation(async () => new Response(JSON.stringify({ agents: [agent('active')] })));
    await readOwnerAgents('0x2222222222222222222222222222222222222222');
    expect(menu()).toEqual(['/mission', '/radar', '/watch']);
    // Read once per wallet; signing out puts the menu back.
    await readOwnerAgents('0x2222222222222222222222222222222222222222');
    expect(fetch).toHaveBeenCalledTimes(2);
    await readOwnerAgents(null);
    expect(useOwnerAgents.getState().has).toBe(false);
    expect(menu()).toEqual(['/radar', '/watch']);
    vi.unstubAllGlobals();
  });
  it('replays its own walkthrough from Help while Simple is chosen', () => {
    useOnboarding.setState({ guide: null, tour: null });
    const guide = { replay: () => { vi.mocked(navigate)('/radar'); useSimple.getState().startWalk('list'); } };
    useOnboarding.getState().setGuide(guide);
    useOnboarding.getState().replayTour();
    expect(useOnboarding.getState().tour).toBeNull();
    expect(useSimple.getState().walk).toBe('list');
    useSimple.getState().endWalk();
    expect(useSimple.getState().walked).toContain('list');
    useOnboarding.getState().setGuide(null);
  });
});

describe('walkthroughs', () => {
  it('walks the coins list in four short steps, ending on the switch', () => {
    expect(LIST_WALK.map(s => s.id)).toEqual(['list', 'answer', 'search', 'switch']);
    expect(LIST_WALK[0]!.body).toBe('These are new coins. EKO checks every one.');
    expect(LIST_WALK[2]!.body).toBe('Got a coin from a friend? Paste its address here.');
  });
  it('walks a coin page in three, saying what the big button does on that page', () => {
    expect(coinWalk(false).map(s => s.id)).toEqual(['answer', 'sell', 'buy']);
    expect(coinWalk(false)[2]!.title).toBe('Buy with one button');
    expect(coinWalk(true)[2]!.title).toBe('Find a safer coin');
  });
  it('keeps every card short and plain', () => {
    for (const s of [...LIST_WALK, ...coinWalk(false), ...coinWalk(true)]) {
      // About twelve words; the two the owner wrote run to fifteen.
      expect(s.body.split(/\s+/).length, s.body).toBeLessThanOrEqual(15);
      expect(s.title.split(/\s+/).length, s.title).toBeLessThanOrEqual(5);
      expect(`${s.title} ${s.body}`, s.body).not.toMatch(JARGON);
    }
  });
});
