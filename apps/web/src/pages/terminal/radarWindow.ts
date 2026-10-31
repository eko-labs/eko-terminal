import { useLayoutEffect, useState, type RefObject } from 'react';
export function visibleRange(count: number, tableTop: number, viewport: number, rowHeight: number) {
  if (count < 100) return { start: 0, end: count };
  const start = Math.min(Math.max(0, count - 1), Math.max(0, Math.floor((-tableTop + 68 - 38) / rowHeight) - 6));
  const end = Math.max(start + 1, Math.min(count, Math.ceil((viewport - tableTop - 38) / rowHeight) + 6));
  return { start, end };
}
/** Window the table against page scrolling; spacers preserve its natural page height. */
export function useRadarWindow(ref: RefObject<HTMLDivElement | null>, count: number, rowHeight: number) {
  const [range, setRange] = useState(() => visibleRange(count, 0, 1000, rowHeight));
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => { const top = ref.current?.getBoundingClientRect().top ?? 0, next = visibleRange(count, top, innerHeight, rowHeight); setRange((old) => old.start === next.start && old.end === next.end ? old : next); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    measure(); window.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
  }, [count, rowHeight, ref]);
  const reveal = (index: number) => { if (count >= 100) setRange({ start: Math.max(0, index - 6), end: Math.min(count, index + 7) }); };
  return { start: Math.min(range.start, count), end: Math.min(range.end, count), reveal };
}
