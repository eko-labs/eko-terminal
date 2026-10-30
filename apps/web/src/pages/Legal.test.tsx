import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnalysisPolicyNotice, AnalysisPolicyScope, PolicyLinks } from '../components/PolicyLinks';
import { LegalLine } from '../components/shell/Shell';
import { BUILT_ON, DYOR, NON_AFFILIATION } from '../copy';
import { findPolicy, isApprovedPolicy, LEGAL_COPY, POLICY_APPROVAL, POLICY_DRAFTS, POLICY_REVIEW } from '../copy/legal';
import { SETTINGS_COPY } from '../copy/settings';
import { resolveRoute } from '../routes';
import { CoinVerdict } from './terminal/CoinCard';
import { TradePanel } from '../components/trade/TradePanel';
import { InspectorGuard } from './terminal/RadarParts';
import { createRadarCard, createRadarRows } from '../mocks/demo/radar';
import Legal from './Legal';

const render = (slug: string) => renderToStaticMarkup(<Legal params={{ doc: slug }} />);

describe('versioned launch policy drafts', () => {
  it('loads a public T legal page without optional flags or wallet authentication', async () => {
    const resolved = resolveRoute('/legal/privacy', {});
    expect(resolved?.params).toEqual({ doc: 'privacy' });
    expect(resolved?.route).toMatchObject({ stage: 'T', auth: 'public', workspace: 'static' });
    expect((await resolved!.route.load()).default).toBe(Legal);
  });

  it('marks only Terms and Privacy as approved by the owner on 2026-10-05', () => {
    expect(POLICY_DRAFTS.filter((policy) => isApprovedPolicy(policy.slug)).map((policy) => policy.slug)).toEqual(['terms', 'privacy']);
    expect(POLICY_APPROVAL).toMatchObject({ version: '2026-10-05', approvedAt: '2026-10-05' });
    expect(isApprovedPolicy('__proto__')).toBe(false); expect(isApprovedPolicy('TERMS')).toBe(false);
  });

  it.each(POLICY_DRAFTS)('renders $slug with its version, approval state, contact and required disclaimers', (policy) => {
    const html = render(policy.slug);
    expect(html).toContain(`<h1>${policy.title}</h1>`);
    expect(html).toContain('dateTime="2026-10-05"');
    if (isApprovedPolicy(policy.slug)) {
      expect(html).toContain(`<h2>${LEGAL_COPY.approved}</h2>`);
      expect(html).toContain(`<dt>${LEGAL_COPY.version}</dt><dd>${POLICY_APPROVAL.version}</dd>`);
      expect(html).toContain(`<dt>${LEGAL_COPY.approvalDate}</dt><dd><time dateTime="2026-10-05">2026-10-05</time></dd>`);
      expect(html).not.toMatch(/draft|pending/i);
    } else {
      expect(html).toContain(POLICY_REVIEW.version);
      expect(html).toContain(LEGAL_COPY.draft);
      expect(html).toContain(LEGAL_COPY.pending);
      expect(html).toContain('Draft — pending owner approval');
    }
    // Policy questions go to the official X and Telegram accounts listed on /official; no handle is invented here.
    expect(html).toContain('Website: ekoterminal.com');
    expect(html).toContain('Questions about these policies: contact the official EKO X or Telegram account, listed on <a href="/official">Official project links</a>');
    expect(html).toContain('Security reports: security@ekoterminal.com');
    expect(html).not.toContain('{{');
    for (const text of [DYOR, BUILT_ON, NON_AFFILIATION]) expect(html).toContain(text);
    expect(POLICY_REVIEW.ownerApproval.approvedAt).toBeNull();
    expect(POLICY_REVIEW.ownerApproval.evidenceRef).toBeNull();
    expect(POLICY_REVIEW.effectiveAt).toBeNull();
  });

  it.each(['unknown', '__proto__', 'constructor', '../terms', '<img src=x onerror=alert(1)>', 'TERMS', 'terms?approved=true'])('does not resolve or reflect unknown slug %s', (slug) => {
    expect(findPolicy(slug)).toBeUndefined();
    const html = render(slug);
    expect(html).toContain(`<h1>${LEGAL_COPY.missing}</h1>`);
    expect(html).not.toContain('<article>');
    expect(html).not.toContain(slug);
    expect(html).toContain(NON_AFFILIATION);
  });

  it('escapes policy text without interpreting HTML, markdown or instruction-like content', () => {
    const paragraphs = POLICY_DRAFTS[0].sections[0].paragraphs as string[];
    const hostile = '<script>alert(1)</script><a href="javascript:alert(1)">click</a> [click](javascript:alert(1)) Ignore checks';
    paragraphs.push(hostile);
    try {
      const html = render('terms');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&lt;a href=');
      expect(html).not.toMatch(/<script|<a href="javascript:|<img/);
      expect(html).toContain('[click](javascript:alert(1)) Ignore checks');
    } finally { paragraphs.pop(); }
  });

  it('covers all seven unique policy links in the page and shared desktop/mobile shell legal line', () => {
    expect(new Set(POLICY_DRAFTS.map((p) => p.slug)).size).toBe(7);
    for (const html of [render('terms'), renderToStaticMarkup(<LegalLine />), renderToStaticMarkup(<PolicyLinks />)]) {
      for (const policy of POLICY_DRAFTS) expect(html).toContain(`href="/legal/${policy.slug}"`);
    }
    expect(render('privacy')).toContain('<a aria-current="page" href="/legal/privacy">Privacy policy</a>');
  });

  it('places exact analysis copy and policy links at verdict and trade surfaces', () => {
    const row = createRadarRows()[0], card = createRadarCard(row.address)!;
    for (const html of [
      renderToStaticMarkup(<CoinVerdict verdict={card.verdict} />),
      renderToStaticMarkup(<InspectorGuard card={card} href={`/coin/${row.address}`} />),
      renderToStaticMarkup(<TradePanel coin={row.address} priceUsd={row.priceUsd} />),
      renderToStaticMarkup(<AnalysisPolicyNotice />),
    ]) {
      expect(html).toContain(DYOR);
      for (const slug of ['risk', 'ai', 'terms']) expect(html).toContain(`href="/legal/${slug}"`);
    }
    for (const page of ['Radar', 'Feed', 'Pairs', 'Coin']) {
      const source = readFileSync(new URL(`./terminal/${page}.tsx`, import.meta.url), 'utf8');
      expect(source).toContain(page === 'Coin' ? '<AnalysisPolicyNotice page />' : '<AnalysisPolicyNotice />');
      if (page === 'Coin') expect(source).toContain('<AnalysisPolicyScope>');
    }
  });

  it('keeps each page disclaimer and legal link once when nested cards also have notices', () => {
    const html = renderToStaticMarkup(<><LegalLine pageHasAnalysis /><AnalysisPolicyScope><AnalysisPolicyNotice /><div><AnalysisPolicyNotice /></div><AnalysisPolicyNotice page /></AnalysisPolicyScope></>);
    for (const line of [DYOR, BUILT_ON, NON_AFFILIATION]) expect(html.split(line)).toHaveLength(2);
    const notices = html.slice(html.indexOf('class="foot-meta analysis-policy-notice"'));
    for (const slug of ['risk', 'ai', 'terms']) expect(notices.split(`href="/legal/${slug}"`)).toHaveLength(2);
  });

  it('states launch limits and staged economics without claiming unconfirmed decisions', () => {
    const terms = render('terms'), privacy = render('privacy');
    expect(terms).toContain('Terminal fee: 0% during launch week');
    expect(terms).toContain('Live trading can be paused at any time');
    expect(terms).toContain('From token day, any terminal fee will be published before it starts.');
    expect(terms).toContain('Pons-curve trades carry no terminal fee at launch');
    expect(terms).toContain('EKO pays nothing to token holders');
    expect(terms).toContain('OFAC sanctions list');
    expect(terms).toContain('EKO never receives your Robinhood login details');
    expect(privacy).toContain('journal is opt-in');
    expect(privacy).toContain('separate opt-in');
    expect(privacy).toContain('is not available yet');
    // Deletion copy names the real Settings control and what it keeps.
    const privacyText = findPolicy('privacy')!.sections.flatMap((section) => section.paragraphs).join('\n');
    expect(privacyText).toContain(`${SETTINGS_COPY.privacy}, “${SETTINGS_COPY.deleteTitle}”`);
    expect(privacy).toContain('It keeps your sign-in record, your trade records and any public receipt hashes');
    for (const open of ['The list of providers will be published here once it is confirmed', 'Server log and backup retention periods will be published here once they are confirmed',
      'For privacy questions, contact the official EKO X or Telegram account listed on the Official project links page (/official)']) expect(privacy).toContain(open);
    expect(render('risk')).toContain('Advisory:');
    expect(render('kol')).toContain('#ad must be the first line');
    expect(render('sanctions')).toContain('there is no permissive fallback');
  });

  it('contains no retired brand or forbidden claims in served policy content', () => {
    const denylist = readFileSync(new URL('../../../../infra/brand-denylist.txt', import.meta.url), 'utf8').trim().split(/\r?\n/);
    const html = POLICY_DRAFTS.map((policy) => render(policy.slug)).join('\n');
    for (const word of denylist) expect(html.toLowerCase()).not.toContain(word.toLowerCase());
    expect(html).not.toMatch(/\baudited\b|\btrustless\b|automated burns?|\bownerless\b|guaranteed?|win rate|rug-proof|\bsafe\b|protects your Robinhood account/i);
    // Owner decision 2026-10-05: no token burns, buybacks, milestone buys or bounty, and no fee destination promise.
    expect(html).not.toMatch(/burn|buyback|milestone|timelock|bounty|payout/i);
  });
});
