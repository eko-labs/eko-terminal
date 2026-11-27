import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { z } from 'zod';
import { RadarResponseSchema, RadarRowSchema } from '@eko/shared';
import { activeCoinSlots } from '../../components/coinSlots';
import { activePlaceSlots, sortByPlace } from '../../components/placeSlots';
import { featuresFrom } from '../../features';
import { createApi } from '../../lib/api';
import { createMockTransport } from '../../mocks/transport';
import { createRadarCard, createRadarRows } from '../../mocks/demo/radar';
import feature from './index';
import { DumpCell, DumpFactView, DumpTile, DumpView } from './DumpTest';
import { dumpFor, summaryFor } from './demo';
import { changeText, DumpSchema, dumpPath, fallOf, keepLine, NOT_MEASURED, sentence, shareText, summaryOf, tokensText, toneOf, type Dump, type Figure, type Measured } from './model';

const COIN = '0x5d2c41f39a0b77e8c6a1f3d920e4b18a6f7c0e35';
const FORBIDDEN = /guarantee|win rate|rug-proof|\bsafe\b|audited|will (pump|moon|go up)|mock|demo|fake|fixture|sample|test data|placeholder/i;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const fig = (id: Figure['id'], sharePct: number, changePct: number | null, usd100: number | null, wallets = 1): Figure =>
  ({ id, wallets, tokens: (BigInt(Math.round(sharePct * 1e7)) * 10n ** 18n).toString(), sharePct, changePct, usd100 });
const reply = (over: Partial<Measured> = {}): Measured => DumpSchema.parse({
  version: 1, coin: COIN, at: '2026-11-26T12:00:00.000Z', asOfBlock: 9_000_000, measured: true, venue: 'curve', sellFeePct: 1, funding: true,
  groups: [fig('dev', 5, -12.1, 76.4), fig('linked', 3.2, -8.4, 82.9, 2), fig('bundle', 16, -41.3, 51.1, 7), fig('sniper', 9.5, -30.2, 60.3, 4), fig('early', 1.1, -3.4, 92.7, 5)],
  all: fig('all', 34.8, -83.2, 16.6, 19), ...over }) as Measured;

describe('dump test words', () => {
  it('colours by how far: coral from 60%, Monitor ice from 25%, good under it', () => {
    expect([toneOf(-83), toneOf(-60), toneOf(-59.9), toneOf(-25), toneOf(-24.9), toneOf(0)]).toEqual(['bad', 'bad', 'watch', 'watch', 'good', 'good']);
    expect([changeText(-83.2), changeText(-0.42), changeText(0)]).toEqual(['−83%', '−0.4%', '0%']);
    expect([keepLine(16.6), keepLine(0.3), keepLine(0)]).toEqual(['$100 → $17', '$100 → <$1', '$100 → $0']);
    expect([shareText(34.8), shareText(4.12), shareText(0.04)]).toEqual(['35%', '4.1%', '<0.1%']);
    expect([tokensText((50_000_000n * 10n ** 18n).toString()), tokensText((1_234_000_000n * 10n ** 18n).toString()), tokensText('0')]).toEqual(['50M', '1.2B', '0']);
    expect(fallOf(-12.5)).toBe(12.5); expect(dumpPath(COIN)).toBe(`/v2/coins/${COIN}/dump`);
  });
  it('says what it means in one plain sentence, an estimate', () => {
    expect(sentence(reply())).toBe('EKO estimates that if insiders sold everything they hold (35% of supply) at once, the price would fall about 83% and $100 held now would be worth about $17. The biggest part is with bundle wallets (16%).');
    expect(sentence(reply({ all: { ...fig('all', 40, -91, 0, 20), drains: true } }))).toContain('take all the ETH in the curve');
    expect(sentence(reply({ groups: [], all: fig('all', 0, 0, 98, 0) }))).toBe('EKO finds no insider still holding this coin, so there is nothing left for them to dump.');
  });
  it('reads the Radar row\'s figure only in its own shape', () => {
    const row = createRadarRows()[0]!;
    expect(summaryOf(row)).toBeNull();
    expect(summaryOf({ extras: { dump_test: { changePct: -40, usd100: 58, sharePct: 12 } } })).toEqual({ changePct: -40, usd100: 58, sharePct: 12 });
    expect(summaryOf({ extras: { dump_test: { changePct: 40 } } })).toBeNull();
  });
});

describe('dump test on the coin page and in the lists', () => {
  const features = featuresFrom({ './features/dump_test/index.ts': { default: feature } });
  it('fills its places only while its flag is on: first stat after the verdict, top of Overview, a key fact, a list figure', () => {
    expect(activeCoinSlots(features, {})).toEqual([]);
    expect(activePlaceSlots(features, {})).toEqual([]);
    const [slots] = activeCoinSlots(features, { dump_test: true });
    expect(slots?.glance?.order).toBe(5);
    expect(slots?.section).toMatchObject({ tab: 'Overview', id: 'dump-test', title: 'If insiders dump' });
    expect(slots!.section!.order).toBeLessThan(0);
    expect(slots?.fact?.order).toBe(0);
    const [places] = activePlaceSlots(features, { dump_test: true });
    expect(places?.coinRow).toMatchObject({ id: 'dump', label: 'Dump' });
    expect(places!.coinRow!.value({ extras: { dump_test: { changePct: -61.5, usd100: 37, sharePct: 20 } } } as never)).toBe(61.5);
    expect(places!.coinRow!.value({} as never)).toBeUndefined();
  });
  it('shows the tile, the fact and the cell in one line: −83%, $100 → $17, in the danger tone', () => {
    const tile = render(<DumpTile reply={reply()} />);
    expect(text(tile)).toContain('−83%'); expect(text(tile)).toContain('If insiders dump'); expect(text(tile)).toContain('$100 → $17');
    expect(tile).toContain('glance-bad'); expect(tile).toContain('dt-bad');
    expect(text(render(<ul><DumpFactView reply={reply()} /></ul>))).toContain('If insiders dump −83% $100 → $17');
    expect(render(<DumpTile reply={{ version: 1, coin: COIN, at: '2026-11-26T12:00:00.000Z', asOfBlock: 1, measured: false, reason: 'partial_history' }} />)).toBe('');
    const cell = render(<DumpCell row={{ extras: { dump_test: { changePct: -41.2, usd100: 57.6, sharePct: 15 } } } as never} />);
    expect(cell).toContain('dt-watch'); expect(text(cell).trim()).toBe('−41%');
    expect(text(render(<DumpCell row={{} as never} />)).trim()).toBe('—');
  });
  it('breaks the figure down by group, each a pixel bar with what it holds', () => {
    const html = render(<DumpView reply={reply()} />), t = text(html);
    for (const w of ['Dev', 'Dev-funded', 'Bundles', 'Snipers', 'Early buyers', 'All insiders']) expect(t).toContain(w);
    expect(t).toContain('−41%'); expect(t).toContain('160M · 16% of supply · 7 wallets');
    expect(t).toContain('Your $100 → $17 if all insiders sold first, after the 1% sell fee');
    expect(t).toContain('An estimate, not a forecast.');
    expect((html.match(/class="on"/g) ?? []).length).toBeGreaterThan(0);
    expect(t).not.toMatch(FORBIDDEN);
    const none: Dump = { version: 1, coin: COIN, at: '2026-11-26T12:00:00.000Z', asOfBlock: 1, measured: false, reason: 'partial_history' };
    expect(text(render(<DumpView reply={none} />))).toContain(NOT_MEASURED.partial_history);
  });
  it('sorts a list by the figure, highest first, rows without one last', () => {
    const rows = [{ a: 'x', v: 10 }, { a: 'y', v: undefined }, { a: 'z', v: 80 }, { a: 'w', v: 10 }];
    expect(sortByPlace(rows, r => r.v).map(r => r.a)).toEqual(['z', 'x', 'w', 'y']);
  });
});

describe('dump test in mock mode', () => {
  const rows = createRadarRows();
  it('gives every radar coin a figure that agrees with its verdict and its card', () => {
    for (const row of rows) {
      const d = dumpFor(row.address), card = createRadarCard(row.address)!;
      expect(DumpSchema.safeParse(d).success).toBe(true);
      if (!d?.measured) throw new Error(row.address);
      const f = fallOf(d.all.changePct!);
      if (row.verdict === 'danger') expect(f).toBeGreaterThanOrEqual(60); else if (row.verdict === 'clear') expect(f).toBeLessThan(25); else expect(f).toBeGreaterThanOrEqual(25);
      if (row.verdict === 'monitor') expect(f).toBeLessThan(60);
      expect(d.groups.find(g => g.id === 'dev')!.sharePct).toBeCloseTo(card.supply.devPct ?? 0, 2);
      // A group selling alone never moves the price more than all insiders at once.
      for (const g of d.groups) expect(fallOf(g.changePct!)).toBeLessThanOrEqual(f);
      expect(d.all.sharePct).toBeCloseTo(d.groups.reduce((n, g) => n + g.sharePct, 0), 1);
      expect(text(render(<DumpView reply={d} />))).not.toMatch(FORBIDDEN);
    }
  });
  it('serves the route and adds the figure to the radar rows through the mock transport, only while the flag is on', async () => {
    const on = createApi('/v1', createMockTransport({ flags: { dump_test: true } })), off = createApi('/v1', createMockTransport({ flags: {} }));
    const coin = rows[0]!.address;
    expect((await on.parse(dumpPath(coin), DumpSchema)).measured).toBe(true);
    const list = await on.parse('/radar', RadarResponseSchema);
    expect(list.rows.every(r => RadarRowSchema.parse(r).extras?.dump_test)).toBe(true);
    expect(summaryOf(list.rows[0]!)).toEqual(summaryFor(list.rows[0]!));
    const plain = await off.parse('/radar', z.object({ rows: z.array(RadarRowSchema) }));
    expect(plain.rows.some(r => r.extras)).toBe(false);
  });
});
