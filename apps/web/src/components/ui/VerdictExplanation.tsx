import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function VerdictExplanation({ className, description, children }: { className: string; description: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current!, note = popup.current!;
    const position = () => {
      const { left, top, bottom, width } = button.getBoundingClientRect();
      const x = Math.max(8, Math.min(left + (width - note.offsetWidth) / 2, window.innerWidth - note.offsetWidth - 8));
      const below = bottom + note.offsetHeight + 16 <= window.innerHeight;
      note.style.left = `${x}px`;
      note.style.top = `${Math.max(8, below ? bottom + 8 : top - note.offsetHeight - 8)}px`;
    };
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !button.contains(e.target) && !note.contains(e.target)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.focus();
    };

    position();
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    window.addEventListener('pointerdown', outside, true);
    // Close the explanation first when a Radar or Pairs inspector is also open.
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open, description]);

  return <>
    <button type="button" ref={trigger} className={`${className} verdict-explain`} title={description} aria-describedby={id} aria-controls={id} aria-expanded={open}
      onClick={e => { e.stopPropagation(); setOpen(wasOpen => !wasOpen); }}>{children}</button>
    {open ? createPortal(<span id={id} ref={popup} className="verdict-explanation" role="note" onClick={e => e.stopPropagation()}>{description}</span>, document.body)
      : <span id={id} className="verdict-description" hidden>{description}</span>}
  </>;
}
