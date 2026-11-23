import type { ReactNode } from 'react';
import { useCoinDetail } from './coinSlots';
import { MiniBars } from './ui/charts';
import type { CoinDetailTab } from '../features';

/**
 * A glance tile, read in two seconds, in the radar's stat style: the figure (monospace), a pixel gauge drawn by the
 * same painter as the radar's head stats (MiniBars), a short label under it, and one plain line. Optionally ten dots
 * for "N in 10" odds. Clicking a tile with a `target` opens that detail tab at its section.
 */
export type GlanceTone = 'good' | 'watch' | 'bad' | 'neutral';
export interface GlanceTileProps {
  label: string;
  value: ReactNode;
  line?: ReactNode;
  tone?: GlanceTone;
  /** A share (0-100) drawn as a pixel gauge under the figure. */
  gauge?: number;
  /** Ten dots with `filled` lit: "3 in 10". */
  dots?: number;
  target?: { tab: CoinDetailTab; section?: string };
  /** Shown while the tile's figures load: the label and a quiet placeholder, so the row does not jump. */
  loading?: boolean;
  title?: string;
}

const COLUMNS = 24;
/** A share as a row of the radar's pixel bars: a dim track with the share lit, warm for a bad reading. */
export function PixelGauge({ pct, tone = 'neutral', height = 16, columns = COLUMNS }: { pct: number; tone?: GlanceTone; height?: number; columns?: number }) {
  const lit = Math.max(pct > 0 ? 1 : 0, Math.round(columns * Math.min(100, Math.max(0, pct)) / 100));
  return <span className={`pgauge pgauge-${tone}`} style={{ height }} role="img" aria-label={`${Math.round(pct * 10) / 10}%`}>
    <span className="pgauge-track" aria-hidden="true"><MiniBars series={Array(columns).fill(1)} height={height} tone="dim" label="" /></span>
    <span className="pgauge-lit" aria-hidden="true"><MiniBars series={Array.from({ length: columns }, (_, i) => (i < lit ? 1 : 0))} height={height} tone={tone === 'bad' ? 'warm' : tone === 'neutral' ? 'dim' : undefined} label="" /></span>
  </span>;
}

export function Dots({ filled, tone = 'neutral', label }: { filled: number; tone?: GlanceTone; label?: string }) {
  const n = Math.max(0, Math.min(10, Math.round(filled)));
  return <span className={`dots dots-${tone}`} role="img" aria-label={label ?? `${n} in 10`}>
    {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < n ? 'on' : undefined} />)}
  </span>;
}

export function GlanceTile({ label, value, line, tone = 'neutral', gauge, dots, target, loading, title }: GlanceTileProps) {
  const detail = useCoinDetail();
  const body = <>
    <span className="glance-value num">{loading ? <span className="glance-wait" aria-label="Loading">—</span> : value}</span>
    {loading ? <PixelGauge pct={0} tone="neutral" /> : gauge !== undefined && <PixelGauge pct={gauge} tone={tone} />}
    {dots !== undefined && !loading && <Dots filled={dots} tone={tone} />}
    <span className="glance-label">{label}</span>
    {loading ? <span className="glance-line" aria-hidden="true">&nbsp;</span> : line && <span className="glance-line">{line}</span>}
  </>;
  const cls = `glance glance-${tone}`;
  return target && detail
    ? <button type="button" className={cls} title={title} onClick={() => detail.open(target.tab, target.section)}>{body}</button>
    : <div className={cls} title={title}>{body}</div>;
}
