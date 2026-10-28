// Small phosphor charts that size themselves to their container: a sparkline and dithered mini bars.
// Ported from the approved prototype (app/src/components/chart/AreaChart.jsx `Spark` and `MiniBars`).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { paintArea, paintBars, sweep } from '../../lib/phosphor';

/** Width of an element in CSS pixels, kept current with a ResizeObserver. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A sparkline: the phosphor trace with its dithered fill. Sweeps in once per data set. */
export function Spark({ series, height = 44, delay = 0, label }: { series: readonly number[]; height?: number; delay?: number; label?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const key = series.join(',');
  useEffect(() => {
    const el = canvas.current;
    if (!w || !el || series.length < 2) return;
    const lo = Math.min(...series), hi = Math.max(...series), n = series.length, T = 6, B = height - 3;
    const g = { W: w, H: height, L: 2, R: 6, T, B, mini: true, series, x: (i: number) => 2 + (i / (n - 1)) * (w - 8), y: (v: number) => B - ((v - lo) / (hi - lo || 1)) * (B - T) };
    return sweep((t) => paintArea(el, g, t), { dur: 800, delay });
  }, [w, height, key, delay]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} className="spark" style={{ position: 'relative', height }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <canvas ref={canvas} className="light" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} aria-hidden="true" />
    </div>
  );
}

/** Mini bar chart (no axes): dithered bars in blue, warm (refusals and blocks) or dim (paused). */
export function MiniBars({ series, height = 26, tone, delay = 0, label }: { series: readonly number[]; height?: number; tone?: 'warm' | 'dim'; delay?: number; label: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const key = series.join(',');
  useEffect(() => {
    const el = canvas.current;
    if (!w || !el || !series.length) return;
    const hi = Math.max(...series) || 1, T = 2, B = height - 1;
    const g = { W: w, H: height, L: 0, R: 0, T, B, lo: 0, series, tone, mini: true, y: (v: number) => B - (v / hi) * (B - T) };
    return sweep((t) => paintBars(el, g, t), { dur: 700, delay });
  }, [w, height, key, tone, delay]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} className="minibars" style={{ position: 'relative', height }} role="img" aria-label={label}>
      <canvas ref={canvas} className="light" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} aria-hidden="true" />
    </div>
  );
}
