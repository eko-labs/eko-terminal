import { describe, expect, it } from 'vitest';
import { breadcrumbTrail } from './navigation';

describe('Desk breadcrumb mapping (§2.1)', () => {
  it.each([
    ['/mission', ['Mission Control', 'Overview']],
    ['/mission/connect', ['Mission Control', 'Connect an agent']],
    ['/radar', ['Terminal', 'Radar']],
    ['/pairs', ['Terminal', 'New pairs']],
    ['/scoreboard', ['Public record', 'Scoreboard']],
    ['/coin/0xabababababababababababababababababababab', ['Terminal', 'Radar', 'Coin']],
    ['/mission/agents/agent-1', ['Mission Control', 'Overview', 'Agent']],
    ['/bags/r/report-1', ['Terminal', 'Bags']],
    ['/settings/plan', ['Terminal', 'Plan']],
    ['/missing', ['Page not found']],
  ])('maps %s to its navigation ancestry', (path, expected) => {
    expect(breadcrumbTrail(path)).toEqual(expected);
  });
  it('prefers exact mission navigation over the overview prefix', () => {
    expect(breadcrumbTrail('/mission/approvals', { approvals: true })).toEqual(['Mission Control', 'Approvals']);
  });
  it('uses the longest applicable navigation prefix for a detail route', () => {
    expect(breadcrumbTrail('/lab/loop-1', { loop_lab: true })).toEqual(['Mission Control', 'Rule Lab']);
  });
  it('maps Research list and detail links under Mission Control', () => {
    expect(breadcrumbTrail('/research', { deep_research: true })).toEqual(['Mission Control', 'Research']);
    expect(breadcrumbTrail('/research/note-1', { deep_research: true })).toEqual(['Mission Control', 'Research']);
    expect(breadcrumbTrail('/research')).toEqual(['Page not found']);
  });
  it('keeps disabled routes and malformed paths in the not-found state', () => {
    expect(breadcrumbTrail('/mission/approvals')).toEqual(['Page not found']);
    expect(breadcrumbTrail('/lab/loop-1')).toEqual(['Page not found']);
    expect(breadcrumbTrail('/coin/%ZZ')).toEqual(['Page not found']);
  });
});
