import { useLayoutEffect, useState, type RefObject } from 'react';

export function terminalRange(count: number, offset: number, viewport: number, height: number) {
  const start = Math.min(Math.max(0, count - 1), Math.max(0, Math.floor(offset / height) - 5));
  return { start, end: Math.min(count, Math.max(start + 1, Math.ceil((Math.max(0, offset) + viewport) / height) + 5)) };
}
/** Fixed row heights and inert spacers keep both column and page scrolling stable. */
export function useTerminalWindow(ref: RefObject<HTMLDivElement | null>, count: number, height: number, column = false) {
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 24) });
  useLayoutEffect(() => {
    const node = ref.current; if (!node) return;
    let frame = 0;
    const measure = () => {
      const local = column && getComputedStyle(node).overflowY === 'auto';
      const next = terminalRange(count, local ? node.scrollTop : -node.getBoundingClientRect().top + 68, local ? node.clientHeight : innerHeight, height);
      setRange((old) => old.start === next.start && old.end === next.end ? old : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    const resize = new ResizeObserver(schedule); resize.observe(node);
    measure(); node.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); resize.disconnect(); node.removeEventListener('scroll', schedule); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
  }, [ref, count, height, column]);
  return { start: Math.min(range.start, count), end: Math.min(range.end, count) };
}
