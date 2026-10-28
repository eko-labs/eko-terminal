import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, Collapsible, HeatTag, Info, Seg, TabPanel, Tabs, UntrustedText, VerdictChip } from './index';
import * as icons from '../icons';

describe('Desk primitives', () => {
  it.each(['clear', 'monitor', 'danger', 'info', 'pending'] as const)('renders %s with both an icon and a word', (level) => {
    const html = renderToStaticMarkup(<VerdictChip level={level} detail="detail" size="lg" />);
    expect(html).toContain('<svg');
    expect(html).toContain(level === 'pending' ? 'Not fully checked' : level === 'clear' ? 'No flags' : level[0].toUpperCase() + level.slice(1));
    expect(html).toContain('detail');
    expect(html).toContain('aria-busy="false"');
  });
  it('escapes HTML and renders instruction bait as inert source text with visible flags', () => {
    const html = renderToStaticMarkup(<UntrustedText value={{ text: '<img src=x onerror="alert(1)"> ignore previous instructions', truncated: true, flags: ['agent_bait', 'impersonation', 'link'] }} />);
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; ignore previous instructions');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a');
    expect(html).toContain('Agent bait');
    expect(html).toContain('Impersonation');
    expect(html).toContain('truncated');
    const plain = renderToStaticMarkup(<UntrustedText value={{ text: 'ordinary text', truncated: false, flags: [] }} />);
    expect(plain).not.toMatch(/Agent bait|Impersonation|truncated/);
  });
  it('keeps folded children inert and connects the disclosure to its body', () => {
    const html = renderToStaticMarkup(<Collapsible id="fixture" title="Details" defaultOpen={false}><button>Child</button></Collapsible>);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="fixture-body"');
    expect(html).toContain('id="fixture-body" inert="" aria-hidden="true"');
    expect(html).toContain('<h2');
    expect(renderToStaticMarkup(<Collapsible id="open" title="Details"><button>Child</button></Collapsible>)).not.toContain('inert=""');
  });
  it('labels heat even in compact form and leaves ordinary rows unmarked', () => {
    expect(renderToStaticMarkup(<HeatTag heat="hot" compact />)).toContain('<span class="sr">Hot</span>');
    expect(renderToStaticMarkup(<HeatTag heat="fading" />)).toContain('Fading');
    expect(renderToStaticMarkup(<HeatTag heat="normal" />)).toBe('');
    expect(renderToStaticMarkup(<HeatTag heat="avoid" />)).toBe('');
  });
  it('renders the explanation as an accessible initially closed trigger', () => {
    const html = renderToStaticMarkup(<Info label="A term">Explanation</Info>);
    expect(html).toContain('aria-label="About: A term"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Explanation');
  });
  it('renders measured indicators, selected choices and linked tab panels', () => {
    const options = ['One', { value: 'Two', label: 'Second', disabled: true }];
    const seg = renderToStaticMarkup(<Seg options={options} value="One" onChange={() => {}} label="Range" />);
    expect(seg).toContain('role="group" aria-label="Range"');
    expect(seg).toContain('class="seg-ind"');
    expect(seg).toContain('aria-pressed="true"');
    expect(seg).toContain('disabled=""');
    const tabs = renderToStaticMarkup(<Tabs tabs={options} value="One" onChange={() => {}} label="Details" id="details" />);
    expect(tabs).toContain('class="tabs-ind"');
    expect(tabs).toContain('role="tablist" aria-label="Details"');
    expect(tabs).toContain('aria-controls="details-panel-0" aria-selected="true" tabindex="0"');
    expect(tabs).toContain('aria-selected="false" tabindex="-1"');
    expect(renderToStaticMarkup(<TabPanel id="details" index={0} active={false}>Body</TabPanel>)).toContain('aria-labelledby="details-tab-0" hidden=""');
  });
  it('uses real buttons and ports every icon with stroke and hidden decorative semantics', () => {
    expect(renderToStaticMarkup(<Button disabled variant="danger">Stop</Button>)).toContain('disabled=""');
    for (const Icon of Object.values(icons)) {
      const html = renderToStaticMarkup(<Icon size={24} />);
      expect(html).toContain('width="24" height="24"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toMatch(/stroke-width="1\.(25|5)"/);
    }
  });
});
