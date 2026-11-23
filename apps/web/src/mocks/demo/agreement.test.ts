import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRadarCard, createRadarRows } from './radar';
import { coinLedger } from './ledger';
import { demoPositions } from './positions';
import { demoWalletTags } from './walletTags';
import { holdersGlance } from '../../pages/terminal/CoinGlance';

/**
 * Every page about a coin in mock mode tells one story: the coin card's Supply panel and verdict, the positions and the
 * wallet tags all read the same per-coin ledger. Each feature checks its own demo against it in its own folder.
 */
const near = (a: number, b: number, d = 0.01) => Math.abs(a - b) <= d;
afterEach(() => vi.unstubAllEnvs());

function agrees(address: string) {
  const card = createRadarCard(address)!, ledger = coinLedger(address)!, book = demoPositions(address)!, sym = card.identity.symbol.text;
  const s = card.supply, share = (tokens: number) => tokens / book.supply * 100;
  // The ledger holds what the Supply panel says.
  expect(near(ledger.dev.heldPct, s.devPct), `${sym} dev held`).toBe(true);
  expect(near(ledger.bundlesHeldPct, s.bundlesHeldPct), `${sym} bundles held`).toBe(true);
  expect(near(ledger.top10Pct, s.top10Pct), `${sym} top 10`).toBe(true);
  expect(holdersGlance(card)!.value).toBe(`${Math.round(ledger.top10Pct)}%`);
  const devSold = ledger.dev.soldPct, devSells = ledger.dev.sells.length;

  // Positions (top traders, holders in profit): the deployer's sells and holding, the bundles' holding.
  const dev = book.wallets.find(w => w.roles.includes('dev'))!;
  expect(near(share(dev.balance), s.devPct, 1e-6), `${sym} positions dev held`).toBe(true);
  expect(near(share(dev.sold), devSold, 1e-6), `${sym} positions dev sold`).toBe(true);
  expect(dev.sells).toBe(devSells);
  expect(near(book.wallets.filter(w => w.roles.includes('bundle')).reduce((n, w) => n + share(w.balance), 0), s.bundlesHeldPct, 1e-6)).toBe(true);
  // Wallet tags: the top 10 holders, and a marker for each of the deployer's buys and sells.
  const tags = demoWalletTags(address)!, top = tags.wallets.filter(w => w.tags.includes('top10'));
  expect(new Set(top.map(w => w.wallet))).toEqual(new Set(ledger.top10.map(t => t.wallet)));
  expect(tags.markers.filter(m => m.wallet === ledger.deployer && m.side === 'sell')).toHaveLength(devSells);

  // The verdict: a dump reason only where the dev or insiders sold, and the Odds' traits from the same facts.
  const ids = card.verdict.playbooks.map(p => p.id);
  if (ids.includes('dev_dump') || ids.includes('migration_dump')) expect(devSells, `${sym} dump reason without dev sells`).toBeGreaterThan(0);
}

describe('every panel about a coin tells the same story', () => {
  it('agrees across features for every radar coin', () => {
    for (const row of createRadarRows()) agrees(row.address);
  });

  it('agrees for the long.xyz coins too', () => {
    vi.stubEnv('VITE_FLAGS', 'more_launchpads');
    const quoted = createRadarRows().slice(30);
    expect(quoted).toHaveLength(3);
    for (const row of quoted) agrees(row.address);
  });

  it('FROG: the dev sold 89% of its bag in two sells, as its verdict says', () => {
    const frog = createRadarRows().find(r => r.symbol.text === 'FROG')!, l = coinLedger(frog.address)!, card = createRadarCard(frog.address)!;
    expect(l.dev).toMatchObject({ boughtPct: expect.closeTo(3.6, 6), heldPct: expect.closeTo(0.4, 6), soldPct: expect.closeTo(3.2, 6) });
    expect(l.dev.sells).toHaveLength(2);
    // The verdict's reason: what the insiders (dev, bundles, snipers) sold of what they bought, and how soon.
    const insiders = l.wallets.filter(w => w.roles.length), bought = insiders.filter(w => w.via !== 'rotation').reduce((n, w) => n + w.boughtPct, 0);
    const sold = l.sells.reduce((n, x) => n + x.pct, 0), last = Math.max(...l.sells.map(x => x.sec));
    const reason = card.verdict.reasons.find(r => r.startsWith('Insiders sold'))!;
    expect(reason).toBe(`Insiders sold ${Math.round(sold / bought * 100)}% of what they bought within ${Math.ceil(last / 60)} minutes of launch`);
  });
});
