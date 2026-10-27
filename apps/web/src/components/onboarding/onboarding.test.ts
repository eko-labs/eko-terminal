import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ONBOARDING } from '@eko/shared';
import { CHECKLIST_STEPS, mergeProgress, useOnboarding } from '../../store/onboarding';
import { ALL_TERMS, GLOSSARY, searchTerms } from './glossary';
import type { TermId } from './Term';

describe('onboarding progress', () => {
  beforeEach(() => useOnboarding.setState({ ...DEFAULT_ONBOARDING, checklist: { ...DEFAULT_ONBOARDING.checklist }, owner: null }));
  it('OR-merges flags from server and local copies and keeps the highest version', () => {
    const p = mergeProgress(
      { version: 1, welcomeDone: true, checklist: { paper_trade: false, close_position: false, go_live: false } },
      { version: 0, tourDone: true, checklist: { paper_trade: true, close_position: false, go_live: false } },
    );
    expect(p).toMatchObject({ version: 1, welcomeDone: true, tourDone: true, checklistDismissed: false, liveIntroSeen: false });
    expect(p.checklist).toEqual({ ...DEFAULT_ONBOARDING.checklist, paper_trade: true });
  });

  it('ignores missing or malformed sources', () => {
    const p = mergeProgress(null, undefined, { version: Number.NaN, welcomeDone: 'yes' as unknown as boolean, checklist: { paper_trade: 1 } as never });
    expect(p.version).toBe(0);
    expect(p.welcomeDone).toBe(false);
    expect(Object.values(p.checklist).every((v) => v === false)).toBe(true);
  });

  it('markStep is idempotent and ignores unknown steps', () => {
    const st = useOnboarding.getState();
    st.markStep('scan_coin');
    const after = useOnboarding.getState().checklist;
    expect(after.scan_coin).toBe(true);
    st.markStep('scan_coin');
    expect(useOnboarding.getState().checklist).toBe(after); // no new object, no re-render
    st.markStep('nope' as never);
    expect(Object.keys(useOnboarding.getState().checklist).sort()).toEqual(Object.keys(DEFAULT_ONBOARDING.checklist).sort());
    expect(CHECKLIST_STEPS).toEqual(['scan_coin', 'open_evidence', 'scan_bags', 'guarded_trade', 'connect_agent']);
  });

  it('hydrate keeps steps detected before progress loaded', () => {
    useOnboarding.getState().markStep('close_position');
    useOnboarding.getState().hydrate({ welcomeDone: true, checklist: { paper_trade: true, close_position: false, go_live: false } });
    const s = useOnboarding.getState();
    expect(s.hydrated).toBe(true);
    expect(s.welcomeDone).toBe(true);
    expect(s.checklist.close_position).toBe(true);
    expect(s.checklist.paper_trade).toBe(true);
  });
});

describe('glossary', () => {
  const ids: TermId[] = ['rule_lab', 'paper', 'live', 'slippage', 'gas', 'usdg', 'approval', 'spot_only'];

  it('defines every TermId in one or two short sentences', () => {
    for (const id of ids) {
      const e = GLOSSARY[id];
      expect(e, id).toBeDefined();
      expect(e.term.length).toBeGreaterThan(1);
      expect(e.short.length, id).toBeLessThanOrEqual(200);
    }
    expect(ALL_TERMS.length).toBeGreaterThanOrEqual(ids.length);
  });

  it('never promises profit', () => {
    for (const e of ALL_TERMS) expect(`${e.short} ${e.more ?? ''}`).not.toMatch(/guarantee|risk-free|will profit|sure win/i);
  });

  it('searches terms, definitions and synonyms', () => {
    expect(searchTerms('gas').map((e) => e.id)).toContain('gas');
    expect(searchTerms('shorting').map((e) => e.id)).toContain('spot_only');
    expect(searchTerms('allowance').map((e) => e.id)).toContain('approval');
    expect(searchTerms('')).toHaveLength(ALL_TERMS.length);
    expect(searchTerms('zzzz-nothing')).toHaveLength(0);
  });
});
