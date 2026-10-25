import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Lockup, LogoMark } from './brand';
import { Workspace } from '../pages/Workspace';

const MARK = 'M26 3a16 16 0 1 0 0 30M23 10a9 9 0 1 0 0 16M20 16a2.5 2.5 0 1 0 0 4';

describe('EKO day-one shell', () => {
  it('renders the specified echo mark without a retired asset request', () => {
    const html = renderToStaticMarkup(createElement(LogoMark));
    expect(html).toContain('viewBox="0 0 36 36"');
    expect(html).toContain('fill="none" stroke="currentColor" stroke-width="1.25"');
    expect(html).toContain(`d="${MARK}"`);
    expect(html).not.toContain('<img');
    expect(renderToStaticMarkup(createElement(Lockup))).toContain('EKO');
  });

  it('renders a terminal placeholder after retiring the markets, analyst and paper UI', () => {
    const html = renderToStaticMarkup(createElement(Workspace));
    expect(html).toContain('EKO terminal');
    expect(html).toContain('The terminal is being built.');
    expect(html).not.toMatch(/Markets|analyst|BUY|SELL|Paper|Positions/);
  });
});
