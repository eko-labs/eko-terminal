import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createRadarCard, createRadarRows } from '../../mocks/demo/radar';
import { createPairRows } from '../../mocks/demo/pairs';
import { CoinVerdict } from './CoinCard';
import { PairView } from './Pairs';
import { RadarRowView } from './RadarParts';
import { coinVerdictActivity } from './radarModel';

const launch = {
  verdict: 'clear', verdictPending: false, guardV2: null, topPlaybook: undefined, launchpad: 'pons', stage: 'curve',
  curvePct: 0, graduationPct: 0, liquidityUsd: 0, ageSec: 300, volume1hUsd: 0, trades1h: 0, unavailable: [],
} as const;
const emptyHour = { buyUsd: 0, sellUsd: 0, netUsd: 0, buys: 0, sells: 0, buyers: 0, sellers: 0, unattributed: 0 };
const base = createRadarRows()[0];
const flow = { ...base.flow, window: '1h' as const, activity: emptyHour };
const row = { ...base, ...launch, unavailable: [], flow };
const pair = { ...createPairRows()[0], ...launch, unavailable: [], flow, buyers: 0 };
const source = createRadarCard(row.address)!;
const verdict = { ...source.verdict, level: 'clear' as const, guardV2: undefined, playbooks: [], reasons: [] };
const card = { ...source, flow, verdict, identity: { ...source.identity, launchpad: 'pons' as const, stage: 'curve' as const, curvePct: 0,
  pools: [{ ...source.identity.pools[0], venue: 'pons_curve' as const, liquidityUsd: 0 }] } };
const activity = coinVerdictActivity(card, Date.parse(card.identity.createdAt) + 300_000);
const select = () => {};

describe('Terminal verdict chips', () => {
  it('uses a muted, labeled zero score with an accessible explanation on all three surfaces', () => {
    const views = [
      render(<RadarRowView c={row} selected={false} select={select} trade={select} pulse={0} />),
      render(<PairView row={pair} now={0} at={0} select={select} trade={select} stale={false} />),
      render(<CoinVerdict verdict={verdict} identity={card.identity} activity={activity} />),
    ];
    for (const html of views) {
      const chip = html.match(/<button[^>]*class="verdict neutral[^>]*>[\s\S]*?<\/button>/)?.[0];
      expect(chip).toContain('Dead · no buyers');
      // A dead coin's chip drops "Run-up 0" but keeps its tap-to-explain description.
      expect(chip).not.toContain('Run-up');
      expect(chip).toContain('aria-expanded="false"');
      expect(chip).not.toContain('<svg');
      const descriptionId = chip?.match(/aria-describedby="([^"]+)"/)?.[1];
      expect(html).toContain(`id="${descriptionId}" class="verdict-description" hidden=""`);
      expect(html).toContain('The checks that ran found no flags.');
      expect(html).not.toContain('class="verdict clear');
    }
  });

  it.each(['monitor', 'danger'] as const)('keeps the %s grade and explains it on a dead curve', level => {
    const html = render(<PairView row={{ ...pair, verdict: level }} now={0} at={0} select={select} trade={select} stale={false} />);
    expect(html).toContain(`class="verdict ${level} verdict-explain"`);
    expect(html).toContain('Run-up 0');
    expect(html).toContain(`${level === 'monitor' ? 'Monitor' : 'Danger'} means the guard found`);
    expect(html).not.toContain('Dead ·');
  });

  it('explains a nonzero score as the percentage drop back to the start', () => {
    const html = render(<PairView row={{ ...pair, curvePct: 10 }} now={0} at={0} select={select} trade={select} stale={false} />);
    expect(html).toContain('Run-up 36');
    expect(html).toContain('about a 36% drop');
  });
});
