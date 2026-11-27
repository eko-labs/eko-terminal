import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LedMatrix, LedWait, Shimmer, turnedTo } from './Led';
import { VerdictChip } from './index';
import { AnswerChip } from '../../features/simple_mode/parts';

describe('LED indicator', () => {
  it('is a hidden canvas the size asked for, its bloom spilling past a box that keeps that size', () => {
    const html = render(<LedMatrix pattern="fall" tone="coral" size={20} />);
    expect(html).toMatch(/^<span class="led " aria-hidden="true" style="--led-size:20px;--led-spill:3px"><canvas width="\d+" height="\d+" data-pattern="fall" data-tone="coral"><\/canvas><\/span>$/);
    expect(render(<LedMatrix pattern="ring" />)).toContain('data-tone="blue"');
  });
  it('shimmers words without changing them', () => {
    expect(render(<Shimmer>Checking…</Shimmer>)).toMatch(/<span class="shimmer " style="animation-delay:-?\d+ms">Checking…<\/span>/);
  });
  it('a still-checking verdict chip shows the blue ring and a shimmering "Checking…", busy; settled chips stay still', () => {
    const html = render(<VerdictChip level="pending" verdictPending />);
    expect(html).toContain('aria-busy="true"'); expect(html).toContain('data-pattern="ring"');
    expect(html).toContain('<span class="shimmer "'); expect(html).toContain('Checking…'); expect(html).not.toContain('<svg');
    for (const level of ['clear', 'monitor', 'danger', 'pending'] as const) expect(render(<VerdictChip level={level} />)).not.toContain('<canvas');
    // A delayed scan is waiting, not working: no ring.
    expect(render(<VerdictChip level="pending" verdictPending scanDelayed />)).not.toContain('<canvas');
  });
  it("Simple's answer chip does the same while still checking, and only then", () => {
    expect(render(<AnswerChip answer={{ kind: 'checking', word: 'Still checking' }} />)).toMatch(/data-pattern="ring".*shimmer.*Still checking/);
    expect(render(<AnswerChip answer={{ kind: 'dont', word: "Don't buy" }} />)).not.toContain('<canvas');
  });
  it('a loading block keeps the skeleton class it stands in for and says what it is doing', () => {
    const html = render(<LedWait className="coin-flow-skel" label="Loading trades" text="Reading the trades…" />);
    expect(html).toContain('class="led-wait coin-flow-skel" role="status" aria-label="Loading trades"');
    expect(html).toContain('Reading the trades…'); expect(html).not.toMatch(/class="(?:[^"]* )?skel[ "]/);
  });
  it('plays the turn-to-danger fall only on a change from a known verdict, never on first load', () => {
    expect(turnedTo(undefined, 'danger', 'danger')).toBe(false);
    expect(turnedTo(null, 'danger', 'danger')).toBe(false);
    expect(turnedTo('monitor', 'danger', 'danger')).toBe(true);
    expect(turnedTo('pending', 'danger', 'danger')).toBe(true);
    expect(turnedTo('danger', 'danger', 'danger')).toBe(false);
    expect(turnedTo('danger', 'monitor', 'danger')).toBe(false);
  });
});
