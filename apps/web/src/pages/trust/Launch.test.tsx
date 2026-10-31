import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../../routes';
import { BUILT_ON, DYOR, NON_AFFILIATION } from '../../copy';
import { NO_TOKEN, NOT_PUBLISHED, PENDING_OWNER, PROJECT_LINKS } from '../../copy/trust';
import { LegalLine } from '../../components/shell/Shell';
import { Official, Security, Transparency } from './Launch';

const PAGES = [['/official', Official], ['/transparency', Transparency], ['/security', Security]] as const;
// Every outbound link must be one of the verified project links; nothing else may look official.
const VERIFIED = new Set([PROJECT_LINKS.site, PROJECT_LINKS.repo, PROJECT_LINKS.advisory, PROJECT_LINKS.findings, PROJECT_LINKS.securityPolicy, `mailto:${PROJECT_LINKS.mailbox}`]);
const outbound = (html: string) => [...html.matchAll(/href="((?:https?:|mailto:)[^"]*)"/g)].map(m => m[1]!);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('public trust pages', () => {
  it.each(PAGES)('loads %s publicly at T without flags, with the no-token warning and required disclaimers', async (path, Page) => {
    const route = resolveRoute(path, {});
    expect(route?.route).toMatchObject({ stage: 'T', auth: 'public', workspace: 'trust' });
    expect((await route!.route.load()).default).toBe(Page);
    const html = renderToStaticMarkup(<Page />);
    expect(NO_TOKEN).toBe('We have no token yet; any token claiming to be EKO is fake.');
    for (const line of [BUILT_ON, NON_AFFILIATION, DYOR, NO_TOKEN]) expect(text(html)).toContain(line);
    expect(html).toContain(`<a aria-current="page" href="${path}">`);
  });

  it.each(PAGES)('%s shows no look-alike placeholders, addresses or unverified outbound links', (_path, Page) => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).not.toMatch(/0x[0-9a-fA-F]{6,}|\{\{|TODO|<button/);
    for (const href of outbound(html)) expect(VERIFIED, href).toContain(href);
    for (const anchor of html.match(/<a [^>]*href="https:[^"]*"[^>]*>/g) ?? []) expect(anchor).toContain('rel="noopener noreferrer"');
    expect(html).not.toMatch(/\baudited\b|\btrustless\b|automated burns?|\bownerless\b|guaranteed?|win rate|rug-proof|\bsafe\b|protects your Robinhood account/i);
  });

  it('official links list only verified channels and mark every unpublished identifier', () => {
    const html = renderToStaticMarkup(<Official />);
    for (const href of [PROJECT_LINKS.repo, PROJECT_LINKS.advisory, `mailto:${PROJECT_LINKS.mailbox}`, PROJECT_LINKS.securityTxt]) expect(html).toContain(`href="${href}"`);
    expect((html.match(new RegExp(NOT_PUBLISHED, 'g')) ?? []).length).toBe(7); // six rows plus the section heading
    for (const item of ['EKO token contract', 'Receipts registry contract', 'Dev fee wallet', 'X, Telegram and Farcaster accounts']) expect(html).toContain(item);
    // Owner decision 2026-10-05: no burn wallet and no milestone timelock.
    expect(html).not.toMatch(/burn|milestone|timelock/i);
    expect(text(html)).toContain('There is no EKO token yet.');
    expect(text(html)).toContain('treat it as unofficial');
  });

  it('transparency explains wallet roles without addresses and keeps review, fees and token day staged', () => {
    const html = text(renderToStaticMarkup(<Transparency />));
    expect((html.match(new RegExp(NOT_PUBLISHED, 'g')) ?? []).length).toBe(4);
    for (const line of ['AI-assisted and automated review, not a professional audit.', 'October 13, 2026, 13:00 UTC', 'October 16, 2026, 13:00 UTC',
      'the full 72 hours start again', 'three open (two Low, one Info), none High or Critical', 'Terminal fee: 0% during launch week',
      'any terminal fee will be published before it starts', 'no terminal fee at launch',
      'It holds no funds.', 'only if every public gate passes', 'If a gate fails, the token waits.',
      'On-chain guardrails stay advisory']) expect(html).toContain(line);
    // Owner decision 2026-10-05: no burns, buybacks, milestone buys or bounty; fees name no destination.
    expect(html).not.toMatch(/burn|buyback|milestone|timelock|bounty|payout/i);
    expect(html).toContain('Read the findings log');
  });

  it('security page opens private reporting now, with no bug bounty and the good-faith promise pending owner confirmation', () => {
    const html = renderToStaticMarkup(<Security />), plain = text(html);
    expect(html).toContain(`href="mailto:${PROJECT_LINKS.mailbox}"`);
    expect(html).toContain(`href="${PROJECT_LINKS.advisory}"`);
    expect(plain).toContain(`Good-faith research · ${PENDING_OWNER}`);
    for (const line of ['Reporting is open', 'There is no bug bounty, and EKO does not pay for reports.', 'October 13, 2026, at 13:00 UTC',
      'receipts registry contract on Elysium', 'github.com/EkoTerminal/eko',
      'a bypass that lets a honeypot fill is Critical', 'Never post a vulnerability in a public issue', 'within 48 hours',
      'Pons, Uniswap', 'Denial of service']) expect(plain).toContain(line);
    // Owner decision 2026-10-05: no rewards, payment, funding or payout terms.
    expect(plain.replace('There is no bug bounty', '')).not.toMatch(/bounty|reward|payout|paid|\$\d|USDC|creator fees|burn|<table/i);
    expect(html).not.toContain('<table');
  });

  it('agrees with the security.txt the API serves', () => {
    const source = readFileSync(new URL('../../../../server/src/http/security-txt.ts', import.meta.url), 'utf8');
    expect(source).toContain(`'${PROJECT_LINKS.mailbox}'`);
    expect(source).toContain(`'${PROJECT_LINKS.advisory}'`);
    expect(source).toContain(`'${PROJECT_LINKS.site}'`);
    expect(source).toContain('/security`');
    expect(resolveRoute('/security', {})?.route.load).toBeDefined();
  });

  it('links all three pages from the shared desktop/mobile legal footer', () => {
    const html = renderToStaticMarkup(<LegalLine />);
    for (const path of ['/official', '/transparency', '/security']) expect(html).toContain(`href="${path}"`);
  });
});
