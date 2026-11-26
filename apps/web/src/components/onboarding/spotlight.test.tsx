import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_ONBOARDING } from '@eko/shared';
vi.mock('../../lib/router', () => ({ usePath: () => '/radar', navigate: vi.fn() }));
vi.mock('../../lib/useMedia', () => ({ useMedia: () => false }));
import { useOnboarding } from '../../store/onboarding';
import { OnboardingView } from './Onboarding';
import { Spotlight, stepPastMissing, stepTo, type SpotlightStep } from './Spotlight';

describe('spotlight steps', () => {
  it('moves forward and back, finishes past the last step and stays put before the first', () => {
    expect(stepTo(0, 1, 3)).toBe(1);
    expect(stepTo(1, -1, 3)).toBe(0);
    expect(stepTo(2, 1, 3)).toBe('done');
    expect(stepTo(0, -1, 3)).toBeNull();
  });
  it('passes over a step whose element is not on screen, the way the reader was going', () => {
    expect(stepPastMissing(1, 1, 4)).toEqual({ to: 2, dir: 1 });
    expect(stepPastMissing(2, -1, 4)).toEqual({ to: 1, dir: -1 });
    expect(stepPastMissing(3, 1, 4)).toEqual({ to: 'done', dir: 1 });
    // Going back from the first step that is missing turns around.
    expect(stepPastMissing(0, -1, 4)).toEqual({ to: 1, dir: 1 });
    expect(stepPastMissing(0, -1, 1)).toEqual({ to: 'done', dir: 1 });
    expect(stepPastMissing(0, 1, 0)).toEqual({ to: 'done', dir: 1 });
  });
  it('draws dots, Next and Skip, and leaves Back out when asked', () => {
    const steps: SpotlightStep[] = [{ id: 'a', find: () => null, title: 'First', body: 'One' }, { id: 'b', find: () => null, title: 'Second', body: 'Two' }];
    const html = renderToStaticMarkup(<Spotlight steps={steps} step={0} onStep={() => undefined} onDone={() => undefined} isMobile={false} phone="float" progress="dots" name="walk" labels={{ skip: 'Skip', back: null, next: 'Next', finish: 'Done' }} />);
    expect(html).toContain('data-testid="walk"');
    expect(html).toContain('tour--float');
    expect(html.match(/<i[ >]/g)).toHaveLength(2);
    expect(html).toContain('>Skip<');
    expect(html).toContain('>Next<');
    expect(html).not.toContain('walk-back');
    // The tour's own look is the default.
    const tour = renderToStaticMarkup(<Spotlight steps={steps} step={1} onStep={() => undefined} onDone={() => undefined} isMobile={false} />);
    expect(tour).toContain('data-testid="tour-count"');
    expect(tour).toContain('>Skip tour<');
    expect(tour).toContain('>Finish<');
    expect(tour).toContain('data-testid="tour-back"');
  });
});

describe('another walkthrough in charge', () => {
  const reset = () => useOnboarding.setState({ ...DEFAULT_ONBOARDING, checklist: { ...DEFAULT_ONBOARDING.checklist }, hydrated: true, owner: null, scanSeen: true, disabled: false, welcomeOpen: false, tour: null, pointer: null, helpOpen: false, guide: null });
  it('keeps the tour offer and checklist as they are while nothing else guides', () => {
    reset();
    expect(renderToStaticMarkup(<OnboardingView state={useOnboarding.getState()} path="/radar" />)).toContain('Take the 40-second tour.');
    useOnboarding.getState().replayTour();
    expect(useOnboarding.getState().tour).toEqual({ step: 0 });
  });
  it('hides the tour offer, the tour and the checklist, and replays the other walkthrough instead', () => {
    reset();
    const replay = vi.fn();
    useOnboarding.getState().startTour();
    useOnboarding.getState().setGuide({ replay });
    expect(useOnboarding.getState().tour).toBeNull();
    const html = renderToStaticMarkup(<OnboardingView state={useOnboarding.getState()} path="/radar" />);
    expect(html).not.toContain('Take the 40-second tour.');
    expect(html).not.toContain('checklist');
    useOnboarding.getState().replayTour();
    expect(replay).toHaveBeenCalledOnce();
    expect(useOnboarding.getState().tour).toBeNull();
    useOnboarding.getState().setGuide(null);
    expect(renderToStaticMarkup(<OnboardingView state={useOnboarding.getState()} path="/radar" />)).not.toBe('');
  });
});
