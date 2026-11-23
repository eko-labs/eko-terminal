import { describe, expect, it } from 'vitest';
import { createRadarCard, createRadarRows } from './radar';
import { demoPositions, demoProfit } from './positions';

describe('demo positions', () => {
  const rows = createRadarRows();

  it('agrees with each coin\'s price, supply and Supply panel', () => {
    for (const row of rows) {
      const book = demoPositions(row.address)!, card = createRadarCard(row.address)!;
      expect(book.priceUsd).toBe(row.priceUsd);
      expect(book.supply).toBeCloseTo(row.marketCapUsd! / row.priceUsd, 3);
      const share = (w: { balance: number }) => w.balance / book.supply * 100;
      const dev = book.wallets.find(w => w.roles.includes('dev'))!;
      expect(dev.wallet).toBe(card.identity.deployer);
      expect(share(dev)).toBeCloseTo(card.supply.devPct, 6);
      const bundles = book.wallets.filter(w => w.roles.includes('bundle')).reduce((s, w) => s + share(w), 0);
      expect(bundles).toBeCloseTo(card.supply.bundlesHeldPct, 6);
      const held = book.wallets.reduce((s, w) => s + share(w), 0);
      expect(held).toBeGreaterThan(40); expect(held).toBeLessThan(100);
      for (const w of book.wallets) {
        expect(w.wallet).toMatch(/^0x[0-9a-f]{40}$/i);
        expect(w.balance).toBeGreaterThanOrEqual(-1e-6);
        expect(w.costed).toBeLessThanOrEqual(w.balance + 1e-6);
      }
    }
  });

  it('books costs the edge\'s way: average cost, and tokens it was sent have none', () => {
    const book = demoPositions(rows[0]!.address)!;
    const onlySent = book.wallets.filter(w => w.buys === 0);
    expect(onlySent.length).toBeGreaterThanOrEqual(3);
    for (const w of onlySent) expect(w).toMatchObject({ spentUsd: 0, costed: 0, costBasisUsd: null, entryUsd: null });
    // A wallet that never sent or received tokens: profit is what it got back plus what it holds, less what it paid.
    const plain = book.wallets.find(w => w.buys > 0 && w.sells > 0 && w.balance > 0 && !w.transferredIn && !w.transferredOut)!;
    expect(demoProfit(plain, book.priceUsd)).toBeCloseTo(plain.receivedUsd + plain.balance * book.priceUsd - plain.spentUsd, 4);
    // Some made money and some lost it.
    const profits = book.wallets.filter(w => w.buys).map(w => demoProfit(w, book.priceUsd));
    expect(profits.some(p => p > 0)).toBe(true);
    expect(demoPositions(rows[0]!.address)).toBe(book);
  });
});
