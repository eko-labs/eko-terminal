import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainKey } from '@eko/shared';
import { POLICIES_BY_CHAIN, ROBINHOOD_NON_AFFILIATION, type PolicyDraft } from '../copy/legal';
import { SETTINGS_COPY } from '../copy/settings';

/** The Legal page and its copy as a build for `chain` sees them: VITE_EKO_CHAIN is read when lib/chain.ts loads. */
async function build(chain: ChainKey) {
  vi.stubEnv('VITE_EKO_CHAIN', chain);
  vi.resetModules();
  const [{ default: Legal }, legal] = await Promise.all([import('./Legal'), import('../copy/legal')]);
  return { legal, render: (slug: string) => renderToStaticMarkup(<Legal params={{ doc: slug }} />) };
}
afterEach(() => { vi.unstubAllEnvs(); });

const text = (policy: PolicyDraft) => policy.sections.flatMap((section) => [section.title, ...section.paragraphs]).join('\n');
const ROBINHOOD = POLICIES_BY_CHAIN.robinhood, ELYSIUM = POLICIES_BY_CHAIN.elysium;
// Names that belong to the Elysium build only, and claims the light build does not make on either chain.
const ELYSIUM_ONLY = /Montra|\bHYPE\b|Kinetiq|Hyperliquid|Elysium|HyperCore/i;
/** The one place a Robinhood policy names Hyperliquid: the ETH price source in Privacy, which is a fact of the service. */
const ETH_PRICE_LINE = 'ETH price: EKO reads the ETH price from Hyperliquid’s public market-data API and checks it against a pool on Robinhood Chain. No user data is sent.';
const withoutPriceLine = (s: string) => s.split(ETH_PRICE_LINE).join('');
const DROPPED = /OFAC|token day|AI-generated|receipts? registry|\bburn|\bpoints\b|Telegram for alerts|Farcaster bot|encrypted|brokerage/i;

describe('launch policies per chain', () => {
  it('keeps one structure on both chains: the same policies, titles, order and sections', () => {
    const shape = (chain: ChainKey) => POLICIES_BY_CHAIN[chain].drafts.map((p) => [p.slug, p.title, p.sections.map((s) => s.title)]);
    expect(shape('robinhood')).toEqual(shape('elysium'));
    expect(ROBINHOOD.drafts.map((p) => p.slug)).toEqual(['terms', 'privacy', 'risk', 'ai', 'team-trading', 'kol', 'sanctions']);
  });

  it('records the owner’s approval of the Robinhood Terms and Privacy (2026-11-17); the other five stay dated drafts', () => {
    expect(ROBINHOOD.approval).toEqual({ slugs: ['terms', 'privacy'], version: '2026-11-17', approvedAt: '2026-11-17', evidenceRef: 'docs/public-launch/OWNER-DECISIONS.md' });
    expect(ROBINHOOD.review).toMatchObject({ draftedAt: '2026-11-17', effectiveAt: null, ownerApproval: { dueAt: null, approvedAt: null, evidenceRef: null } });
    expect(ROBINHOOD.review.version).toMatch(/^2026-11-17-draft\.\d+$/);
    // Elysium's approval does not carry over.
    expect(ELYSIUM.approval.approvedAt).toBe('2026-11-16');
  });

  it('writes the Robinhood policies for Robinhood Chain, Pons and ETH, with none of Elysium’s names', () => {
    for (const policy of ROBINHOOD.drafts) {
      expect(withoutPriceLine(text(policy)), policy.slug).not.toMatch(ELYSIUM_ONLY);
      expect(text(policy), policy.slug).not.toMatch(DROPPED);
    }
    const terms = text(ROBINHOOD.drafts[0]!), privacy = text(ROBINHOOD.drafts[1]!), risk = text(ROBINHOOD.drafts[2]!);
    expect(ROBINHOOD_NON_AFFILIATION).toBe('Not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.');
    expect(terms).toContain(ROBINHOOD_NON_AFFILIATION);
    expect(ROBINHOOD.disclosures).toEqual({ builtOn: 'Built on Robinhood Chain', nonAffiliation: ROBINHOOD_NON_AFFILIATION, dyor: ELYSIUM.disclosures.dyor });
    for (const fact of ['coins launched on Pons, on Robinhood Chain', 'Pons bonding curve', 'Uniswap’s public contracts on Robinhood Chain', 'ETH price feed',
      'EKO charges no fee on trades right now', 'Each trade has a size limit, shown in the app', 'EKO refuses to prepare a buy of it', 'These checks are advisory: an agent can ignore them']) expect(terms).toContain(fact);
    for (const provider of ['Railway', 'Blockscout', 'RPC provider', 'ETH price']) expect(privacy).toContain(provider);
    expect(privacy).toContain('Sessions last 30 days');
    expect(privacy).toContain(`${SETTINGS_COPY.privacy}, “${SETTINGS_COPY.deleteTitle}”`);
    expect(privacy).toContain('Your trades themselves are public transactions on Robinhood Chain');
    expect(risk).toContain('Pons coins are new and thinly traded');
    expect(text(ROBINHOOD.drafts[5]!)).toContain('whenever Robinhood is named');
  });

  it('shares the chain-neutral sections and policies word for word', () => {
    const neutral = new Set(['Connected agents', 'Fair use', 'What can go wrong', 'Changes', 'What EKO stores when you sign in', 'What EKO does not collect',
      'How long EKO keeps data', 'Changes and contact', 'Agents', 'The service']);
    let shared = 0;
    for (const [i, policy] of ELYSIUM.drafts.entries()) {
      if (['ai', 'team-trading', 'sanctions'].includes(policy.slug)) { expect(ROBINHOOD.drafts[i]).toEqual(policy); continue; }
      for (const [j, section] of policy.sections.entries()) if (neutral.has(section.title)) { shared++; expect(ROBINHOOD.drafts[i]!.sections[j], `${policy.slug}/${section.title}`).toEqual(section); }
    }
    expect(shared).toBe(neutral.size);
  });

  it('keeps retired brands and forbidden claims out of both chains’ policies', () => {
    const denylist = readFileSync(new URL('../../../../infra/brand-denylist.txt', import.meta.url), 'utf8').trim().split(/\r?\n/);
    for (const chain of ['elysium', 'robinhood'] as const) {
      const all = POLICIES_BY_CHAIN[chain].drafts.map(text).join('\n');
      for (const word of denylist) expect(all.toLowerCase(), `${chain}: ${word}`).not.toContain(word.toLowerCase());
      expect(all).not.toMatch(/\baudited\b|\btrustless\b|automated burns?|\bownerless\b|guaranteed?|win rate|rug-proof|\bsafe\b|protects your Robinhood account/i);
      expect(all).not.toMatch(/burn|buyback|milestone|timelock|bounty|payout/i);
    }
  });

  it('renders the Robinhood Terms and Privacy as approved, and the other five as drafts, with the Robinhood footer', async () => {
    const { legal, render } = await build('robinhood');
    expect(legal.POLICY_DRAFTS).toEqual(ROBINHOOD.drafts);
    for (const slug of ['terms', 'privacy']) {
      const html = render(slug);
      expect(legal.isApprovedPolicy(slug), slug).toBe(true);
      expect(html).toContain(`<h2>${legal.LEGAL_COPY.approved}</h2>`);
      expect(html).toContain('<time dateTime="2026-11-17">2026-11-17</time>');
      expect(html).not.toMatch(/draft|pending/i);
      expect(html).toContain(ROBINHOOD_NON_AFFILIATION);
      expect(withoutPriceLine(html)).not.toMatch(ELYSIUM_ONLY);
    }
    expect(render('privacy')).toContain(ETH_PRICE_LINE);
    for (const policy of ROBINHOOD.drafts.filter((p) => !['terms', 'privacy'].includes(p.slug))) {
      const html = render(policy.slug);
      expect(legal.isApprovedPolicy(policy.slug), policy.slug).toBe(false);
      expect(html).toContain(`<h2>${legal.LEGAL_COPY.draft}</h2>`);
      expect(html).toContain('Draft — pending owner approval');
      expect(html).toContain(`<dt>${legal.LEGAL_COPY.version}</dt><dd>${ROBINHOOD.review.version}</dd>`);
      expect(html).toContain(`<dt>${legal.LEGAL_COPY.approvalDate}</dt><dd>${legal.LEGAL_COPY.pending}</dd>`);
      expect(html).not.toContain(legal.LEGAL_COPY.approved);
      expect(html).toContain(ROBINHOOD_NON_AFFILIATION);
      expect(html).toContain('<p>Built on Robinhood Chain</p>');
      expect(html).not.toMatch(ELYSIUM_ONLY);
    }
    expect(render('unknown')).toContain(ROBINHOOD_NON_AFFILIATION);
  });

  it('renders the Elysium build’s pages exactly as approved', async () => {
    const { legal, render } = await build('elysium');
    expect(legal.POLICY_DRAFTS).toEqual(ELYSIUM.drafts);
    for (const slug of ['terms', 'privacy']) {
      const html = render(slug);
      expect(html).toContain(`<h2>${legal.LEGAL_COPY.approved}</h2>`);
      expect(html).toContain('<time dateTime="2026-11-16">2026-11-16</time>');
      expect(html).not.toMatch(/draft|pending|Robinhood|\bPons\b/i);
    }
    expect(render('kol')).toContain('Draft — pending owner approval');
    expect(render('terms')).toContain('Not affiliated with, endorsed by, or officially connected with Kinetiq or Hyperliquid.');
  });
});
