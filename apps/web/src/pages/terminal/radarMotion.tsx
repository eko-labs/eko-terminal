import { useEffect, useRef, useState, type ReactNode } from 'react';
import { reducedMotion } from '../../lib/phosphor';

/** Reserve final text width; keep untrusted text in its own escaped component. */
export function Decode({ text, children, delay = 0 }: { text: string; children: ReactNode; delay?: number }) {
  const [tail, setTail] = useState<string | null>(null);
  useEffect(() => {
    if (reducedMotion()) return;
    let frame = 0, timer: ReturnType<typeof setTimeout>;
    const start = performance.now() + delay, pool = '░▒▓0123456789';
    const tick = () => { const t = (performance.now() - start) / 520; if (t >= 1) { setTail(null); return; } const n = Math.max(0, Math.floor(t * text.length)); setTail([...text].map((c, i) => i < n || c === '$' || c === ' ' ? c : pool[(i + frame++) % pool.length]).join('')); timer = setTimeout(tick, 34); };
    tick(); return () => clearTimeout(timer);
  }, [text, delay]);
  return <span className={`radar-decode${tail === null ? '' : ' decoding'}`}><span className="decode-size">{children}</span>{tail !== null && <span className="decode-live" aria-hidden="true">{tail}</span>}</span>;
}
export function Roll({ value }: { value: string }) {
  const previous = useRef(value), [old, setOld] = useState<string | null>(null);
  useEffect(() => { const prev = previous.current; previous.current = value; if (prev === value || reducedMotion()) return; setOld(prev); const timer = setTimeout(() => setOld(null), 360); return () => clearTimeout(timer); }, [value]);
  return <span className={`radar-roll${old === null ? '' : ' rolling'}`}><span className="roll-value">{value}</span>{old !== null && <span className="roll-old" aria-hidden="true">{old}</span>}</span>;
}
