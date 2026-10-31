import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FeedItem, Untrusted } from '@eko/shared';
import { createFeedRows } from '../../mocks/demo/feed';
import { FeedDescription, FeedRow, feedTime } from './Feed';
import { feedDescription } from './pairsFeedModel';
import { PLAYBOOK_DESCRIPTIONS } from '../../copy/playbooks';

const untrusted = (text: string): Untrusted => ({ text, flags: [], truncated: false });
const base: FeedItem = { id: 'test', ts: 1000000, block: 4663000, kind: 'agent_trade', coin: `0x${'1'.repeat(40)}`, symbol: untrusted('COIN') };
const item = (fields: Partial<FeedItem>): FeedItem => ({ ...base, ...fields });
describe('CA-32 feed descriptions', () => {
  it.each([
    [item({ label: 'declared_agent', agentName: untrusted('Quiet Otter'), side: 'sell' }), 'Declared agent Quiet Otter sold'],
    [item({ label: 'likely_agent', wallet: '0x594a0000000000000000000000000000000016e1', side: 'sell' }), 'Likely agent 0x594a…16e1 sold'],
    [item({ kind: 'crew_trade', label: 'crew', crewName: 'Night Shift', crewWallets: 13, side: 'buy' }), 'Crew Night Shift 13 wallets bought'],
    [item({ label: 'human', wallet: '0xdac8000000000000000000000000000000000dec', side: 'buy' }), 'Human 0xdac8…0dec bought'],
    [item({ kind: 'playbook', playbookId: 'agent_bait', matchPct: 94 }), `Agent bait matched at 94% · ${PLAYBOOK_DESCRIPTIONS.agent_bait}`],
    [item({ kind: 'clone', cloneOf: untrusted('EKO'), clones7d: 6 }), 'Ghost Report · Clone of $EKO · 6 clones from this crew this week'],
    [item({ kind: 'verdict', firstVerdictMs: 4100 }), 'First verdict in 4.1 s · no playbook matched'],
    [item({ kind: 'verdict', firstVerdictMs: 2690, playbookId: 'honeypot' }), 'First verdict in 2.7 s · Honeypot'],
    // A Danger or Monitor grade is never described as "no playbook matched".
    [item({ kind: 'verdict', firstVerdictMs: 4100, level: 'danger' }), 'First verdict in 4.1 s'],
    [item({ kind: 'verdict', firstVerdictMs: 4100, level: 'clear' }), 'First verdict in 4.1 s · no playbook matched'],
    // Long after the launch it is a coin graded again, not a first scan that took days.
    [item({ kind: 'verdict', firstVerdictMs: 276_119_000, playbookId: 'bundle_dump' }), 'Grade updated · Bundle dump'],
    [item({ kind: 'swarm', swarm: { pass: 7, of: 9 } }), '7 of 9 personas pass · graded against all launches'],
    [item({ kind: 'wash' }), 'Playbook alert · Wash trading'],
  ])('renders %j as %s', (event, expected) => expect(feedDescription(event)).toBe(expected));
  it('omits absent optional parts instead of inventing names, direction, percentages, duration or votes', () => {
    expect(feedDescription(base)).toBe('');
    expect(feedDescription(item({ label: 'declared_agent' }))).toBe('Declared agent');
    expect(feedDescription(item({ agentName: untrusted('Quiet Otter') }))).toBe('Quiet Otter');
    expect(feedDescription(item({ kind: 'crew_trade', label: 'crew', crewName: 'Night Shift' }))).toBe('Crew Night Shift');
    expect(feedDescription(item({ kind: 'playbook', playbookId: 'agent_bait' }))).toBe(`Agent bait matched · ${PLAYBOOK_DESCRIPTIONS.agent_bait}`);
    expect(feedDescription(item({ kind: 'playbook', matchPct: 94 }))).toBe('matched at 94%');
    expect(feedDescription(item({ kind: 'clone' }))).toBe('Ghost Report');
    expect(feedDescription(item({ kind: 'verdict' }))).toBe('First verdict · no playbook matched');
    expect(feedDescription(item({ kind: 'swarm' }))).toBe('graded against all launches');
  });
  it('renders supplied zero counts and percentages', () => {
    expect(feedDescription(item({ kind: 'crew_trade', crewWallets: 0 }))).toBe('0 wallets');
    expect(feedDescription(item({ kind: 'clone', clones7d: 0 }))).toBe('Ghost Report · 0 clones from this crew this week');
    expect(feedDescription(item({ kind: 'playbook', matchPct: 0 }))).toBe('matched at 0%');
    expect(feedDescription(item({ kind: 'verdict', firstVerdictMs: 0 }))).toContain('in 0.0 s');
    expect(feedDescription(item({ kind: 'swarm', swarm: { pass: 0, of: 9 } }))).toBe('0 of 9 personas pass · graded against all launches');
  });
  it('escapes agentName and cloneOf through UntrustedText, preserving their warning chips', () => {
    const value: Untrusted = { text: '<img src=x onerror="evil()">', flags: ['agent_bait'], truncated: true };
    for (const event of [item({ agentName: value }), item({ kind: 'clone', cloneOf: value })]) {
      const html = renderToStaticMarkup(<FeedDescription item={event} />);
      expect(html).toContain('class="untrusted'); expect(html).toContain('&lt;img');
      expect(html).not.toContain('<img'); expect(html).toContain('Agent bait'); expect(html).toContain('truncated');
    }
    const html = renderToStaticMarkup(<FeedDescription item={item({ kind: 'playbook', playbookId: 'agent_bait', symbol: value })} />);
    expect(html).toContain(PLAYBOOK_DESCRIPTIONS.agent_bait); expect(html).not.toContain('evil()');
  });
  it('retains Beta on swarm rows, trade glyphs, internal links and decimal thousands', () => {
    const swarm = renderToStaticMarkup(<ul><FeedRow item={item({ kind: 'swarm', swarm: { pass: 7, of: 9 } })} /></ul>);
    expect(swarm).toContain('Beta'); expect(swarm).toContain('7 of 9 personas pass');
    const trade = renderToStaticMarkup(<ul><FeedRow item={item({ label: 'human', side: 'buy', sizeUsd: 3999 })} /></ul>);
    expect(trade).toContain('label-glyph human'); expect(trade).toContain('$4.0K'); expect(trade).toContain(`href="/coin/${base.coin}"`);
  });
  it('ports the visible prototype batch in order, including HALO first and structured names', () => {
    const rows = createFeedRows(1000000);
    expect(rows.slice(0, 6).map((r) => r.symbol.text)).toEqual(['HALO', 'REEF', 'BYTE', 'LUMA', 'PIXL', 'CINDER']);
    expect(rows[0]).toMatchObject({ kind: 'playbook', level: 'danger', playbookId: 'agent_bait', matchPct: 94 });
    expect(rows.some((r) => r.agentName && r.side)).toBe(true);
    expect(rows.some((r) => r.crewName && r.crewWallets !== undefined)).toBe(true);
    expect(rows.some((r) => r.cloneOf && r.clones7d === 6)).toBe(true);
    expect(rows.some((r) => r.firstVerdictMs !== undefined)).toBe(true);
    expect(rows.some((r) => r.swarm)).toBe(true);
  });
  it('shows a short address for coins without an indexed symbol, and UTC times', () => {
    const html = renderToStaticMarkup(<FeedRow item={item({ symbol: untrusted(''), ts: Date.UTC(2026, 9, 4, 13, 22, 5) })} />);
    expect(html).toContain('0x1111…1111');expect(html).not.toMatch(/fr-sym[^>]*>\$</);
    expect(html).toContain('>13:22:05</time>');
    expect(feedTime(Date.UTC(2026, 9, 4, 0, 0, 9))).toBe('00:00:09');
  });
});
