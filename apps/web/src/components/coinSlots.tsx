import { createContext, Suspense, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Flags } from '@eko/shared';
import { FEATURES, type CoinDetailTab, type CoinSlots } from '../features';
import { useShell } from '../store/shell';
import type { ChartCore } from './chart/chartCore';

/**
 * Places on the coin page that post-launch features (features.ts) can fill: the glance row at the top, over the price
 * chart, in the chart's key row, the tool row under the chart, sections in the detail tabs, next to a wallet in the
 * Flow and Trades tabs, and a page's list of key facts. A slot shows only while its feature's flag is on; with none
 * on, these render nothing and the page is unchanged. Slots may be lazy components: each place waits for them quietly.
 */
const CoinAddress = createContext<string | null>(null);

/** The coin the slots below belong to (the coin page wraps its content in this). */
export function CoinSlotScope({ coin, children }: { coin: string; children: ReactNode }) {
  return <CoinAddress.Provider value={coin}>{children}</CoinAddress.Provider>;
}

/** The coin slots of the features whose flag is on. */
export function activeCoinSlots(features: readonly ({ flag: keyof Flags } & { coin?: CoinSlots })[], flags: Partial<Flags> | undefined): CoinSlots[] {
  return features.flatMap(f => f.coin && flags?.[f.flag] ? [f.coin] : []);
}
export function useCoinSlots(): CoinSlots[] {
  const flags = useShell(s => s.config?.flags);
  return useMemo(() => activeCoinSlots(FEATURES, flags), [flags]);
}

/** Drawn over the price chart's plot, in the chart core's coordinates. */
export function ChartOverlaySlots({ core }: { core: ChartCore }) {
  const coin = useContext(CoinAddress), slots = useCoinSlots().filter(s => s.chartOverlay);
  if (!coin || !slots.length) return null;
  return <Suspense fallback={null}>{slots.map((s, i) => { const Overlay = s.chartOverlay!; return <Overlay key={i} coin={coin} core={core} />; })}</Suspense>;
}
/** Under the chart, beside its own key row. */
export function ChartKeySlots() {
  const coin = useContext(CoinAddress), slots = useCoinSlots().filter(s => s.chartKey);
  if (!coin || !slots.length) return null;
  return <Suspense fallback={null}>{slots.map((s, i) => { const Key = s.chartKey!; return <Key key={i} coin={coin} />; })}</Suspense>;
}
/** After a wallet address in the coin page's tables. */
export function WalletSlots({ wallet }: { wallet: string }) {
  const coin = useContext(CoinAddress), slots = useCoinSlots().filter(s => s.wallet);
  if (!coin || !slots.length) return null;
  return <Suspense fallback={null}>{slots.map((s, i) => { const Badge = s.wallet!; return <Badge key={i} coin={coin} wallet={wallet} />; })}</Suspense>;
}

/** The coin page's detail tabs, so a glance tile can open one at a section. */
export interface CoinDetailNav { open(tab: CoinDetailTab, section?: string): void }
const CoinDetail = createContext<CoinDetailNav | null>(null);
export const CoinDetailScope = CoinDetail.Provider;
export function useCoinDetail() { return useContext(CoinDetail); }
/** The DOM id of a feature section, for scrolling to it. */
export const sectionAnchor = (id: string) => `coin-section-${id}`;

/**
 * The glance band: the page's own tiles and the features' tiles, by order. The verdict (order 0) reads large in the
 * left column; the rest (EKO Quant's odds first) are stats in one row beside it. `tone` is the
 * verdict's, so the headline carries it.
 */
export function GlanceRow({ own, tone = 'neutral' }: { own: { order: number; node: ReactNode }[]; tone?: string }) {
  const coin = useContext(CoinAddress), slots = useCoinSlots().filter(s => s.glance);
  const tiles = [...own.map(t => ({ ...t, key: `own-${t.order}` })),
    ...(coin ? slots.map((s, i) => { const Tile = s.glance!.component; return { order: s.glance!.order, key: `f-${i}`, node: <Suspense fallback={null}><Tile coin={coin} /></Suspense> }; }) : [])]
    .sort((a, b) => a.order - b.order);
  // The verdict (order 0) has the left column to itself; every other tile is a stat in one row beside it.
  const head = tiles.filter(t => t.order < 5), rest = tiles.filter(t => t.order >= 5);
  return <section className={`glance-band glance-band-${tone}`} aria-label="At a glance">
    <div className="glance-head">{head.map(t => <div className="glance-cell" key={t.key}>{t.node}</div>)}</div>
    <div className="glance-row" role="list">{rest.map(t => <div role="listitem" className="glance-cell" key={t.key}>{t.node}</div>)}</div>
  </section>;
}

/** The tool row under the chart: one button per tool, one panel open at a time. */
export function ToolRow() {
  const coin = useContext(CoinAddress), tools = useCoinSlots().flatMap(s => s.tool ? [s.tool] : []).sort((a, b) => a.order - b.order);
  const [open, setOpen] = useState<string | null>(null);
  if (!coin || !tools.length) return null;
  const active = tools.find(t => t.label === open);
  const Panel = active?.panel;
  return <div className="coin-tools">
    <div className="coin-tools-row" role="toolbar" aria-label="Coin tools">{tools.map(t =>
      <button key={t.label} type="button" className={`btn btn-sm${open === t.label ? ' on' : ''}`} aria-expanded={open === t.label} onClick={() => setOpen(open === t.label ? null : t.label)}>{t.label}</button>)}</div>
    {Panel && <div className="coin-tool-panel"><Suspense fallback={null}><Panel coin={coin} close={() => setOpen(null)} /></Suspense></div>}
  </div>;
}

/** The features' sections for one detail tab, by order. */
export function useTabSections(tab: CoinDetailTab) {
  return useCoinSlots().flatMap(s => s.section && s.section.tab === tab ? [s.section] : []).sort((a, b) => a.order - b.order);
}
/** A tab's sections; `part` keeps those above the tab's own content (`lead`, order below 0) or after it (`rest`). */
export function TabSections({ tab, part }: { tab: CoinDetailTab; part?: 'lead' | 'rest' }) {
  const coin = useContext(CoinAddress), sections = useTabSections(tab).filter(s => part === undefined || (part === 'lead') === (s.order < 0));
  if (!coin || !sections.length) return null;
  return <>{sections.map(sec => { const Body = sec.component; return <section key={sec.id} id={sectionAnchor(sec.id)} tabIndex={-1} className="coin-section" aria-labelledby={`${sectionAnchor(sec.id)}-h`}>
    <h3 id={`${sectionAnchor(sec.id)}-h`} className="coin-section-title">{sec.title}</h3>
    <Suspense fallback={null}><Body coin={coin} /></Suspense></section>; })}</>;
}

/** The features' key facts, by order, as list items for a page's list of facts (components/KeyFact.tsx). */
export function useFactSlots() {
  return useCoinSlots().flatMap(s => s.fact ? [s.fact] : []).sort((a, b) => a.order - b.order);
}
export function FactSlots() {
  const coin = useContext(CoinAddress), facts = useFactSlots();
  if (!coin || !facts.length) return null;
  return <Suspense fallback={null}>{facts.map((f, i) => { const Fact = f.component; return <Fact key={i} coin={coin} />; })}</Suspense>;
}
