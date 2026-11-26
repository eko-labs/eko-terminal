import { useLayoutEffect, useRef, useState } from 'react';
import type { Bar } from '@eko/shared';
import { ChartCore } from '../../components/chart/chartCore';
import type { CoinTimeframe } from '../../components/chart/coinMath';

/** The price over a span, in plain words, and the bar width that shows it. */
export const RANGES = { '1h': { label: 'Last hour', tf: '1m', sec: 3600 }, '24h': { label: 'Today', tf: '15m', sec: 86_400 }, all: { label: 'All', tf: '1h', sec: Infinity } } as const satisfies Record<string, { label: string; tf: CoinTimeframe; sec: number }>;
export type Range = keyof typeof RANGES;

/** The bars inside a range, counted back from the newest bar. */
export function barsIn(bars: readonly Bar[], range: Range): Bar[] {
  const last = bars.at(-1)?.ts;
  if (last === undefined || RANGES[range].sec === Infinity) return [...bars];
  const since = last - RANGES[range].sec;
  return bars.filter(b => b.ts > since);
}

/**
 * The coin page's own phosphor chart (components/chart/chartCore), in Line mode with no tools: the whole range fills the
 * plate, and a finger or the mouse shows the price at any point.
 */
export function SimpleChart({ bars, range, label }: { bars: Bar[]; range: Range; label: string }) {
  const plot = useRef<HTMLDivElement>(null), [core, setCore] = useState<ChartCore | null>(null), shown = useRef('');
  useLayoutEffect(() => {
    const c = new ChartCore(plot.current!);
    c.setMode('Line'); c.setOptions({ volume: false, log: false, ema: [] });
    setCore(c);
    return () => c.destroy();
  }, []);
  useLayoutEffect(() => {
    if (!core) return;
    const set = `${range}|${bars[0]?.ts ?? ''}`, fresh = shown.current !== set;
    core.setData(bars, RANGES[range].tf, !fresh);
    // The whole range on the plate, however narrow the screen.
    if (fresh) { core.view = { s: 0, e: Math.max(1, bars.length) }; core.scheduleRedraw(); if (bars.length) core.animate(); }
    if (bars.length) shown.current = set;
  }, [core, bars, range]);
  return <div className="coin-chart sv-chart" ref={plot} role="img" aria-label={label}
    onPointerMove={(e) => { if (!core) return; const box = e.currentTarget.getBoundingClientRect(); core.hoverAt(e.clientX - box.left, e.clientY - box.top); }}
    onPointerLeave={() => { if (core) { core.hoverIndex = -1; core.hoverY = -1; core.scheduleRedraw(); } }} />;
}
