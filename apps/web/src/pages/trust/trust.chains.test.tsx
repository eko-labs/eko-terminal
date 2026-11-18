import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReceiptLookupSchema, type ChainKey } from '@eko/shared';
import { ROBINHOOD_NON_AFFILIATION } from '../../copy/legal';
import { ELYSIUM_SITE, NOT_PUBLISHED, OFFICIAL_BY_CHAIN, PROJECT_LINKS, SECURITY_BY_CHAIN, TRANSPARENCY_BY_CHAIN } from '../../copy/trust';
import current from '../../../../../packages/shared/test/fixtures/receipts/guard-v2.json';

/** The trust pages as a build for `chain` renders them: VITE_EKO_CHAIN is read when lib/chain.ts loads. */
async function build(chain: ChainKey) {
  vi.stubEnv('VITE_EKO_CHAIN', chain);
  vi.resetModules();
  const [launch, receipt] = await Promise.all([import('./Launch'), import('./Receipt')]);
  return { pages: [launch.Official, launch.Transparency, launch.Security].map(Page => renderToStaticMarkup(<Page />)), receipt };
}
afterEach(() => { vi.unstubAllEnvs(); });

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const ELYSIUM_ONLY = /Montra|\bHYPE\b|Kinetiq|Hyperliquid/;
const item = current.items[0]!;
const anchored = ReceiptLookupSchema.parse({ id: item.id, kind: item.kind, hash: item.hash, leaf: item.leaf, canonicalization: 'jcs-rfc8785/v1', status: 'anchored',
  merkleRoot: current.root, proof: current.proofs[0], batchId: 1, block: 100, blockHash: `0x${'12'.repeat(32)}`, txHash: `0x${'34'.repeat(32)}`,
  registry: `0x${'ab'.repeat(20)}`, chainId: 4663, logIndex: 1 });

describe('trust pages per chain', () => {
  it('keeps the Elysium host in one constant, linked from no page while Elysium is shelved', () => {
    expect(ELYSIUM_SITE).toBe('https://elysium.ekoterminal.com');
    expect(PROJECT_LINKS.elysiumSite).toBe(ELYSIUM_SITE);
    expect(OFFICIAL_BY_CHAIN.robinhood.verified.map(link => link.href)).not.toContain(ELYSIUM_SITE);
    expect(OFFICIAL_BY_CHAIN.elysium.verified.map(link => link.href)).not.toContain(ELYSIUM_SITE);
    // Repository links are the same public repo on both chains.
    for (const chain of ['elysium', 'robinhood'] as const) expect(OFFICIAL_BY_CHAIN[chain].verified.find(link => link.label === 'Source code')?.href).toBe('https://github.com/eko-labs/eko-terminal');
  });

  it('renders the Robinhood pages with the Robinhood Markets non-affiliation line and none of Elysium’s names or dropped features', async () => {
    const { pages: [official, transparency, security] } = await build('robinhood');
    for (const html of [official!, transparency!, security!]) {
      const plain = text(html);
      expect(plain).toContain(ROBINHOOD_NON_AFFILIATION);
      expect(plain).toContain('Built on Robinhood Chain');
      expect(plain).not.toMatch(ELYSIUM_ONLY);
      expect(plain).not.toMatch(/receipts? registry|registry (owner|committer)|receipts verifier|\bburn|\bpoints\b|AI-generated/i);
      expect(html).not.toMatch(/0x[0-9a-fA-F]{6,}|\{\{|TODO|<button/);
    }
    // Four unpublished rows plus the section heading; one wallet on transparency.
    expect((official!.match(new RegExp(NOT_PUBLISHED, 'g')) ?? []).length).toBe(5);
    expect(text(official!)).toContain('Robinhood Chain address.');
    expect(official).not.toContain(ELYSIUM_SITE);
    expect((text(transparency!).match(new RegExp(NOT_PUBLISHED, 'g')) ?? []).length).toBe(1);
    for (const line of ['EKO charges no fee on trades right now. Network gas, Pons’s own fees and a coin’s own taxes still apply.', 'Blockscout explorer',
      'EKO has no contract of its own on Robinhood Chain.', 'If a token is planned, it will be announced here first.']) expect(text(transparency!)).toContain(line);
    for (const line of ['Pons, Uniswap, Robinhood Chain itself', 'a bypass that lets a honeypot fill is Critical', 'There is no bug bounty']) expect(text(security!)).toContain(line);
  });

  it('renders the Elysium pages unchanged', async () => {
    const { pages: [official, transparency, security] } = await build('elysium');
    expect((official!.match(new RegExp(NOT_PUBLISHED, 'g')) ?? []).length).toBe(7);
    expect(official).not.toContain(ELYSIUM_SITE);
    expect(text(transparency!)).toContain('EKO charges no fee on trades right now. Network gas and Montra’s own fees still apply.');
    for (const line of ['receipts registry contract on Elysium', 'Montra, Uniswap']) expect(text(security!)).toContain(line);
    for (const html of [official!, transparency!, security!]) {
      expect(text(html)).toContain('Not affiliated with, endorsed by, or officially connected with Kinetiq or Hyperliquid.');
      expect(text(html)).not.toMatch(/Robinhood|\bPons\b/);
    }
  });

  it('links a receipt’s transaction to the build’s own explorer', async () => {
    for (const [chain, explorer] of [['elysium', 'https://elysium.kinetiq.xyz/explorer'], ['robinhood', 'https://robinhoodchain.blockscout.com']] as const) {
      const { receipt } = await build(chain);
      const html = renderToStaticMarkup(<receipt.ReceiptContents receipt={anchored} result={null} registryAvailable onVerify={() => {}} />);
      expect(html, chain).toContain(`href="${explorer}/tx/${anchored.status === 'anchored' ? anchored.txHash : ''}"`);
    }
  });

  it('keeps every chain’s copy free of the other chain’s launchpad', () => {
    const all = (chain: ChainKey) => JSON.stringify([OFFICIAL_BY_CHAIN[chain], TRANSPARENCY_BY_CHAIN[chain], SECURITY_BY_CHAIN[chain]]);
    expect(all('robinhood')).not.toMatch(ELYSIUM_ONLY);
    expect(all('elysium')).not.toMatch(/Robinhood|\bPons\b/);
  });
});
